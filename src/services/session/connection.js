/**
 * Disconnect / reconnect policy. State lives on the session (connection.<side>.{state,since,deadline}
 * and lastSeen.<side>), never in process memory, so a restart or another instance sees the same
 * truth.
 *
 *  - A participant is CONNECTED while at least one authenticated socket of theirs is connected.
 *  - When the last socket drops they become RECONNECTING with a deadline (grace, 60s for Chat,
 *    Audio and Video). The session itself stays ACTIVE, so a temporary network loss is survivable.
 *  - Billing (existing rules, now explicit and durable):
 *      astrologer absent -> those seconds are unbilled (accumulated exactly on resume)
 *      user absent       -> billed normally
 *      both absent       -> the overlap follows the astrologer rule (unbilled)
 *  - Returning within the deadline restores CONNECTED. Past the deadline the scheduler ends the
 *    session (USER_ / ASTROLOGER_ / BOTH_DISCONNECTED) at that deadline.
 *  - After a restart every ACTIVE session's participants who are not connected enter the same grace
 *    window; clients reconnect on their own and are resumed.
 */
const Session = require("../../models/session.model");
const { STATUS, ACTOR } = require("./states");
const rules = require("./rules");
const realtime = require("./realtime");

const sideOf = (role) => (role === ACTOR.USER ? "user" : "astrologer");
const idOf = (ref) => String(ref && ref._id ? ref._id : ref);
const ms = (d) => new Date(d).getTime();

const graceSeconds = (type) => rules.CONFIG.DISCONNECT_GRACE_SECONDS[type] || rules.CONFIG.DISCONNECT_GRACE_SECONDS.CHAT;

/**
 * Participant lost connectivity. `since` is when contact was lost (default now); `deadlineFrom`
 * is what the grace window counts from (default `since`; recovery counts from the restart).
 * Returns the updated session, or null when there was nothing to change.
 */
const markDisconnected = async ({ sessionId, role, since = null, deadlineFrom = null, now = new Date() }) => {
    const key = sideOf(role);
    const session = await Session.findById(sessionId).select("status type startedAt connection").lean();
    if (!session || session.status !== STATUS.ACTIVE) return null;
    if (session.connection && session.connection[key] && session.connection[key].state === "RECONNECTING") return null;

    let sinceDate = since ? new Date(since) : now;
    if (session.startedAt && sinceDate < new Date(session.startedAt)) sinceDate = new Date(session.startedAt);
    if (sinceDate > now) sinceDate = now;
    const from = deadlineFrom ? new Date(deadlineFrom) : sinceDate;
    const deadline = new Date(from.getTime() + graceSeconds(session.type) * 1000);

    return Session.findOneAndUpdate(
        { _id: sessionId, status: STATUS.ACTIVE, [`connection.${key}.state`]: { $ne: "RECONNECTING" } },
        {
            $set: {
                [`connection.${key}.state`]: "RECONNECTING",
                [`connection.${key}.since`]: sinceDate,
                [`connection.${key}.deadline`]: deadline
            }
        },
        { returnDocument: "after" }
    ).lean();
};

/**
 * Participant is back. Closes the absence interval: an astrologer's absence is added to the
 * unbilled seconds exactly (replacing the legacy hardcoded +15 and its double counting).
 */
const markConnected = async ({ sessionId, role, now = new Date() }) => {
    const key = sideOf(role);
    const session = await Session.findById(sessionId).lean();
    if (!session) return { session: null, resumed: false };

    const conn = session.connection && session.connection[key];
    if (session.status !== STATUS.ACTIVE || !conn || conn.state !== "RECONNECTING") {
        if (session.status === STATUS.ACTIVE || session.status === STATUS.CONNECTING) {
            await Session.updateOne({ _id: sessionId }, { $set: { [`lastSeen.${key}`]: now } });
        }
        return { session, resumed: false };
    }

    const from = Math.max(ms(conn.since), session.startedAt ? ms(session.startedAt) : 0);
    const absenceSeconds = Math.max(0, Math.floor((now.getTime() - from) / 1000));
    const update = { $set: { [`connection.${key}.state`]: "CONNECTED", [`connection.${key}.since`]: null, [`connection.${key}.deadline`]: null, [`lastSeen.${key}`]: now } };
    if (role === ACTOR.ASTROLOGER && absenceSeconds > 0) update.$inc = { "disconnectState.unbilledGraceSeconds": absenceSeconds };

    const resumed = await Session.findOneAndUpdate(
        { _id: sessionId, status: STATUS.ACTIVE, [`connection.${key}.state`]: "RECONNECTING", [`connection.${key}.since`]: conn.since },
        update,
        { returnDocument: "after" }
    ).lean();
    if (!resumed) return { session: await Session.findById(sessionId).lean(), resumed: false };
    return { session: resumed, resumed: true, absenceSeconds };
};

/** Heartbeat: cheap proof of life, used only when a server instance dies without telling anyone. */
const heartbeat = async ({ sessionId, role, now = new Date() }) => {
    await Session.updateOne(
        { _id: sessionId, status: { $in: [STATUS.ACTIVE, STATUS.CONNECTING] } },
        { $set: { [`lastSeen.${role === ACTOR.USER ? "user" : "astrologer"}`]: now } }
    );
};

