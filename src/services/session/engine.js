/**
 * Session Engine: the single lifecycle for Chat, Audio and Video.
 *
 * Source of truth is MongoDB (Session). Every transition is one atomic, status-guarded
 * findOneAndUpdate, so duplicate or racing operations (double accept, accept vs cancel, two
 * Ends...) resolve to exactly one winner no matter which instance handles them. There are no
 * per-session timers: all deadlines are stored timestamps that the scheduler (scheduler.js)
 * evaluates.
 *
 * Transport (Socket.IO signalling, Agora media) is NOT this module's concern: functions here
 * only change state and return the resulting session; realtime.js turns results into events.
 */
const mongoose = require("mongoose");
const Session = require("../../models/session.model");
const User = require("../../models/user.model");
const { getParticipantRole } = require("../../middlewares/sessionAuth.middleware");
const { STATUS, ACTOR } = require("./states");
const { SessionError } = require("./errors");
const rules = require("./rules");
const { findUserByIdOrRef, findAstrologerByIdOrRef } = require("./lookup");
const availability = require("./availability");
const { scheduleMirror } = require("./legacyMirror");
const { runInBackground } = require("./background");
const { settleSession } = require("./settlement");

const toDate = (v) => (v ? new Date(v) : new Date());
const addSeconds = (date, seconds) => new Date(date.getTime() + seconds * 1000);
const idOf = (ref) => String(ref && ref._id ? ref._id : ref);

const generateRoomId = (prefix) => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

/**
 * Which side of the session is this actor?
 *   actor = { system: true }        -> SYSTEM (scheduler / recovery)
 *   actor = { user: <decoded JWT> } -> USER | ASTROLOGER (participant) | ADMIN | null (stranger)
 */
const roleOf = async (session, actor) => {
    if (actor && actor.system) return ACTOR.SYSTEM;
    const role = await getParticipantRole(session, actor && actor.user);
    if (role === "user") return ACTOR.USER;
    if (role === "astrologer") return ACTOR.ASTROLOGER;
    if (role === "admin") return "ADMIN";
    return null;
};

const requireParticipant = async (session, actor) => {
    const role = await roleOf(session, actor);
    if (!role) throw new SessionError("FORBIDDEN", "You are not a participant of this session.", 403);
    return role;
};

const loadSession = async (sessionId) => {
    if (!sessionId || !mongoose.Types.ObjectId.isValid(String(sessionId))) {
        throw new SessionError("SESSION_NOT_FOUND", "Session not found", 404);
    }
    const session = await Session.findById(sessionId).lean();
    if (!session) throw new SessionError("SESSION_NOT_FOUND", "Session not found", 404);
    return session;
};

const mapDuplicateKey = (err) => {
    if (!err || err.code !== 11000) return err;
    const keys = Object.keys(err.keyPattern || {});
    const text = `${err.message || ""}`;
    if (keys.includes("astrologer") || /per_astrologer/.test(text)) {
        return new SessionError("ASTROLOGER_BUSY", "Astrologer is busy with another consultation.", 409);
    }
    if (keys.includes("user") || /per_user/.test(text)) {
        return new SessionError("USER_HAS_LIVE_SESSION", "You already have an active or pending consultation.", 409);
    }
    return err;
};

/** How many seconds of this session the user's bonus balance pays for (bonus is spent first). */
const promoCoverFor = (user, balance, perMinuteRate) => {
    const bonus = Math.min(Number((user && user.bonusBalance) || 0), balance);
    const ratePerSec = Number(perMinuteRate) / 60;
    return bonus > 0 && ratePerSec > 0 ? Math.floor(bonus / ratePerSec) : 0;
};

