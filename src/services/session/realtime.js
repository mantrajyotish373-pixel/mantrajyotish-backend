/**
 * Turns engine results into Socket.IO events. This is the ONLY place session events are emitted.
 *
 * Rooms: every authenticated socket is put in `user:<id>` or `astro:<id>` by the server from its
 * verified token (config/socket.js), so there is no registration step to race and a request goes
 * straight to one room.
 *
 * Two vocabularies, routed by the protocol each participant speaks (stored on the session):
 *   protocol 2 -> session:* events (acknowledged requests, media_ready, server-derived clock)
 *   protocol 1 -> the legacy events and payload shapes existing clients already understand
 * Before the astrologer has answered, their protocol is unknown, so they receive both.
 */
const agoraService = require("../agora.service");
const rules = require("./rules");

const rooms = {
    user: (id) => `user:${id}`,
    astro: (id) => `astro:${id}`,
    session: (id) => `session_${id}`
};

const idOf = (ref) => String(ref && ref._id ? ref._id : ref);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const userProto = (s) => (s.protocol && s.protocol.user) || 1;
const astroProto = (s) => (s.protocol && s.protocol.astrologer) || 1;
// The astrologer's protocol is only known once they have accepted
const astroProtoKnown = (s) => Boolean(s.acceptedAt);

const typeEvent = (session) => (session.type === "CHAT" ? "chat" : "call");

/** Is at least one authenticated socket of this participant connected right now? */
const isParticipantConnected = async (io, role, id, excludeSocketId = null) => {
    if (!io) return true;
    const room = role === "USER" ? rooms.user(id) : rooms.astro(id);
    const sockets = await io.in(room).fetchSockets();
    return sockets.some((s) => s.id !== excludeSocketId);
};

/** Per-participant Agora credentials. Protocol-2 clients get their own uid; legacy clients uid 0. */
const agoraFor = (session, role) => {
    if (session.type === "CHAT") return null;
    const channel = session.channelName || session.roomId;
    if (!channel) return null;
    const proto = role === "USER" ? userProto(session) : astroProto(session);
    const uid = proto >= 2 ? (role === "USER" ? 1 : 2) : 0;
    return agoraService.generateRtcToken(channel, uid, "publisher");
};

// ---------------------------------------------------------------------------------------
// payloads
// ---------------------------------------------------------------------------------------

const sessionView = (session) => ({
    ...session,
    sessionId: session._id,
    chatId: session._id,
    callId: session._id,
    id: session._id
});

/** What each participant is told when the session ends. Clients show these numbers verbatim. */
const finalResult = (session, role) => {
    const b = (session.settlement && session.settlement.billing) || {};
    const base = {
        sessionId: String(session._id),
        type: session.type,
        status: session.status,
        endedBy: session.endedBy,
        endReason: session.endReason,
        startedAt: iso(session.startedAt),
        endedAt: iso(session.endedAt),
        durationSeconds: b.billableSeconds != null ? b.billableSeconds : session.totalDurationSeconds || 0,
        rawDurationSeconds: b.rawSeconds != null ? b.rawSeconds : 0,
        unbilledSeconds: b.unbilledSeconds || 0,
        perMinuteRate: session.perMinuteRate,
        totalCost: session.totalAmountDeducted || 0,
        settled: session.status === "COMPLETED"
    };
    if (role === "USER") {
        return { ...base, walletBalanceAfter: session.settlement ? session.settlement.userBalanceAfter : null };
    }
    return { ...base, earnings: session.astrologerEarnings || 0, platformFee: session.platformFee || 0 };
};

/** Legacy end payload (same shape broadcastSessionEnded used) */
const legacyEndPayload = (session, message) => ({
    success: true,
    message,
    session: sessionView(session),
    sessionId: String(session._id),
    _id: String(session._id),
    callId: String(session._id),
    chatId: String(session._id)
});

const incomingPayload = (session, userDetails, extras = {}) => {
    const isCall = session.type !== "CHAT";
    const view = {
        ...sessionView(session),
        user: userDetails,
        callType: session.type,
        type: session.type,
        requestType: isCall ? "CALL" : "CHAT"
    };
    return {
        message: isCall ? `New incoming ${session.type.toLowerCase()} call request!` : "New incoming chat request!",
        session: view,
        sessionId: session._id,
        chatId: session._id,
        callId: session._id,
        _id: session._id,
        user: userDetails,
        callType: session.type,
        type: session.type,
        requestType: isCall ? "CALL" : "CHAT",
        perMinuteRate: session.perMinuteRate,
        channelName: session.channelName,
        expiresAt: iso(session.expiresAt),
        serverNow: new Date().toISOString(),
        sound: "ringtone.mp3",
        ringtoneUrl: "/public/sounds/ringtone.mp3",
        ringtoneDuration: rules.CONFIG.REQUEST_TIMEOUT_SECONDS,
        playRingtone: true,
        ...extras
    };
};

