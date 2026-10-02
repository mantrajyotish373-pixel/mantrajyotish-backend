/**
 * Application layer used by BOTH the REST controllers and the socket handlers, so every entry
 * point behaves identically: call the engine, emit the resulting events, return the result.
 * Identity always comes from the verified token (`decoded`), never from the payload.
 */
const User = require("../../models/user.model");
const Session = require("../../models/session.model");
const Astrologer = require("../../models/astro.model");
const engine = require("./engine");
const realtime = require("./realtime");
const { SessionError } = require("./errors");
const { runInBackground } = require("./background");
const connection = require("./connection");
const { ACTOR } = require("./states");

const getIo = () => {
    try {
        return require("../../config/socket").getIO();
    } catch (_) {
        return null; // realtime not initialised (unit tests)
    }
};

const actorOf = (decoded) => ({ user: decoded });

// ---------------------------------------------------------------------------------------
// user details shown to the astrologer on an incoming request (ported from the legacy
// controllers; missing profile fields are also saved on the user, as before)
// ---------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parseFlexibleDate = (dateVal) => {
    if (!dateVal) return null;
    if (dateVal instanceof Date) return isNaN(dateVal.getTime()) ? null : dateVal;
    if (typeof dateVal === "string") {
        const clean = dateVal.trim();
        const dmy = clean.match(/^(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})\s*[\/\-\.]\s*(\d{4})$/);
        if (dmy) {
            const d = new Date(Date.UTC(parseInt(dmy[3], 10), parseInt(dmy[2], 10) - 1, parseInt(dmy[1], 10)));
            return isNaN(d.getTime()) ? null : d;
        }
        const ymd = clean.match(/^(\d{4})\s*[\/\-\.]\s*(\d{1,2})\s*[\/\-\.]\s*(\d{1,2})$/);
        if (ymd) {
            const d = new Date(Date.UTC(parseInt(ymd[1], 10), parseInt(ymd[2], 10) - 1, parseInt(ymd[3], 10)));
            return isNaN(d.getTime()) ? null : d;
        }
        const d = new Date(clean);
        return isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(dateVal);
    return isNaN(d.getTime()) ? null : d;
};