/** Balance snapshot -> the moment the wallet can no longer pay (existing max-duration rule). */
const billingStartFields = async (session, startedAt) => {
    const user = await User.findById(session.user).select("walletBalance bonusBalance").lean();
    const balance = Number((user && user.walletBalance) || 0);
    const maxSeconds = rules.maxBillableSeconds(balance, session.perMinuteRate);
    const promoCoverSeconds = promoCoverFor(user, balance, session.perMinuteRate);
    return {
        promoCoverSeconds,
        status: STATUS.ACTIVE,
        startedAt,
        startTime: startedAt,
        originalStartedAt: startedAt,
        balanceAtStart: balance,
        maxEndAt: addSeconds(startedAt, maxSeconds),
        lastTickAt: null,
        "lastSeen.user": startedAt,
        "lastSeen.astrologer": startedAt
    };
};

// ----------------------------------------------------------------------------------------
// 1. REQUEST
// ----------------------------------------------------------------------------------------

/**
 * User asks an astrologer for Chat / Audio / Video.
 * One live session per astrologer and per user is enforced by partial unique indexes: the
 * "is this astrologer free" check and the claim are the same atomic insert.
 */
const requestSession = async ({ userId, astrologerId, type, protocol = 1, now: nowOpt } = {}) => {
    const now = toDate(nowOpt);
    const sessionType = rules.normalizeType(type);

    const [user, astrologer] = await Promise.all([findUserByIdOrRef(userId), findAstrologerByIdOrRef(astrologerId)]);
    if (!user) throw new SessionError("USER_NOT_FOUND", `User not found for ID: ${userId}`, 404);
    if (!astrologer) throw new SessionError("ASTROLOGER_NOT_FOUND", `Astrologer not found for ID: ${astrologerId}`, 404);

    if (astrologer.status !== "approved") {
        throw new SessionError("ASTROLOGER_NOT_APPROVED", "Astrologer is not approved to accept consultations.", 403);
    }
    if (!astrologer.isOnline) {
        throw new SessionError("ASTROLOGER_OFFLINE", "Astrologer is currently offline.", 400);
    }
    // "Busy" is not read from the isAvailable display flag: it is the live-session lock, claimed
    // atomically by the insert below (partial unique index), so two simultaneous requests cannot both win.

    const rate = rules.resolveRate(astrologer, sessionType);
    const minRequired = rules.minimumStartBalance(rate);
    const balance = Number(user.walletBalance || 0);
    if (balance < minRequired) {
        const message = sessionType === "CHAT"
            ? `Insufficient wallet balance. Minimum ₹${minRequired} (2 mins) required to initiate chat. Current Balance: ₹${balance}`
            : `Insufficient wallet balance. Minimum ₹${minRequired} required to start. Current Balance: ₹${balance}`;
        throw new SessionError("INSUFFICIENT_BALANCE", message, 400, { required: minRequired, balance });
    }

    // A repeat tap on the same request returns the pending one instead of failing or duplicating
    const sameRequest = await Session.findOne({
        user: user._id,
        astrologer: astrologer._id,
        type: sessionType,
        status: STATUS.PENDING,
        expiresAt: { $gt: now }
    }).lean();
    if (sameRequest) {
        return { session: sameRequest, user, astrologer, superseded: [], idempotent: true };
    }

    // The user's own earlier PENDING requests are superseded (never an ACTIVE session)
    const superseded = [];
    const stale = await Session.find({ user: user._id, status: STATUS.PENDING }).select("_id astrologer").lean();
    for (const old of stale) {
        const cancelled = await Session.findOneAndUpdate(
            { _id: old._id, status: STATUS.PENDING },
            {
                $set: {
                    status: STATUS.CANCELLED,
                    liveLock: false,
                    endedAt: now,
                    endTime: now,
                    endedBy: ACTOR.USER,
                    endReason: "SUPERSEDED_BY_NEW_REQUEST",
                    rejectionReason: "Superceded by new request"
                }
            },
            { returnDocument: "after" }
        ).lean();
        if (cancelled) {
            superseded.push(cancelled);
            scheduleMirror(cancelled);
            runInBackground(availability.markFree(cancelled.astrologer), "availability");
        }
    }

    const isCall = sessionType !== "CHAT";
    const roomId = isCall ? generateRoomId(sessionType.toLowerCase()) : null;

    let created;
    try {
        created = await Session.create({
            type: sessionType,
            callType: sessionType,
            user: user._id,
            astrologer: astrologer._id,
            status: STATUS.PENDING,
            liveLock: true,
            perMinuteRate: rate,
            provider: isCall ? "Agora" : "None",
            roomId,
            channelName: roomId,
            protocol: { user: protocol, astrologer: 1 },
            requestedAt: now,
            expiresAt: addSeconds(now, rules.CONFIG.REQUEST_TIMEOUT_SECONDS)
        });
    } catch (err) {
        throw mapDuplicateKey(err);
    }
    const session = created.toObject();

    runInBackground(availability.markBusy(astrologer._id), "availability");
    scheduleMirror(session);
    return { session, user, astrologer, superseded, idempotent: false };
};