// ---------------------------------------------------------------------------------------
// emitters
// ---------------------------------------------------------------------------------------

/** Request reached the server: tell ONLY the requested astrologer. */
const emitIncoming = (io, session, userDetails, extras) => {
    if (!io) return;
    const payload = incomingPayload(session, userDetails, extras);
    const room = rooms.astro(idOf(session.astrologer));
    io.to(room).emit("session:incoming", payload);
    if (session.type === "CHAT") {
        io.to(room).emit("incoming_chat_request", payload);
        io.to(room).emit("incoming_request", payload);
        io.to(room).emit("chat_request", payload);
    } else {
        io.to(room).emit("incoming_call_request", payload);
    }
};

/** A pending request was withdrawn (superseded / cancelled / rejected / missed): dismiss it. */
const emitRequestClosed = (io, session, { kind, message }) => {
    if (!io) return;
    const base = {
        success: false,
        message,
        reason: session.endReason || session.rejectionReason,
        session: sessionView(session),
        sessionId: String(session._id),
        chatId: String(session._id),
        callId: String(session._id),
        _id: String(session._id),
        id: String(session._id),
        status: session.status
    };
    const userRoom = rooms.user(idOf(session.user));
    const astroRoom = rooms.astro(idOf(session.astrologer));
    const t = typeEvent(session);
    const v2Event = `session:${kind}`; // rejected | cancelled | missed

    // user
    if (userProto(session) >= 2) {
        io.to(userRoom).emit(v2Event, base);
    } else {
        const legacy = kind === "rejected" ? [`${t}_rejected`] : kind === "missed"
            ? (t === "call" ? ["call_missed", "request_declined"] : ["chat_rejected", "request_declined"])
            : [`${t}_rejected`];
        [...legacy, "incoming_request_cancelled", "request_cancelled", `${t}_ended`].forEach((e) => io.to(userRoom).emit(e, base));
    }
    // astrologer (protocol unknown until they accept, so send both)
    if (!astroProtoKnown(session) || astroProto(session) >= 2) io.to(astroRoom).emit(v2Event, base);
    if (!astroProtoKnown(session) || astroProto(session) < 2) {
        ["incoming_request_cancelled", "request_cancelled", `${t}_ended`].forEach((e) => io.to(astroRoom).emit(e, base));
    }
};

/** Accepted. Chat is ACTIVE at once; audio/video are CONNECTING until both are media-ready. */
const emitAccepted = (io, session) => {
    if (!io) return;
    const serverNow = new Date().toISOString();
    const started = session.status === "ACTIVE";
    const t = typeEvent(session);

    for (const role of ["USER", "ASTROLOGER"]) {
        const room = role === "USER" ? rooms.user(idOf(session.user)) : rooms.astro(idOf(session.astrologer));
        const proto = role === "USER" ? userProto(session) : astroProto(session);
        const agora = agoraFor(session, role);

        if (proto >= 2) {
            io.to(room).emit("session:accepted", {
                sessionId: String(session._id),
                type: session.type,
                status: session.status,
                perMinuteRate: session.perMinuteRate,
                acceptedAt: iso(session.acceptedAt),
                connectDeadline: iso(session.connectDeadline),
                serverNow,
                agora: agora ? { appId: agora.appId, channelName: agora.channelName, token: agora.token, uid: agora.uid } : null,
                session: sessionView(session)
            });
        } else if (role === "USER") {
            // legacy user: same payloads as before
            const startTime = iso(session.startedAt);
            if (t === "chat") {
                const payload = {
                    success: true,
                    message: "Astrologer accepted chat request. Live session started!",
                    session: sessionView(session),
                    sessionId: session._id,
                    _id: session._id,
                    id: session._id,
                    startTime,
                    startedAt: startTime,
                    serverNow
                };
                io.to(room).emit("chat_accepted", payload);
                io.to(room).emit("session_active", payload);
            } else {
                io.to(room).emit("call_accepted", {
                    success: true,
                    message: "Call request accepted! Agora RTC token generated.",
                    sessionId: session._id,
                    callId: session._id,
                    callType: session.callType || session.type,
                    channelName: session.channelName,
                    agora,
                    appId: agora && agora.appId,
                    token: agora && agora.token,
                    startTime,
                    startedAt: startTime,
                    serverNow,
                    session: sessionView(session)
                });
            }
        }
    }
    if (started) emitStarted(io, session, { skipV2Accepted: true });
};