const formatDobDate = (dateVal) => {
    if (!dateVal) return "Not Specified";
    const d = parseFlexibleDate(dateVal);
    if (!d) return typeof dateVal === "string" ? dateVal.trim() : "Not Specified";
    return `${String(d.getUTCDate()).padStart(2, "0")} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

const buildUserDetails = (user, body = {}, type = "CHAT") => {
    const incomingName = body.name || body.userName || body.fullName || (body.user && (body.user.name || body.user.userName));
    const dbName = user.name || `${user.firstname || ""} ${user.lastname || ""}`.trim() || user.username;
    const name = incomingName && typeof incomingName === "string" && incomingName.trim()
        ? incomingName.trim()
        : dbName || (user.phone ? `User (${user.phone})` : "Client User");

    const dob = body.dob || body.dateofbirth || body.confirmedDob || user.dateofbirth || user.dob || null;
    const tob = body.tob || body.timeofbirth || user.timeofbirth || user.tob || null;
    const pob = body.pob || body.placeofbirth
        || (user.birthLocation && (user.birthLocation.city || user.birthLocation.name || user.birthLocation.district || user.birthLocation.state))
        || user.placeofbirth || user.pob || null;
    const topic = body.topic || body.consultationTopic || body.subject || user.topic
        || (type === "VIDEO" ? "Video Consultation" : type === "AUDIO" ? "Audio Consultation" : "Astrology Consultation");
    const gender = body.gender || user.gender || "Not Specified";

    // save fields the user profile is missing (background; never delays the request)
    const updates = {};
    if (incomingName && (!user.name || user.name === "Client User")) updates.name = incomingName;
    if (dob && !user.dateofbirth) { const p = parseFlexibleDate(dob); if (p) updates.dateofbirth = p; }
    if (tob && !user.timeofbirth) updates.timeofbirth = tob;
    if (pob && !user.placeofbirth) updates.placeofbirth = pob;
    if (gender && (!user.gender || user.gender === "Not Specified")) updates.gender = gender;
    if (Object.keys(updates).length) runInBackground(User.updateOne({ _id: user._id }, { $set: updates }), "profile save");

    return {
        _id: user._id,
        id: user._id,
        name,
        firstname: user.firstname || name.split(" ")[0],
        lastname: user.lastname || name.split(" ").slice(1).join(" "),
        phone: user.phone || "",
        email: user.email || "",
        profileImage: user.profileImage || user.avatar || "",
        avatar: user.profileImage || user.avatar || "",
        dob: dob ? formatDobDate(dob) : "Not Specified",
        dateofbirth: dob ? formatDobDate(dob) : "Not Specified",
        tob: tob || "Not Specified",
        timeofbirth: tob || "Not Specified",
        pob: pob || "Not Specified",
        placeofbirth: pob || "Not Specified",
        topic,
        consultationTopic: topic,
        gender
    };
};

// ---------------------------------------------------------------------------------------
// lifecycle handlers
// ---------------------------------------------------------------------------------------

/** A closed pending session that the engine cancelled by itself still has to be announced. */
const announceEngineClosure = (io, err) => {
    const s = err && err.details && err.details.session;
    if (!s) return;
    if (s.status === "MISSED") realtime.emitRequestClosed(io, s, { kind: "missed", message: "Request timed out." });
    else if (s.status === "CANCELLED") realtime.emitRequestClosed(io, s, { kind: "cancelled", message: err.message });
};

const requestSession = async ({ decoded, body = {}, defaultType = "CHAT", protocol = 1 }) => {
    if (!decoded || !decoded.userId) throw new SessionError("UNAUTHORIZED", "Authentication required.", 401);
    if (decoded.role === "astrologer") throw new SessionError("FORBIDDEN", "Astrologers cannot request consultations.", 403);

    const astrologerId = body.astrologerId || body.astrologer_id || body.astrologer;
    const type = body.callType || body.requestType || body.type || defaultType;
    const io = getIo();

    const result = await engine.requestSession({
        userId: decoded.userId,
        astrologerId,
        type,
        protocol: Number(body.protocol || protocol) >= 2 ? 2 : 1
    });

    const userDetails = buildUserDetails(result.user, body, result.session.type);

    // the previous pending request of this user (if any) is withdrawn from its astrologer
    for (const old of result.superseded) {
        realtime.emitRequestClosed(io, old, { kind: "cancelled", message: "Superseded by a new request." });
    }
    if (!result.idempotent) realtime.emitIncoming(io, result.session, userDetails);

    return { ...result, userDetails };
};

const acceptSession = async ({ decoded, sessionId, protocol = 1 }) => {
    const io = getIo();
    try {
        const result = await engine.acceptSession({
            sessionId,
            actor: actorOf(decoded),
            protocol: Number(protocol) >= 2 ? 2 : 1,
            isUserConnected: (userId) => realtime.isParticipantConnected(io, "USER", userId)
        });
        if (!result.idempotent) realtime.emitAccepted(io, result.session);
        return { ...result, agora: realtime.agoraFor(result.session, "ASTROLOGER") };
    } catch (err) {
        announceEngineClosure(io, err);
        throw err;
    }
};

/** Astrologer rejects; a user "rejecting" is a cancel (legacy clients use one event for both). */
const rejectOrCancel = async ({ decoded, sessionId, reason }) => {
    const io = getIo();
    const session = await engine.loadSession(sessionId);
    const role = await engine.roleOf(session, actorOf(decoded));
    if (!role) throw new SessionError("FORBIDDEN", "You are not a participant of this session.", 403);

    if (role === "USER") return cancelSession({ decoded, sessionId, reason });

    const result = await engine.rejectSession({ sessionId, actor: actorOf(decoded), reason });
    if (!result.idempotent) {
        realtime.emitRequestClosed(io, result.session, { kind: "rejected", message: result.session.rejectionReason || "Astrologer rejected the request." });
    }
    return result;
};

const cancelSession = async ({ decoded, sessionId, reason }) => {
    const io = getIo();
    const result = await engine.cancelSession({ sessionId, actor: actorOf(decoded), reason });
    if (!result.idempotent && !result.ignored && result.session.status === "CANCELLED") {
        realtime.emitRequestClosed(io, result.session, { kind: "cancelled", message: "Request cancelled." });
    }
    return result;
};

const endSession = async ({ decoded, sessionId, reason, system = false, endAt = null, insufficientFunds = false, message = null }) => {
    const io = getIo();
    const result = await engine.endSession({
        sessionId,
        actor: system ? { system: true } : actorOf(decoded),
        reason,
        endAt
    });
    announceEndResult(io, result, { insufficientFunds, message });
    return result;
};

const pauseBilling = async ({ decoded, sessionId }) => {
    const result = await engine.pauseBilling({ sessionId, actor: actorOf(decoded) });
    if (!result.idempotent && !result.ignored) realtime.emitBillingPaused(getIo(), result.session);
    return result;
};

const resumeBilling = async ({ decoded, sessionId }) => {
    const result = await engine.resumeBilling({ sessionId, actor: actorOf(decoded) });
    if (!result.idempotent) realtime.emitBillingResumed(getIo(), result.session);
    return result;
};

/** Emit the right events for an End result; duplicate callers (idempotent) emit nothing. */
const announceEndResult = (io, result, { insufficientFunds = false, message = null } = {}) => {
    if (result.idempotent) return;
    const s = result.session;
    if (s.status === "COMPLETED" || s.status === "ENDING") {
        realtime.emitEnded(io, s, {
            message: message || (insufficientFunds ? "Consultation ended: insufficient wallet balance." : "Consultation session ended."),
            insufficientFunds
        });
    } else if (s.status === "CANCELLED") {
        realtime.emitRequestClosed(io, s, { kind: "cancelled", message: "Session ended before it started." });
    }
};

const mediaReady = async ({ decoded, sessionId }) => {
    const io = getIo();
    try {
        const result = await engine.markMediaReady({ sessionId, actor: actorOf(decoded) });
        if (result.started) realtime.emitStarted(io, result.session);
        return result;
    } catch (err) {
        announceEngineClosure(io, err);
        throw err;
    }
};

/** The unified session with user / astrologer sub-documents, as the legacy REST responses returned it. */
const withParticipants = async (session) => {
    const [user, astro] = await Promise.all([
        User.findById(session.user)
            .select("firstname lastname phone profileImage walletBalance dateofbirth timeofbirth placeofbirth name")
            .lean(),
        Astrologer.findById(session.astrologer).select("name profileImage consultationFee specialization").lean()
    ]);
    return { ...session, user: user || session.user, astrologer: astro || session.astrologer };
};

// ---------------------------------------------------------------------------------------
// connection tracking + recovery
// ---------------------------------------------------------------------------------------

/** { role, id, key } of the participant a socket belongs to, or null (guests, admins). */
const participantOfSocket = (socket) => {
    const d = socket.data || {};
    if (d.astroId) return { role: ACTOR.ASTROLOGER, id: d.astroId, key: "astrologer" };
    if (d.userId && d.role !== "admin" && d.role !== "superadmin") return { role: ACTOR.USER, id: d.userId, key: "user" };
    return null;
};

/** The last socket of a participant dropped: start their grace window on their ACTIVE session. */
const onSocketDisconnected = async (io, socket) => {
    const p = participantOfSocket(socket);
    if (!p) return;
    const session = await Session.findOne({ [p.key]: p.id, liveLock: true, status: "ACTIVE" }).select("_id").lean();
    if (!session) return;
    if (await realtime.isParticipantConnected(io, p.role, p.id, socket.id)) return; // another socket of theirs remains
    const marked = await connection.markDisconnected({ sessionId: session._id, role: p.role });
    if (marked) realtime.emitPeerState(io, marked, p.role, "RECONNECTING");
};

/** A participant's socket connected: if they were in a grace window, they are back (no client action needed). */
const onSocketConnected = async (io, socket) => {
    const p = participantOfSocket(socket);
    if (!p) return;
    const session = await Session.findOne({ [p.key]: p.id, liveLock: true, status: "ACTIVE" }).select("_id").lean();
    if (!session) return;
    const { session: updated, resumed } = await connection.markConnected({ sessionId: session._id, role: p.role });
    if (resumed) realtime.emitPeerState(io, updated, p.role, "CONNECTED");
};

/** Explicit resume: restores state after reconnect / app restart. Always returns the authoritative snapshot. */
const resumeSession = async ({ decoded, sessionId }) => {
    const io = getIo();
    const session = await engine.loadSession(sessionId);
    const role = await engine.roleOf(session, actorOf(decoded));
    if (role !== ACTOR.USER && role !== ACTOR.ASTROLOGER) throw new SessionError("FORBIDDEN", "You are not a participant of this session.", 403);
    const { session: updated, resumed } = await connection.markConnected({ sessionId: session._id, role });
    if (resumed) realtime.emitPeerState(io, updated, role, "CONNECTED");
    const current = updated || session;
    return { session: current, role, resumed, snapshot: realtime.snapshotFor(current, role) };
};

const heartbeat = async ({ decoded, sessionId }) => {
    const session = await engine.loadSession(sessionId);
    const role = await engine.roleOf(session, actorOf(decoded));
    if (role !== ACTOR.USER && role !== ACTOR.ASTROLOGER) throw new SessionError("FORBIDDEN", "You are not a participant of this session.", 403);
    await connection.heartbeat({ sessionId: session._id, role });
    return { serverNow: new Date().toISOString() };
};

/** "Do I have an active session?" */
const getActive = async ({ decoded }) => {
    const found = await engine.findActiveFor(decoded);
    if (!found) return null;
    return { ...found, snapshot: realtime.snapshotFor(found.session, found.role) };
};

const ackFinal = ({ decoded, sessionId }) => engine.ackFinal({ sessionId, actor: actorOf(decoded) });

/** Error -> { code, message, status } for acknowledgements and REST error bodies. */
const describeError = (err) => {
    if (err instanceof SessionError) return { code: err.code, message: err.message, status: err.status, details: { ...err.details, session: undefined } };
    return { code: "INTERNAL_ERROR", message: err && err.message ? err.message : "Unexpected error", status: 500 };
};

module.exports = {
    getIo,
    buildUserDetails,
    withParticipants,
    requestSession,
    acceptSession,
    rejectOrCancel,
    cancelSession,
    endSession,
    pauseBilling,
    resumeBilling,
    announceEndResult,
    mediaReady,
    participantOfSocket,
    onSocketDisconnected,
    onSocketConnected,
    resumeSession,
    heartbeat,
    getActive,
    ackFinal,
    describeError
};