// ----------------------------------------------------------------------------------------
// 2. ACCEPT  (chat: -> ACTIVE at the atomic accept time;  audio/video: -> CONNECTING)
// ----------------------------------------------------------------------------------------

/**
 * Astrologer accepts. `isUserConnected` is injected by the realtime layer
 * (async (userId) => boolean); when omitted the connectivity check is skipped.
 */
const acceptSession = async ({ sessionId, actor, protocol = 1, isUserConnected = null, now: nowOpt } = {}) => {
    const now = toDate(nowOpt);
    let session = await loadSession(sessionId);

    const role = await requireParticipant(session, actor);
    if (role !== ACTOR.ASTROLOGER) {
        throw new SessionError("FORBIDDEN", "Only the requested astrologer can accept this session.", 403);
    }

    // Duplicate accept: already accepted by this astrologer -> same answer, no new transition
    if (session.status === STATUS.ACTIVE || session.status === STATUS.CONNECTING) {
        return { session, started: session.status === STATUS.ACTIVE, idempotent: true };
    }
    if (session.status !== STATUS.PENDING) {
        throw new SessionError("INVALID_STATE", `Session is currently '${session.status}', cannot accept.`, 409, { status: session.status });
    }

    // Past its deadline: the accept loses to expiry even if the scheduler has not run yet
    if (session.expiresAt && session.expiresAt <= now) {
        const missed = await expireOne(session._id, now);
        throw new SessionError("REQUEST_EXPIRED", "This request has expired.", 410, { session: missed });
    }

    // The user must still be connected (they may have left while the request was ringing)
    if (isUserConnected && !(await isUserConnected(idOf(session.user)))) {
        const cancelled = await closePending(session._id, STATUS.CANCELLED, { reason: "USER_UNAVAILABLE", actor: ACTOR.SYSTEM, now });
        throw new SessionError("USER_UNAVAILABLE", "The user is no longer connected.", 409, { session: cancelled });
    }

    // Re-verify the wallet at accept time (it may have dropped since the request)
    const user = await User.findById(session.user).select("walletBalance").lean();
    const balance = Number((user && user.walletBalance) || 0);
    const minRequired = rules.minimumStartBalance(session.perMinuteRate);
    if (balance < minRequired) {
        const cancelled = await closePending(session._id, STATUS.CANCELLED, { reason: "INSUFFICIENT_BALANCE", actor: ACTOR.SYSTEM, now });
        throw new SessionError(
            "INSUFFICIENT_BALANCE",
            `Insufficient wallet balance. Minimum ₹${minRequired} required to start. Current Balance: ₹${balance}`,
            400,
            { required: minRequired, balance, session: cancelled }
        );
    }

    const userProto = (session.protocol && session.protocol.user) || 1;
    const direct = session.type === "CHAT" || (userProto < 2 && protocol < 2);

    const guard = { _id: session._id, status: STATUS.PENDING, astrologer: session.astrologer, expiresAt: { $gt: now } };
    let update;
    if (direct) {
        update = { $set: { ...(await billingStartFields(session, now)), acceptedAt: now, "protocol.astrologer": protocol } };
    } else {
        // audio/video: billing waits until BOTH participants have joined the media channel.
        // A participant whose client predates media_ready is treated as ready at accept.
        update = {
            $set: {
                status: STATUS.CONNECTING,
                acceptedAt: now,
                connectDeadline: addSeconds(now, rules.CONFIG.CONNECT_TIMEOUT_SECONDS),
                "protocol.astrologer": protocol,
                "mediaReady.user": userProto < 2 ? now : null,
                "mediaReady.astrologer": protocol < 2 ? now : null,
                "lastSeen.user": now,
                "lastSeen.astrologer": now
            }
        };
    }

    const accepted = await Session.findOneAndUpdate(guard, update, { returnDocument: "after" }).lean();
    if (!accepted) {
        // lost a race: report what actually happened
        session = await loadSession(sessionId);
        if (session.status === STATUS.ACTIVE || session.status === STATUS.CONNECTING) {
            return { session, started: session.status === STATUS.ACTIVE, idempotent: true };
        }
        throw new SessionError("INVALID_STATE", `Session is currently '${session.status}', cannot accept.`, 409, { status: session.status });
    }

    runInBackground(availability.markBusy(accepted.astrologer, { presence: true, sessionId: accepted._id }), "availability");
    scheduleMirror(accepted);
    return { session: accepted, started: accepted.status === STATUS.ACTIVE, idempotent: false };
};