/** Billing clock started (chat: at accept; audio/video: when the second participant was ready). */
const emitStarted = (io, session) => {
    if (!io) return;
    const serverNow = new Date().toISOString();
    const startedAt = iso(session.startedAt);
    const payload = {
        sessionId: String(session._id),
        type: session.type,
        startedAt,
        serverNow,
        perMinuteRate: session.perMinuteRate,
        maxEndAt: iso(session.maxEndAt),
        balanceAtStart: session.balanceAtStart
    };
    for (const role of ["USER", "ASTROLOGER"]) {
        const room = role === "USER" ? rooms.user(idOf(session.user)) : rooms.astro(idOf(session.astrologer));
        const proto = role === "USER" ? userProto(session) : astroProto(session);
        if (proto >= 2) {
            io.to(room).emit("session:started", payload);
        } else if (session.type !== "CHAT") {
            // legacy call participants learn the authoritative start from a tick-shaped event
            const tick = { sessionId: session._id, startTime: startedAt, startedAt, serverNow, elapsedSeconds: 0, elapsedMinutes: 0, remainingBalance: session.balanceAtStart, totalDeducted: 0 };
            io.to(room).emit("session_active", { success: true, session: sessionView(session), sessionId: session._id, startTime: startedAt, serverNow });
            io.to(room).emit("timer_tick", tick);
            io.to(room).emit("timerTick", tick);
        }
    }
};

/** Session reached a terminal state after running (or being settled). */
const emitEnded = (io, session, { message = "Consultation session ended.", insufficientFunds = false } = {}) => {
    if (!io) return;
    const t = typeEvent(session);
    const legacy = legacyEndPayload(session, message);

    for (const role of ["USER", "ASTROLOGER"]) {
        const room = role === "USER" ? rooms.user(idOf(session.user)) : rooms.astro(idOf(session.astrologer));
        const proto = role === "USER" ? userProto(session) : astroProto(session);
        if (proto >= 2) {
            io.to(room).emit("session:ended", finalResult(session, role));
        } else {
            if (insufficientFunds) io.to(room).emit(`${t}_ended_insufficient_funds`, { sessionId: String(session._id), message: "Consultation ended: insufficient wallet balance." });
            io.to(room).emit("call_ended", legacy);
            io.to(room).emit("chat_ended", legacy);
            io.to(room).emit("session_ended", legacy);
            io.to(room).emit("status_change", { status: "COMPLETED", session: sessionView(session), sessionId: String(session._id) });
        }
    }
    // legacy clients that only joined the session rooms
    const sroom = rooms.session(session._id);
    io.to(sroom).emit("call_ended", legacy);
    io.to(sroom).emit("chat_ended", legacy);
    io.to(sroom).emit("session_ended", legacy);
};

/** Periodic clock resync + the existing low-balance warning (same condition and payload as before). */
const emitTick = (io, session, now = new Date()) => {
    if (!io) return { low: false };
    const startedAt = session.startedAt || session.startTime;
    const ratePerSec = Number(session.perMinuteRate) / 60;
    const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - new Date(startedAt).getTime()) / 1000));
    const totalDeducted = parseFloat((elapsedSeconds * ratePerSec).toFixed(2));
    const remainingBalance = Math.max(0, parseFloat((Number(session.balanceAtStart || 0) - totalDeducted).toFixed(2)));
    const low = rules.isLowBalance(remainingBalance, session.perMinuteRate);

    const tick = {
        sessionId: session._id,
        startTime: iso(startedAt),
        startedAt: iso(startedAt),
        serverNow: now.toISOString(),
        elapsedMinutes: Math.floor(elapsedSeconds / 60),
        elapsedSeconds,
        remainingBalance,
        totalDeducted,
        maxEndAt: iso(session.maxEndAt),
        unbilledSeconds: (session.disconnectState && session.disconnectState.unbilledGraceSeconds) || 0
    };
    const warning = { message: "Your wallet balance is low. Please recharge to continue the consultation.", remainingBalance };

    for (const role of ["USER", "ASTROLOGER"]) {
        const room = role === "USER" ? rooms.user(idOf(session.user)) : rooms.astro(idOf(session.astrologer));
        const proto = role === "USER" ? userProto(session) : astroProto(session);
        if (proto >= 2) {
            io.to(room).emit("session:tick", tick);
            if (low) io.to(room).emit("session:low_balance", { sessionId: String(session._id), ...warning });
        } else {
            io.to(room).emit("timer_tick", tick);
            io.to(room).emit("timerTick", tick);
            if (low) io.to(room).emit("wallet_warning", warning);
        }
    }
    return { low };
};