// ---------------------------------------------------------------------------------------
// scheduler passes
// ---------------------------------------------------------------------------------------

/**
 * Safety net for a dead instance (no disconnect event was ever delivered): a participant with no
 * live socket and no sign of life for HEARTBEAT_STALE_SECONDS enters the grace window. A
 * participant who is still connected (e.g. a legacy client that never sends heartbeats) is just
 * re-verified and left alone.
 */
const detectDisconnects = async ({ io, now = new Date(), staleSeconds = rules.CONFIG.HEARTBEAT_STALE_SECONDS, announce = true }) => {
    const stale = new Date(now.getTime() - staleSeconds * 1000);
    const due = await Session.find({
        status: STATUS.ACTIVE,
        $or: [
            { "connection.user.state": { $ne: "RECONNECTING" }, $or: [{ "lastSeen.user": null }, { "lastSeen.user": { $lte: stale } }] },
            { "connection.astrologer.state": { $ne: "RECONNECTING" }, $or: [{ "lastSeen.astrologer": null }, { "lastSeen.astrologer": { $lte: stale } }] }
        ]
    }).limit(200).lean();

    let marked = 0;
    for (const s of due) {
        for (const role of [ACTOR.USER, ACTOR.ASTROLOGER]) {
            const key = sideOf(role);
            const conn = (s.connection && s.connection[key]) || {};
            const seen = s.lastSeen && s.lastSeen[key];
            if (conn.state === "RECONNECTING") continue;
            if (seen && ms(seen) > stale.getTime()) continue;

            const participantId = idOf(role === ACTOR.USER ? s.user : s.astrologer);
            if (await realtime.isParticipantConnected(io, role, participantId)) {
                await Session.updateOne({ _id: s._id }, { $set: { [`lastSeen.${key}`]: now } }); // verified alive
                continue;
            }
            const updated = await markDisconnected({ sessionId: s._id, role, since: seen || now, now });
            if (updated) {
                marked += 1;
                if (announce) realtime.emitPeerState(io, updated, role, "RECONNECTING");
            }
        }
    }
    return marked;
};

const GRACE_MESSAGES = {
    USER_DISCONNECTED: "Consultation ended: User disconnected.",
    ASTROLOGER_DISCONNECTED: "Consultation ended: Astrologer disconnected.",
    BOTH_DISCONNECTED: "Consultation ended: both participants disconnected."
};

/** Sessions whose grace window ran out. Returns [{ sessionId, reason, endAt, message }]. */
const findExpiredGrace = async ({ now = new Date(), limit = 100 } = {}) => {
    const due = await Session.find({
        status: STATUS.ACTIVE,
        $or: [
            { "connection.user.state": "RECONNECTING", "connection.user.deadline": { $lte: now } },
            { "connection.astrologer.state": "RECONNECTING", "connection.astrologer.deadline": { $lte: now } }
        ]
    }).limit(limit).lean();

    return due.map((s) => {
        const u = s.connection.user;
        const a = s.connection.astrologer;
        const userGone = u.state === "RECONNECTING";
        const astroGone = a.state === "RECONNECTING";
        const expired = [];
        if (userGone && u.deadline && ms(u.deadline) <= now.getTime()) expired.push(ms(u.deadline));
        if (astroGone && a.deadline && ms(a.deadline) <= now.getTime()) expired.push(ms(a.deadline));
        const reason = userGone && astroGone ? "BOTH_DISCONNECTED" : astroGone ? "ASTROLOGER_DISCONNECTED" : "USER_DISCONNECTED";
        return { sessionId: s._id, reason, endAt: new Date(Math.min(...expired)), message: GRACE_MESSAGES[reason] };
    });
};

/**
 * Startup recovery: in-memory state is gone, but sessions are not. Every ACTIVE session's
 * participants who are not connected enter the grace window (counted from now) with their
 * absence dated from their last contact; clients that reconnect are resumed automatically.
 */
const recoverOnStart = async ({ io, now = new Date() }) => {
    const active = await Session.find({ status: STATUS.ACTIVE }).lean();
    let marked = 0;
    for (const s of active) {
        for (const role of [ACTOR.USER, ACTOR.ASTROLOGER]) {
            const key = sideOf(role);
            if (s.connection && s.connection[key] && s.connection[key].state === "RECONNECTING") continue;
            const participantId = idOf(role === ACTOR.USER ? s.user : s.astrologer);
            if (await realtime.isParticipantConnected(io, role, participantId)) continue; // still reachable through another instance
            const since = (s.lastSeen && s.lastSeen[key]) || s.startedAt || now;
            const updated = await markDisconnected({ sessionId: s._id, role, since, deadlineFrom: now, now });
            if (updated) marked += 1;
        }
    }
    return marked;
};

module.exports = {
    markDisconnected,
    markConnected,
    heartbeat,
    detectDisconnects,
    findExpiredGrace,
    recoverOnStart,
    graceSeconds
};