// ----------------------------------------------------------------------------------------
// 3. MEDIA READY  (audio/video: second participant ready => ACTIVE, startedAt = that moment)
// ----------------------------------------------------------------------------------------

const markMediaReady = async ({ sessionId, actor, now: nowOpt } = {}) => {
    const now = toDate(nowOpt);
    const session = await loadSession(sessionId);

    const role = await requireParticipant(session, actor);
    if (role !== ACTOR.USER && role !== ACTOR.ASTROLOGER) {
        throw new SessionError("FORBIDDEN", "Only a participant can report media readiness.", 403);
    }

    if (session.status === STATUS.ACTIVE || session.status === STATUS.ENDING || session.status === STATUS.COMPLETED) {
        return { session, started: false, alreadyStarted: true };
    }
    if (session.status !== STATUS.CONNECTING) {
        throw new SessionError("INVALID_STATE", `Session is currently '${session.status}', not connecting.`, 409, { status: session.status });
    }

    if (session.connectDeadline && session.connectDeadline <= now) {
        const failed = await failConnecting(session._id, now);
        throw new SessionError("MEDIA_CONNECT_FAILED", "Could not establish the call in time.", 408, { session: failed });
    }

    const path = `mediaReady.${role.toLowerCase()}`;
    await Session.updateOne({ _id: session._id, status: STATUS.CONNECTING, [path]: null }, { $set: { [path]: now } });

    // Whoever observes both flags set first wins the transition; startedAt is that server moment.
    const startFields = await billingStartFields(session, now);
    const started = await Session.findOneAndUpdate(
        {
            _id: session._id,
            status: STATUS.CONNECTING,
            "mediaReady.user": { $ne: null },
            "mediaReady.astrologer": { $ne: null }
        },
        { $set: startFields },
        { returnDocument: "after" }
    ).lean();

    if (started) {
        scheduleMirror(started);
        return { session: started, started: true };
    }
    return { session: await Session.findById(session._id).lean(), started: false };
};

