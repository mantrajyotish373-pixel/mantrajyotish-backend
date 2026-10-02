/**
 * Socket entry points for the Session Engine.
 *
 *  - session:* events: the new acknowledged protocol (request, accept, reject, cancel, end,
 *    media_ready, resume, heartbeat, time:sync).
 *  - legacy events (request_chat, accept_call_request, end_chat_session, ...): kept so existing
 *    clients keep working; they run the SAME handlers, only the reply shape differs.
 *
 * Identity always comes from the verified token on the socket, never from the payload.
 */
const handlers = require("../services/session/handlers");
const engine = require("../services/session/engine");
const realtime = require("../services/session/realtime");

const PREFIXES = ["call_", "session_", "chat_", "room_"];

/** Session id from the many payload shapes clients send (string, {sessionId}, {chatId}, ...). */
const extractSessionId = (data) => {
    if (!data) return null;
    let id = typeof data === "string"
        ? data
        : data.sessionId || data.chatId || data.callId || data.roomId || data._id || data.id || (data.session && (data.session._id || data.session.id));
    if (!id || typeof id !== "string") return null;
    for (const p of PREFIXES) if (id.startsWith(p)) id = id.slice(p.length);
    return id;
};

const registerSessionSocket = (io, socket) => {
    const decoded = () => socket.decodedUser;
    const protocol = () => (Number(socket.data && socket.data.protocol) >= 2 ? 2 : 1);

    const snapshot = async (session) => {
        const role = await engine.roleOf(session, { user: decoded() });
        return realtime.snapshotFor(session, role === "USER" || role === "ASTROLOGER" ? role : "USER");
    };

    /** acknowledged handler: always answers the caller with { ok, ... } */
    const acked = (fn) => async (data, ack) => {
        try {
            const out = await fn(data && typeof data === "object" ? data : { sessionId: data });
            if (typeof ack === "function") ack({ ok: true, ...out });
        } catch (err) {
            const d = handlers.describeError(err);
            if (typeof ack === "function") ack({ ok: false, code: d.code, message: d.message, details: d.details });
            else socket.emit("error", { message: d.message, code: d.code });
        }
    };

    /** legacy handler: no acknowledgement, errors arrive as an `error` event as before */
    const legacy = (fn) => async (data) => {
        try {
            await fn(data);
        } catch (err) {
            const d = handlers.describeError(err);
            socket.emit("error", { message: d.message, code: d.code });
        }
    };

    // ------------------------------------------------------------------ operations

    const doRequest = async (data, defaultType) => {
        const result = await handlers.requestSession({ decoded: decoded(), body: data || {}, defaultType, protocol: protocol() });
        socket.join(realtime.rooms.session(result.session._id)); // legacy clients wait in the session room
        return result;
    };

    const doAccept = (data) => handlers.acceptSession({ decoded: decoded(), sessionId: extractSessionId(data), protocol: protocol() });
    const doRejectOrCancel = (data) =>
        handlers.rejectOrCancel({ decoded: decoded(), sessionId: extractSessionId(data), reason: data && typeof data === "object" ? data.reason : undefined });
    const doCancel = (data) =>
        handlers.cancelSession({ decoded: decoded(), sessionId: extractSessionId(data), reason: data && typeof data === "object" ? data.reason : undefined });
    const doEnd = (data) =>
        handlers.endSession({ decoded: decoded(), sessionId: extractSessionId(data), reason: data && typeof data === "object" ? data.reason : undefined });

    // ------------------------------------------------------------------ session:* protocol

    socket.on("session:request", acked(async (data) => {
        const r = await doRequest(data, "CHAT");
        return {
            idempotent: r.idempotent,
            session: realtime.snapshotFor(r.session, "USER")
        };
    }));

    socket.on("session:accept", acked(async (data) => {
        const r = await doAccept(data);
        return { idempotent: Boolean(r.idempotent), started: Boolean(r.started), session: await snapshot(r.session) };
    }));

    socket.on("session:reject", acked(async (data) => {
        const r = await doRejectOrCancel(data);
        return { idempotent: Boolean(r.idempotent), session: await snapshot(r.session) };
    }));

    socket.on("session:cancel", acked(async (data) => {
        const r = await doCancel(data);
        return { idempotent: Boolean(r.idempotent), ignored: Boolean(r.ignored), session: await snapshot(r.session) };
    }));

    socket.on("session:end", acked(async (data) => {
        const r = await doEnd(data);
        return { idempotent: Boolean(r.idempotent), session: await snapshot(r.session) };
    }));

    socket.on("session:media_ready", acked(async (data) => {
        const r = await handlers.mediaReady({ decoded: decoded(), sessionId: extractSessionId(data) });
        return { started: Boolean(r.started), session: await snapshot(r.session) };
    }));

    socket.on("session:pause_billing", acked(async (data) => {
        const r = await handlers.pauseBilling({ decoded: decoded(), sessionId: extractSessionId(data) });
        return { idempotent: Boolean(r.idempotent), ignored: Boolean(r.ignored), session: await snapshot(r.session) };
    }));

    socket.on("session:resume_billing", acked(async (data) => {
        const r = await handlers.resumeBilling({ decoded: decoded(), sessionId: extractSessionId(data) });
        return { idempotent: Boolean(r.idempotent), session: await snapshot(r.session) };
    }));

    // Reconnect / app restart: ask the server for the authoritative state and (re)join the session
    socket.on("session:resume", acked(async (data) => {
        const r = await handlers.resumeSession({ decoded: decoded(), sessionId: extractSessionId(data) });
        return { resumed: r.resumed, session: r.snapshot };
    }));

    socket.on("session:active", acked(async () => {
        const found = await handlers.getActive({ decoded: decoded() });
        return { session: found ? found.snapshot : null };
    }));

    socket.on("session:heartbeat", acked((data) => handlers.heartbeat({ decoded: decoded(), sessionId: extractSessionId(data) })));

    socket.on("session:ack_final", acked(async (data) => {
        await handlers.ackFinal({ decoded: decoded(), sessionId: extractSessionId(data) });
        return {};
    }));

    // Clock probe so a client can estimate its offset from the server (Cristian's algorithm)
    socket.on("time:sync", (data, ack) => {
        if (typeof ack === "function") ack({ serverNow: new Date().toISOString() });
    });

    // ------------------------------------------------------------------ legacy events

    ["request_chat", "initiate_chat"].forEach((evt) =>
        socket.on(evt, legacy(async (data) => {
            const r = await doRequest(data, "CHAT");
            socket.emit("chat_request_created", {
                success: true,
                message: "Chat request initiated successfully.",
                session: { ...realtime.sessionView(r.session), user: r.userDetails }
            });
        }))
    );

    socket.on("request_call", legacy(async (data) => {
        const r = await doRequest(data, "VIDEO");
        socket.join(`call_${r.session._id}`);
        socket.emit("call_request_sent", {
            success: true,
            message: "Call request sent to astrologer. Waiting for response...",
            session: realtime.sessionView(r.session)
        });
    }));

    ["accept_chat_request", "accept_call_request"].forEach((evt) =>
        socket.on(evt, legacy(async (data) => {
            const r = await doAccept(data);
            socket.join(`call_${r.session._id}`);
            socket.join(realtime.rooms.session(r.session._id));
        }))
    );

    ["reject_chat_request", "reject_call_request"].forEach((evt) => socket.on(evt, legacy(doRejectOrCancel)));
    ["cancel_chat_request", "cancel_call_request", "cancel_request"].forEach((evt) => socket.on(evt, legacy(doCancel)));
    ["end_chat_session", "end_call_session"].forEach((evt) => socket.on(evt, legacy(doEnd)));

    // wallet recharge pause / resume (existing events)
    socket.on("pause_session_billing", legacy((data) => handlers.pauseBilling({ decoded: decoded(), sessionId: extractSessionId(data) })));
    socket.on("resume_session_billing", legacy((data) => handlers.resumeBilling({ decoded: decoded(), sessionId: extractSessionId(data) })));
};

module.exports = { registerSessionSocket, extractSessionId };
