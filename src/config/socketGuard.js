const mongoose = require("mongoose");
const Astrologer = require("../models/astro.model");
const { findAnySession, getParticipantRole, isAdminRole } = require("../middlewares/sessionAuth.middleware");

/**
 * Authorization for incoming socket events, applied via socket.use() before any handler runs.
 *
 * - Guests (no token) may only subscribe to public astrologer presence.
 * - Registration events may only join the caller's own personal rooms.
 * - Session events require the caller to be a participant of the referenced session.
 * - Request events always act as the token's user.
 */

const PUBLIC_EVENTS = new Set(["presence:subscribe", "presence:unsubscribe", "time:sync"]);
// authenticated, and the handler itself answers for the caller's own sessions only
const CALLER_SCOPED_EVENTS = new Set(["session:active"]);

const REGISTRATION_EVENTS = new Set([
    "register_user", "register_astrologer", "register", "join_astrologer", "join_user"
]);

// Bound to both the personal-room registration handler and the session-room join handler
const AMBIGUOUS_JOIN_EVENTS = new Set(["join", "subscribe"]);

const REQUEST_EVENTS = new Set(["request_chat", "initiate_chat", "request_call", "session:request"]);

const SELF_EVENTS = new Set(["presence:heartbeat", "presence:status_changed"]);

const SESSION_EVENTS = new Set([
    "join_session", "join_room", "join_chat", "join_call_room",
    "send_message", "typing_status",
    "accept_chat_request", "reject_chat_request", "cancel_chat_request", "cancel_request", "end_chat_session",
    "accept_call_request", "reject_call_request", "cancel_call_request", "end_call_session",
    "pause_session_billing", "resume_session_billing",
    "media_state_change", "video_filter_applied", "filter_changed",
    // Session Engine protocol
    "session:accept", "session:reject", "session:cancel", "session:end", "session:media_ready",
    "session:pause_billing", "session:resume_billing", "session:resume", "session:heartbeat", "session:ack_final"
]);

const SESSION_ID_KEYS = ["sessionId", "chatId", "callId", "roomId", "_id", "id"];

const stripPrefixes = (value) => {
    let id = String(value);
    for (const prefix of ["call_", "session_", "chat_", "room_"]) {
        if (id.startsWith(prefix)) id = id.slice(prefix.length);
    }
    return id;
};

const extractRegistrationId = (data) => {
    if (data === null || data === undefined) return null;
    if (typeof data === "string" || typeof data === "number") return String(data);
    if (typeof data === "object") {
        const id = data.userId || data.astrologerId || data.id || data._id;
        return id ? String(id) : null;
    }
    return null;
};

/** All ids under which the authenticated caller may register personal rooms. */
const getOwnIds = async (socket) => {
    if (socket.ownIds) return socket.ownIds;

    const decoded = socket.decodedUser || {};
    const callerId = String(decoded.userId || decoded.id || decoded._id || "");
    const ids = new Set();
    if (callerId) ids.add(callerId);

    if (callerId && decoded.role === "astrologer" && mongoose.Types.ObjectId.isValid(callerId)) {
        const astro = await Astrologer.findOne({
            $or: [{ _id: callerId }, { astrologerLogin: callerId }]
        }).select("_id user astrologerLogin").lean().catch(() => null);
        if (astro) {
            ids.add(String(astro._id));
            if (astro.user) ids.add(String(astro.user));
            if (astro.astrologerLogin) ids.add(String(astro.astrologerLogin));
        }
    }

    socket.ownIds = ids;
    return ids;
};

const stripRoomPrefixes = (value) => {
    let id = String(value);
    for (const prefix of ["user_", "astro_", "astrologer_", "room_"]) {
        if (id.startsWith(prefix)) id = id.slice(prefix.length);
    }
    return id;
};

/**
 * Ensures every session identifier in the payload refers to one session the caller
 * participates in, so a payload cannot pair an authorized id with a foreign one.
 */
const authorizeSessionPayload = async (socket, data) => {
    const rawIds = [];
    if (typeof data === "string") {
        rawIds.push(data);
    } else if (data && typeof data === "object") {
        for (const key of SESSION_ID_KEYS) {
            if (typeof data[key] === "string" && data[key]) rawIds.push(data[key]);
        }
        if (data.session && typeof data.session === "object") {
            const nested = data.session._id || data.session.id;
            if (nested) rawIds.push(String(nested));
        }
    }

    if (rawIds.length === 0) return "A session id is required.";

    const cache = socket.authorizedSessions || (socket.authorizedSessions = new Map());
    let authorizedSessionId = null;

    for (const raw of rawIds) {
        const cleanId = stripPrefixes(raw);
        let sessionId = cache.get(cleanId);

        if (!sessionId) {
            const session = await findAnySession(cleanId);
            if (!session) return "Session not found.";
            const role = await getParticipantRole(session, socket.decodedUser);
            if (!role) return "You are not a participant of this session.";
            sessionId = String(session._id);
            cache.set(cleanId, sessionId);
        }

        if (authorizedSessionId && authorizedSessionId !== sessionId) {
            return "Payload references more than one session.";
        }
        authorizedSessionId = sessionId;
    }

    return true;
};

/** Returns true when the event may proceed, or an error message. */
const authorizeSocketEvent = async (socket, event, data) => {
    if (PUBLIC_EVENTS.has(event)) return true;

    const decoded = socket.decodedUser;
    if (!decoded) return "Authentication required.";
    if (isAdminRole(decoded.role)) return true;

    if (SELF_EVENTS.has(event) || CALLER_SCOPED_EVENTS.has(event)) return true; // handlers act only on the caller's own state

    if (REGISTRATION_EVENTS.has(event) || AMBIGUOUS_JOIN_EVENTS.has(event)) {
        const requestedId = extractRegistrationId(data);
        if (!requestedId) return true; // handlers ignore empty payloads
        const ownIds = await getOwnIds(socket);
        if (ownIds.has(stripRoomPrefixes(requestedId))) return true;
        if (AMBIGUOUS_JOIN_EVENTS.has(event)) return await authorizeSessionPayload(socket, data);
        return "You can only register your own account.";
    }

    if (REQUEST_EVENTS.has(event)) {
        if (!data || typeof data !== "object") return "Invalid request payload.";
        // The requesting user is always the token holder
        const callerId = String(decoded.userId || decoded.id || decoded._id);
        delete data.user;
        delete data.user_id;
        data.userId = callerId;
        return true;
    }

    if (SESSION_EVENTS.has(event)) return await authorizeSessionPayload(socket, data);

    // No server handler exists for other events; drop them quietly
    return null;
};

const createSocketGuard = (socket) => async (packet, next) => {
    const [event, data] = packet;
    // acknowledged events (session:*) get the refusal as their reply instead of an `error` event
    const ack = typeof packet[packet.length - 1] === "function" ? packet[packet.length - 1] : null;
    const refuse = (message) => {
        if (ack) ack({ ok: false, code: "FORBIDDEN", message });
        else socket.emit("error", { event, message });
    };
    try {
        const result = await authorizeSocketEvent(socket, event, data);
        if (result === true) return next();
        if (result) refuse(result);
    } catch (err) {
        console.error(`Socket guard error for event ${event}:`, err.message);
        refuse("Authorization failed.");
    }
};

module.exports = { createSocketGuard };