/** CONNECTING -> CANCELLED with zero charge (deadline passed, or someone ended before connecting). */
const failConnecting = async (sessionId, now, { reason = "MEDIA_CONNECT_FAILED", actorLabel = ACTOR.SYSTEM } = {}) => {
    const failed = await Session.findOneAndUpdate(
        { _id: sessionId, status: STATUS.CONNECTING },
        {
            $set: {
                status: STATUS.CANCELLED,
                liveLock: false,
                endedAt: now,
                endTime: now,
                endedBy: actorLabel,
                endReason: reason,
                rejectionReason: reason
            }
        },
        { returnDocument: "after" }
    ).lean();
    if (failed) {
        scheduleMirror(failed);
        runInBackground(availability.markFree(failed.astrologer), "availability");
    }
    return failed;
};

// ----------------------------------------------------------------------------------------
// 4. REJECT / CANCEL / EXPIRE
// ----------------------------------------------------------------------------------------

/** PENDING -> REJECTED | CANCELLED | MISSED, releasing the lock. Returns null if it lost the race. */
const closePending = async (sessionId, status, { reason, actor, now }) => {
    const closed = await Session.findOneAndUpdate(
        { _id: sessionId, status: STATUS.PENDING },
        {
            $set: {
                status,
                liveLock: false,
                endedAt: now,
                endTime: now,
                endedBy: actor,
                endReason: reason,
                rejectionReason: reason
            }
        },
        { returnDocument: "after" }
    ).lean();
    if (closed) {
        scheduleMirror(closed);
        runInBackground(availability.markFree(closed.astrologer), "availability");
    }
    return closed;
};

const expireOne = (sessionId, now) =>
    closePending(sessionId, STATUS.MISSED, { reason: "REQUEST_TIMED_OUT", actor: ACTOR.SYSTEM, now });

const rejectSession = async ({ sessionId, actor, reason = "Astrologer unavailable", now: nowOpt } = {}) => {
    const now = toDate(nowOpt);
    const session = await loadSession(sessionId);
    const role = await requireParticipant(session, actor);
    if (role !== ACTOR.ASTROLOGER && role !== "ADMIN") {
        throw new SessionError("FORBIDDEN", "Only the requested astrologer can reject this session.", 403);
    }

    if (session.status === STATUS.REJECTED) return { session, idempotent: true };
    if (session.status !== STATUS.PENDING) {
        throw new SessionError("INVALID_STATE", `Session is currently '${session.status}', cannot reject.`, 409, { status: session.status });
    }

    const closed = await closePending(session._id, STATUS.REJECTED, { reason, actor: ACTOR.ASTROLOGER, now });
    if (closed) return { session: closed, idempotent: false };
    const latest = await loadSession(sessionId);
    if (latest.status === STATUS.REJECTED) return { session: latest, idempotent: true };
    throw new SessionError("INVALID_STATE", `Session is currently '${latest.status}', cannot reject.`, 409, { status: latest.status });
};

/**
 * User cancels a PENDING request; either side can cancel while CONNECTING (no charge).
 * Cancelling an ACTIVE session is not cancellation (End is); it is reported as ignored.
 */
const cancelSession = async ({ sessionId, actor, reason = "USER_CANCELLED", now: nowOpt } = {}) => {
    const now = toDate(nowOpt);
    const session = await loadSession(sessionId);
    const role = await requireParticipant(session, actor);

    if (session.status === STATUS.CANCELLED) return { session, idempotent: true };
    if (session.status === STATUS.ACTIVE || session.status === STATUS.ENDING || session.status === STATUS.COMPLETED) {
        return { session, ignored: true };
    }
    if (session.status === STATUS.REJECTED || session.status === STATUS.MISSED) return { session, ignored: true };

    if (session.status === STATUS.PENDING) {
        if (role !== ACTOR.USER && role !== "ADMIN") {
            throw new SessionError("FORBIDDEN", "Only the requesting user can cancel a pending request.", 403);
        }
        const closed = await closePending(session._id, STATUS.CANCELLED, { reason, actor: ACTOR.USER, now });
        if (closed) return { session: closed, idempotent: false };
        // lost the race: either someone already cancelled it, or it was accepted first
        const latest = await loadSession(sessionId);
        return latest.status === STATUS.CANCELLED ? { session: latest, idempotent: true } : { session: latest, ignored: true };
    }

    // CONNECTING
    const failed = await failConnecting(session._id, now, {
        reason: role === ACTOR.ASTROLOGER ? "ASTROLOGER_CANCELLED_BEFORE_CONNECT" : "USER_CANCELLED_BEFORE_CONNECT",
        actorLabel: role === ACTOR.ASTROLOGER ? ACTOR.ASTROLOGER : ACTOR.USER
    });
    if (failed) return { session: failed, idempotent: false };
    const latest = await loadSession(sessionId);
    return latest.status === STATUS.CANCELLED ? { session: latest, idempotent: true } : { session: latest, ignored: true };
};