/** Tell the OTHER participant that someone is reconnecting / is back (v2 clients only). */
const emitPeerState = (io, session, role, state) => {
    if (!io) return;
    const key = role === "USER" ? "user" : "astrologer";
    const conn = (session.connection && session.connection[key]) || {};
    const otherRole = role === "USER" ? "ASTROLOGER" : "USER";
    const otherRoom = otherRole === "USER" ? rooms.user(idOf(session.user)) : rooms.astro(idOf(session.astrologer));
    const otherProto = otherRole === "USER" ? userProto(session) : astroProto(session);
    if (otherProto < 2) return; // legacy clients have no such concept
    io.to(otherRoom).emit(state === "RECONNECTING" ? "session:peer_reconnecting" : "session:peer_reconnected", {
        sessionId: String(session._id),
        role,
        since: iso(conn.since),
        deadline: iso(conn.deadline),
        serverNow: new Date().toISOString()
    });
};

/** Billing paused / resumed around a wallet recharge (existing events + new session:* events). */
const emitBillingPaused = (io, session) => {
    if (!io) return;
    const payload = {
        sessionId: String(session._id),
        message: "User is recharging wallet. Billing temporarily paused.",
        pausedAt: iso(session.billingPausedAt),
        pauseDeadline: iso(session.pauseDeadline),
        serverNow: new Date().toISOString()
    };
    for (const role of ["USER", "ASTROLOGER"]) {
        const room = role === "USER" ? rooms.user(idOf(session.user)) : rooms.astro(idOf(session.astrologer));
        const proto = role === "USER" ? userProto(session) : astroProto(session);
        io.to(room).emit(proto >= 2 ? "session:billing_paused" : "billing_paused", payload);
    }
};

const emitBillingResumed = (io, session) => {
    if (!io) return;
    const payload = {
        sessionId: String(session._id),
        message: "Wallet recharge successful. Billing resumed.",
        remainingBalance: session.balanceAtStart,
        startedAt: iso(session.startedAt),
        maxEndAt: iso(session.maxEndAt),
        serverNow: new Date().toISOString()
    };
    for (const role of ["USER", "ASTROLOGER"]) {
        const room = role === "USER" ? rooms.user(idOf(session.user)) : rooms.astro(idOf(session.astrologer));
        const proto = role === "USER" ? userProto(session) : astroProto(session);
        io.to(room).emit(proto >= 2 ? "session:billing_resumed" : "billing_resumed", payload);
    }
    emitTick(io, session);
};

/** Authoritative snapshot a client uses to restore its UI after reconnect / restart. */
const snapshotFor = (session, role, now = new Date()) => {
    const proto = role === "USER" ? userProto(session) : astroProto(session);
    const agora = ["CONNECTING", "ACTIVE"].includes(session.status) ? agoraFor(session, role) : null;
    return {
        sessionId: String(session._id),
        type: session.type,
        status: session.status,
        role,
        perMinuteRate: session.perMinuteRate,
        requestedAt: iso(session.requestedAt),
        expiresAt: iso(session.expiresAt),
        acceptedAt: iso(session.acceptedAt),
        connectDeadline: iso(session.connectDeadline),
        startedAt: iso(session.startedAt),
        endedAt: iso(session.endedAt),
        maxEndAt: iso(session.maxEndAt),
        serverNow: now.toISOString(),
        peer: {
            state: (session.connection && session.connection[role === "USER" ? "astrologer" : "user"] || {}).state || "CONNECTED",
            deadline: iso((session.connection && session.connection[role === "USER" ? "astrologer" : "user"] || {}).deadline)
        },
        billingPaused: Boolean(session.billingPausedAt),
        agora: agora ? { appId: agora.appId, channelName: agora.channelName, token: agora.token, uid: agora.uid } : null,
        final: ["COMPLETED", "ENDING"].includes(session.status) ? finalResult(session, role) : null,
        protocol: proto
    };
};

module.exports = {
    rooms,
    isParticipantConnected,
    agoraFor,
    sessionView,
    finalResult,
    incomingPayload,
    emitIncoming,
    emitRequestClosed,
    emitAccepted,
    emitStarted,
    emitEnded,
    emitTick,
    emitBillingPaused,
    emitBillingResumed,
    emitPeerState,
    snapshotFor
};