/** Scheduler: PENDING requests past their deadline become MISSED. */
const expirePending = async ({ now: nowOpt, limit = 100 } = {}) => {
    const now = toDate(nowOpt);
    const due = await Session.find({ status: STATUS.PENDING, expiresAt: { $lte: now } }).select("_id").limit(limit).lean();
    const expired = [];
    for (const d of due) {
        const s = await expireOne(d._id, now);
        if (s) expired.push(s);
    }
    return expired;
};

/** Scheduler: CONNECTING sessions whose media deadline passed are cancelled, uncharged. */
const expireConnecting = async ({ now: nowOpt, limit = 100 } = {}) => {
    const now = toDate(nowOpt);
    const due = await Session.find({ status: STATUS.CONNECTING, connectDeadline: { $lte: now } }).select("_id").limit(limit).lean();
    const failed = [];
    for (const d of due) {
        const s = await failConnecting(d._id, now);
        if (s) failed.push(s);
    }
    return failed;
};

// ----------------------------------------------------------------------------------------
// 5. END  (ACTIVE -> ENDING -> settlement -> COMPLETED)
// ----------------------------------------------------------------------------------------

/**
 * Either participant (or the system) ends the session. Only one caller performs the
 * ACTIVE -> ENDING transition and the settlement; everyone else gets the same session back.
 * `endAt` lets the scheduler end a session at the moment it became due (e.g. maxEndAt) even
 * when it runs late; the end is never later than maxEndAt.
 */
const endSession = async ({ sessionId, actor, reason = "Consultation completed", endAt = null, now: nowOpt, _retried = false } = {}) => {
    const now = toDate(nowOpt);
    const session = await loadSession(sessionId);
    const role = await requireParticipant(session, actor);

    const endedBy = role === ACTOR.USER || role === ACTOR.ASTROLOGER ? role : ACTOR.SYSTEM;

    // PENDING / CONNECTING never started billing: ending them is a cancellation
    if (session.status === STATUS.PENDING) {
        const closed = await closePending(session._id, STATUS.CANCELLED, { reason, actor: endedBy, now });
        if (closed) return { session: closed, settled: false, idempotent: false };
        // accepted while this End was in flight: the intent is still "stop", so end what exists now
        if (!_retried) return endSession({ sessionId, actor, reason, endAt, now: nowOpt, _retried: true });
        return { session: await loadSession(sessionId), settled: false, idempotent: true };
    }
    if (session.status === STATUS.CONNECTING) {
        const failed = await failConnecting(session._id, now, { reason: "ENDED_BEFORE_CONNECT", actorLabel: endedBy });
        if (failed) return { session: failed, settled: false, idempotent: false };
        // both participants became ready while this End was in flight
        if (!_retried) return endSession({ sessionId, actor, reason, endAt, now: nowOpt, _retried: true });
        return { session: await loadSession(sessionId), settled: false, idempotent: true };
    }

    // Already ended: same answer for the second caller
    if (session.status === STATUS.COMPLETED || session.status === STATUS.ENDING) {
        const current = session.status === STATUS.ENDING ? await trySettle(session._id, now) : session;
        return { session: current, settled: current.status === STATUS.COMPLETED, idempotent: true };
    }
    if (session.status !== STATUS.ACTIVE) {
        return { session, settled: false, idempotent: true }; // REJECTED / CANCELLED / MISSED
    }

    let endedAt = endAt ? new Date(endAt) : now;
    if (session.maxEndAt && endedAt > session.maxEndAt) endedAt = session.maxEndAt; // never bill past what the wallet could pay
    const startedAt = session.startedAt || session.startTime;
    if (startedAt && endedAt < startedAt) endedAt = new Date(startedAt);

    const ending = await Session.findOneAndUpdate(
        { _id: session._id, status: STATUS.ACTIVE },
        {
            $set: {
                status: STATUS.ENDING,
                endedAt,
                endTime: endedAt,
                endedBy,
                endReason: reason,
                "settlement.state": "IN_PROGRESS"
            }
        },
        { returnDocument: "after" }
    ).lean();

    if (!ending) {
        // someone else won the transition
        const current = await loadSession(sessionId);
        const settled = current.status === STATUS.ENDING ? await trySettle(current._id, now) : current;
        return { session: settled, settled: settled.status === STATUS.COMPLETED, idempotent: true };
    }

    const settled = await trySettle(ending._id, now);
    return { session: settled, settled: settled.status === STATUS.COMPLETED, idempotent: false };
};

// ----------------------------------------------------------------------------------------
// 6. RECHARGE PAUSE / RESUME  (existing rule: billing pauses while the user recharges; 2 min limit)
// ----------------------------------------------------------------------------------------

/** The user is recharging: billing pauses. The 2 minute limit is a stored deadline the scheduler enforces. */
const pauseBilling = async ({ sessionId, actor, now: nowOpt } = {}) => {
    const now = toDate(nowOpt);
    const session = await loadSession(sessionId);
    const role = await requireParticipant(session, actor);
    if (role !== ACTOR.USER && role !== "ADMIN") {
        throw new SessionError("FORBIDDEN", "Only the user can pause billing for a recharge.", 403);
    }
    if (session.status !== STATUS.ACTIVE) return { session, ignored: true };
    if (session.billingPausedAt) return { session, idempotent: true };

    const paused = await Session.findOneAndUpdate(
        { _id: session._id, status: STATUS.ACTIVE, billingPausedAt: null },
        { $set: { billingPausedAt: now, pauseDeadline: addSeconds(now, rules.CONFIG.PAUSE_LIMIT_SECONDS) } },
        { returnDocument: "after" }
    ).lean();
    return paused ? { session: paused, idempotent: false } : { session: await loadSession(sessionId), idempotent: true };
};

/**
 * Billing resumes after the recharge. As before, startedAt moves forward by the paused time (the
 * paused time is not billed) and the wallet's limit is recomputed from the fresh balance.
 * originalStartedAt keeps the true start for history.
 */
const resumeBilling = async ({ sessionId, actor, now: nowOpt } = {}) => {
    const now = toDate(nowOpt);
    const session = await loadSession(sessionId);
    const role = await requireParticipant(session, actor);
    if (role !== ACTOR.USER && role !== "ADMIN") {
        throw new SessionError("FORBIDDEN", "Only the user can resume billing.", 403);
    }
    if (session.status !== STATUS.ACTIVE || !session.billingPausedAt) return { session, idempotent: true };

    const pausedMs = Math.max(0, now.getTime() - new Date(session.billingPausedAt).getTime());
    const newStart = new Date(new Date(session.startedAt).getTime() + pausedMs);
    const user = await User.findById(session.user).select("walletBalance bonusBalance").lean();
    const balance = Number((user && user.walletBalance) || 0);

    const resumed = await Session.findOneAndUpdate(
        { _id: session._id, status: STATUS.ACTIVE, billingPausedAt: session.billingPausedAt },
        {
            $set: {
                startedAt: newStart,
                startTime: newStart,
                balanceAtStart: balance,
                promoCoverSeconds: promoCoverFor(user, balance, session.perMinuteRate),
                maxEndAt: addSeconds(newStart, rules.maxBillableSeconds(balance, session.perMinuteRate)),
                billingPausedAt: null,
                pauseDeadline: null,
                lastTickAt: null
            }
        },
        { returnDocument: "after" }
    ).lean();
    return resumed ? { session: resumed, idempotent: false } : { session: await loadSession(sessionId), idempotent: true };
};

// ----------------------------------------------------------------------------------------
// 7. RECOVERY
// ----------------------------------------------------------------------------------------

/**
 * "Do I have an active session?" for the authenticated caller. Returns { session, role } for the
 * live session (PENDING / CONNECTING / ACTIVE / ENDING), else for the latest finished session whose
 * result this participant has not acknowledged yet (so an end event missed while offline is
 * delivered now), else null.
 */
const RECENT_RESULT_MINUTES = 15;
const findActiveFor = async (decoded, { now: nowOpt } = {}) => {
    const now = toDate(nowOpt);
    if (!decoded || !(decoded.userId || decoded.id)) return null;
    const callerId = String(decoded.userId || decoded.id || decoded._id);

    let key = null;
    let role = null;
    let ownerId = callerId;
    if (decoded.role === "astrologer") {
        const Astrologer = require("../../models/astro.model");
        const astro = mongoose.Types.ObjectId.isValid(callerId)
            ? await Astrologer.findOne({ $or: [{ _id: callerId }, { astrologerLogin: callerId }] }).select("_id").lean()
            : null;
        if (!astro) return null;
        ownerId = astro._id;
        key = "astrologer";
        role = ACTOR.ASTROLOGER;
    } else if (decoded.role === "admin" || decoded.role === "superadmin") {
        return null;
    } else {
        key = "user";
        role = ACTOR.USER;
    }

    const live = await Session.findOne({ [key]: ownerId, liveLock: true }).lean();
    if (live) return { session: live, role };

    const since = new Date(now.getTime() - RECENT_RESULT_MINUTES * 60000);
    const recent = await Session.findOne({
        [key]: ownerId,
        status: STATUS.COMPLETED,
        endedAt: { $gte: since },
        [`finalAck.${key}`]: null
    }).sort({ endedAt: -1 }).lean();
    return recent ? { session: recent, role } : null;
};

/** The participant has seen the final result; stop returning it from recovery. */
const ackFinal = async ({ sessionId, actor, now: nowOpt } = {}) => {
    const now = toDate(nowOpt);
    const session = await loadSession(sessionId);
    const role = await requireParticipant(session, actor);
    if (role !== ACTOR.USER && role !== ACTOR.ASTROLOGER) return { session };
    const key = role === ACTOR.USER ? "user" : "astrologer";
    await Session.updateOne({ _id: session._id, [`finalAck.${key}`]: null }, { $set: { [`finalAck.${key}`]: now } });
    return { session };
};

/** Settlement failures leave the session ENDING; the recovery loop retries them. */
const trySettle = async (sessionId, now) => {
    try {
        return await settleSession(sessionId, { now });
    } catch (err) {
        console.error(`Settlement error for session ${sessionId} (will be retried):`, err.message);
        return Session.findById(sessionId).lean();
    }
};

module.exports = {
    requestSession,
    acceptSession,
    markMediaReady,
    rejectSession,
    cancelSession,
    endSession,
    pauseBilling,
    resumeBilling,
    findActiveFor,
    ackFinal,
    expirePending,
    expireConnecting,
    settleSession: trySettle,
    // exposed for the scheduler / realtime layer
    roleOf,
    requireParticipant,
    loadSession,
    failConnecting,
    closePending
};
