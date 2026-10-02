const { Server } = require("socket.io");
const ChatSession = require("../models/chatSession.model");
const ChatMessage = require("../models/chatMessage.model");
const VideoSession = require("../models/videoSession.model");
const User = require("../models/user.model");
const Astrologer = require("../models/astro.model");
const { registerSessionSocket } = require("./sessionSocket");
const { createSocketGuard } = require("./socketGuard");
const { getParticipantRole } = require("../middlewares/sessionAuth.middleware");

let io;
const disconnectTimeouts = new Map();
const sessionDisconnectTimeouts = new Map();

const extractSessionId = (data) => {
    if (!data) return null;
    let idStr = null;
    if (typeof data === "string") {
        idStr = data;
    } else {
        idStr = data.sessionId || data.chatId || data.callId || data.roomId || data._id || data.id || (data.session && (data.session._id || data.session.id));
    }
    if (!idStr || typeof idStr !== "string") return null;

    let cleanId = idStr;
    if (cleanId.startsWith("call_")) cleanId = cleanId.replace("call_", "");
    if (cleanId.startsWith("session_")) cleanId = cleanId.replace("session_", "");
    if (cleanId.startsWith("chat_")) cleanId = cleanId.replace("chat_", "");
    if (cleanId.startsWith("room_")) cleanId = cleanId.replace("room_", "");

    return cleanId;
};

const broadcastSessionEnded = (session, sessionId, message = "Consultation session ended.") => {
    if (!io || !session) return;
    require("../services/session/realtime").emitEnded(io, session, { message });
};

const broadcastAstroStatus = (astroId, isOnline, isAvailable) => {
    if (io) {
        io.emit("astrologer_status_changed", {
            astrologerId: String(astroId),
            isOnline: Boolean(isOnline),
            isAvailable: Boolean(isAvailable)
        });
        console.log(`📢 Broadcast status change: Astrologer ${astroId} isOnline=${isOnline}, isAvailable=${isAvailable}`);
    }
};

/**
 * Kept for old call sites. Stale sessions are handled by the Session Engine (request expiry, media
 * deadline, wallet limit, disconnect grace). The legacy version ended any ACTIVE session older than
 * 30 minutes whenever the astrologer reconnected, which cut off long consultations.
 */
const cleanupStaleSessions = async () => {};

const initSocket = (server) => {
    io = new Server(server, {
        cors: {
            origin: "*",
            methods: ["GET", "POST", "PUT", "DELETE"]
        }
    });

    // Configure Socket.io Redis Adapter for horizontal scalability
    try {
        const { createAdapter } = require("@socket.io/redis-adapter");
        const { getRedisClient } = require("./redis");
        const redisClient = getRedisClient();
        if (redisClient) {
            const pubClient = redisClient;
            const subClient = redisClient.duplicate();
            subClient.connect().then(() => {
                io.adapter(createAdapter(pubClient, subClient));
                console.log("🚀 Socket.IO Redis Adapter configured successfully!");
            }).catch(err => {
                console.error("⚠️ Failed to connect Redis subClient for Socket.IO Adapter:", err.message);
            });
        }
    } catch (adapterErr) {
        console.error("⚠️ Failed to initialize Socket.IO Redis Adapter:", adapterErr.message);
    }

    // Authenticate socket connections using JWT and resolve who this socket is. The server (not the
    // client) puts the socket in its personal room, so no registration event can race a request.
    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        socket.data.protocol = Number(socket.handshake.auth?.sessionProtocol || socket.handshake.query?.sessionProtocol || 1);
        if (token) {
            try {
                const { verifyToken } = require("../utils/jwt");
                const decoded = verifyToken(token);
                socket.decodedUser = decoded;

                const callerId = String(decoded.userId || decoded.id || decoded._id || "");
                socket.data.userId = callerId;
                socket.data.role = decoded.role;
                if (decoded.role === "astrologer" && callerId) {
                    // tokens may carry the Astrologer id or the older AstrologerLogin id
                    const mongoose = require("mongoose");
                    const astro = mongoose.Types.ObjectId.isValid(callerId)
                        ? await Astrologer.findOne({ $or: [{ _id: callerId }, { astrologerLogin: callerId }] }).select("_id").lean()
                        : null;
                    if (astro) socket.data.astroId = String(astro._id);
                }
            } catch (err) {
                console.error("Socket JWT Authentication Failure:", err.message);
                return next(new Error("Authentication error: Invalid or expired token."));
            }
        }
        next();
    });

    io.on("connection", (socket) => {
        console.log(`🔌 New Socket Connection Established: ${socket.id}`);

        // Authorize every incoming event before it reaches a handler
        socket.use(createSocketGuard(socket));

        // Personal rooms, joined by the server from the verified identity
        if (socket.data.astroId) socket.join(`astro:${socket.data.astroId}`);
        else if (socket.data.userId && socket.data.role !== "admin" && socket.data.role !== "superadmin") socket.join(`user:${socket.data.userId}`);

        // Support staff listen for complaint activity. Membership is decided from the database, not the token.
        if (socket.data.role === "admin" || socket.data.role === "superadmin") {
            require("../models/admin.model").findById(socket.data.userId).select("role permissions status").lean()
                .then((a) => {
                    if (a && a.status !== "disabled" && (a.role === "superadmin" || (a.permissions || []).includes("support.view"))) socket.join("staff:support");
                })
                .catch(() => {});
        }

        // Session Engine events (session:* protocol and the legacy event names)
        registerSessionSocket(io, socket);
        require("../services/session/handlers").onSocketConnected(io, socket).catch((err) => console.error("session connect handling error:", err.message));

        // Register User or Astrologer to all their personal notification room variations
        const handleJoinRegistration = async (data) => {
            if (!data) return;
            let id = null;
            if (typeof data === "string" || typeof data === "number") {
                id = String(data);
            } else if (typeof data === "object") {
                id = data.userId || data.astrologerId || data.id || data._id;
            }
            if (id) {
                const strId = String(id);
                socket.join(strId);
                socket.join(`user_${strId}`);
                socket.join(`astro_${strId}`);
                socket.join(`astrologer_${strId}`);
                socket.join(`room_${strId}`);
                console.log(`👤 Socket ${socket.id} registered in room variations for ID: ${strId}`);
                
                // Track associated ID on socket
                socket.associatedUserId = strId;

                // Check if this ID is an astrologer and mark them as online/available
                const mongoose = require("mongoose");
                if (mongoose.Types.ObjectId.isValid(strId)) {
                    const astro = await Astrologer.findOne({
                        $or: [
                            { _id: strId },
                            { user: strId },
                            { astrologerLogin: strId }
                        ]
                    });
                    if (astro) {
                        const actualAstroId = astro._id.toString();
                        socket.associatedAstroId = actualAstroId;
                        socket.join(`astrologer:${actualAstroId}`);

                        const { getPresence, setPresence, transitionStatus } = require("../services/presence.service");
                        
                        // Clear pending disconnect timeout
                        if (disconnectTimeouts.has(actualAstroId)) {
                            clearTimeout(disconnectTimeouts.get(actualAstroId));
                            disconnectTimeouts.delete(actualAstroId);
                            console.log(`🔌 Cleared pending disconnect timeout for Astrologer ${astro.name} (${actualAstroId}) on reconnect`);
                        }
                        
                        // Fetch/Create presence
                        let presence = await getPresence(actualAstroId);
                        if (!presence) {
                            presence = {
                                status: "OFFLINE",
                                connections: 0,
                                lastHeartbeat: Date.now(),
                                activeSessionId: null,
                                timestamp: Date.now(),
                                version: 0
                            };
                        }

                        // Increment active connections count
                        presence.connections += 1;
                        presence.lastHeartbeat = Date.now();
                        await setPresence(actualAstroId, presence);
                        
                        // Clean up any stale sessions first to restore availability
                        await cleanupStaleSessions(astro._id);

                        // Only auto-flip to online if currently OFFLINE and not manually offline
                        if (presence.status === "OFFLINE" && astro.manualOffline !== true) {
                            await transitionStatus(actualAstroId, "ONLINE");
                        } else {
                            // Broadcast current presence status to join room to ensure client updates correctly
                            io.to(`astrologer:${actualAstroId}`).emit("presence:status_changed", {
                                astrologerId: String(actualAstroId),
                                status: presence.status,
                                timestamp: Math.floor(Date.now() / 1000),
                                version: presence.version,
                                activeSessionId: presence.activeSessionId
                            });
                        }

                        // A reconnect must not make an astrologer who is in a live session look available:
                        // recompute the flag from the session lock (the source of truth).
                        require("../services/session/availability").syncAvailability(actualAstroId).catch(() => null);
                    }
                }
            }
        };

        ["register_user", "register_astrologer", "register", "join", "join_astrologer", "subscribe", "join_user"].forEach(evt => {
            socket.on(evt, handleJoinRegistration);
        });

        // =====================================
        // CHAT SESSION SOCKET EVENTS
        // =====================================

        // Chat / call lifecycle (request, accept, reject, cancel, end) lives in the Session Engine:
        // see sessionSocket.js (session:* protocol + the legacy event names).

        // 2. Join Chat Session Room
        const handleJoinRoom = async (data) => {
            const sessionId = extractSessionId(data);
            if (!sessionId) return;

            const cleanId = String(sessionId);
            if (cleanId === String(socket.associatedAstroId) || cleanId === String(socket.associatedUserId)) {
                return;
            }

            socket.join(`session_${cleanId}`);
            socket.join(`call_${cleanId}`);
            socket.join(`chat_${cleanId}`);
            socket.join(`room_${cleanId}`);
            socket.join(cleanId);
            console.log(`👤 Socket ${socket.id} joined session room channels: ${cleanId}`);

            try {
                const mongoose = require("mongoose");
                if (mongoose.Types.ObjectId.isValid(cleanId)) {
                    const Session = require("../models/session.model");
                    const session = await Session.findById(cleanId).catch(() => null) || await ChatSession.findById(cleanId).catch(() => null);
                    if (session) {
                        socket.emit("session_state", { 
                            session,
                            sessionId: session._id,
                            _id: session._id
                        });
                    }
                }
            } catch (err) {
                console.error("Error fetching session on join:", err);
            }
        };

        socket.on("join_session", handleJoinRoom);
        socket.on("join_room", handleJoinRoom);
        socket.on("join_chat", handleJoinRoom);
        socket.on("join", handleJoinRoom);
        socket.on("subscribe", handleJoinRoom);

        // Allow register_user with just a plain string or object
        socket.on("join_user", (data) => {
            const rawId = typeof data === "string" ? data : (data?.userId || data?.id || data?._id || "");
            const cleanId = String(rawId).replace("user_", "");
            if (cleanId) {
                socket.join(`user_${cleanId}`);
                console.log(`👤 Socket ${socket.id} force-joined personal room: user_${cleanId}`);
            }
        });

        // 3. Real-Time Instant Messaging (User <-> Astrologer)
        // Canonical inbound event: "send_message"  →  canonical outbound event: "receive_message"
        // Do NOT register additional aliases (send_chat_message, etc.) that call this same handler,
        // as each additional listener would create a second ChatMessage document and a second delivery.
        const handleSendMessageSocket = async (data) => {
            try {
                const sessionId = extractSessionId(data);
                const senderId = data ? (data.senderId || data.userId || data.astrologerId) : null;
                const senderType = data ? data.senderType : null;
                const messageType = (data && data.messageType) || "text";
                const text = data ? data.text : "";
                const mediaUrl = data ? data.mediaUrl : null;
                const clientMessageId = data ? (data.clientMessageId || data.tempId || data.clientMsgId) : null;

                // Only require sessionId and content (senderId can be resolved from session)
                if (!sessionId || (!text && !mediaUrl)) {
                    socket.emit("error", { message: "Invalid message payload: missing sessionId or content." });
                    return;
                }

                const mongoose = require("mongoose");
                let session = null;
                if (mongoose.Types.ObjectId.isValid(sessionId)) {
                    // the unified Session is authoritative; the legacy collections are only mirrors
                    session = await require("../models/session.model").findById(sessionId).catch(() => null)
                        || await ChatSession.findById(sessionId).catch(() => null)
                        || await VideoSession.findById(sessionId).catch(() => null);
                }

                let normalizedSenderType = String(senderType || "USER").toUpperCase() === "ASTROLOGER" ? "ASTROLOGER" : "USER";
                let validSenderId = (senderId && mongoose.Types.ObjectId.isValid(senderId)) ? senderId : null;

                if (session) {
                    if (["COMPLETED", "REJECTED", "CANCELLED", "MISSED", "ENDING"].includes(session.status)) {
                        socket.emit("error", { message: "Chat session is no longer active." });
                        return;
                    }

                    const sessionAstro = String(session.astrologer || "");

                    // The sender's side comes from the verified token and the session's participants.
                    // senderType / senderId in the payload are client claims and are ignored
                    // (except for admin sockets, which are not participants of the session).
                    const participantRole = await getParticipantRole(session, socket.decodedUser);
                    if (!participantRole) {
                        socket.emit("error", { message: "You are not a participant of this session." });
                        return;
                    }
                    const isAstroClaim = participantRole === "admin"
                        ? (String(senderType || "").toUpperCase() === "ASTROLOGER" || (senderId && String(senderId) === sessionAstro))
                        : participantRole === "astrologer";

                    if (isAstroClaim) {
                        normalizedSenderType = "ASTROLOGER";
                        validSenderId = session.astrologer;
                    } else {
                        normalizedSenderType = "USER";
                        validSenderId = session.user;
                    }
                } else {
                    validSenderId = validSenderId || new mongoose.Types.ObjectId();
                }

                let newMessage = null;
                if (session) {
                    // Check for existing message with same clientMessageId to ensure idempotency
                    if (clientMessageId) {
                        newMessage = await ChatMessage.findOne({ session: sessionId, clientMessageId }).catch(() => null);
                    }

                    if (!newMessage) {
                        try {
                            newMessage = await ChatMessage.create({
                                session: sessionId,
                                senderId: validSenderId,
                                senderType: normalizedSenderType,
                                messageType,
                                text,
                                mediaUrl,
                                clientMessageId: clientMessageId || null
                            });
                            console.log(`💬 [Chat] Message saved. _id=${newMessage._id} clientMessageId=${clientMessageId} session=${sessionId} senderType=${normalizedSenderType}`);
                        } catch (createErr) {
                            if (createErr.code === 11000 && clientMessageId) {
                                newMessage = await ChatMessage.findOne({ session: sessionId, clientMessageId }).catch(() => null);
                            } else {
                                throw createErr;
                            }
                        }
                    } else {
                        console.log(`♻️ [Chat] Idempotent match found. _id=${newMessage._id} clientMessageId=${clientMessageId}`);
                    }
                } else {
                    // Session not found – create an ephemeral in-memory object so delivery still works.
                    newMessage = {
                        session: sessionId,
                        senderId: validSenderId,
                        senderType: normalizedSenderType,
                        messageType,
                        text,
                        mediaUrl,
                        clientMessageId: clientMessageId || null,
                        _id: new mongoose.Types.ObjectId(),
                        createdAt: new Date()
                    };
                    console.warn(`⚠️ [Chat] No ChatSession found for ${sessionId}. Message NOT persisted.`);
                }

                const cleanSessionId = String(sessionId);
                const formattedMsg = {
                    ...(newMessage.toObject ? newMessage.toObject() : newMessage),
                    session: cleanSessionId,
                    sessionId: cleanSessionId,
                    chatId: cleanSessionId,
                    roomId: cleanSessionId,
                    senderId: String(newMessage.senderId),
                    senderType: normalizedSenderType,
                    messageType: newMessage.messageType || messageType,
                    text: newMessage.text || text || "",
                    mediaUrl: newMessage.mediaUrl || mediaUrl || null,
                    clientMessageId: newMessage.clientMessageId || clientMessageId || null,
                    _id: String(newMessage._id),
                    id: String(newMessage._id),
                    createdAt: newMessage.createdAt || new Date().toISOString()
                };

                // Emit the canonical "receive_message" event ONCE via chained .to() rooms.
                let emitter = io.to(`session_${cleanSessionId}`).to(cleanSessionId);
                if (session) {
                    if (session.user) emitter = emitter.to(`user_${session.user}`);
                    if (session.astrologer) {
                        emitter = emitter.to(`user_${session.astrologer}`);
                        const astro = await Astrologer.findById(session.astrologer).catch(() => null);
                        if (astro) {
                            if (astro.user) emitter = emitter.to(`user_${astro.user}`);
                            if (astro.astrologerLogin) emitter = emitter.to(`user_${astro.astrologerLogin}`);
                        }
                    }
                }
                emitter.emit("receive_message", formattedMsg);

            } catch (error) {
                console.error("Socket send_message error:", error);
                socket.emit("error", { message: "Failed to send message" });
            }
        };

        // Only ONE canonical listener for inbound chat messages.
        // Do NOT add send_chat_message or any other alias here – doing so would cause
        // a second ChatMessage.create() call and a second receive_message delivery.
        socket.on("send_message", handleSendMessageSocket);

        // 4. Typing Indicator Status
        socket.on("typing_status", (data) => {
            const sessionId = extractSessionId(data);
            if (!sessionId) return;
            socket.to(`session_${sessionId}`).emit("user_typing", { 
                senderType: data.senderType, 
                isTyping: Boolean(data.isTyping),
                sessionId,
                _id: sessionId
            });
        });

        // =====================================
        // AUDIO & VIDEO CALL SOCKET EVENTS
        // =====================================

        // 1. Join Audio/Video Call Room
        socket.on("join_call_room", async (data) => {
            const sessionId = extractSessionId(data);
            if (!sessionId) return;

            const cleanId = String(sessionId);
            if (cleanId === String(socket.associatedAstroId) || cleanId === String(socket.associatedUserId)) {
                return;
            }

            socket.join(`session_${cleanId}`);
            socket.join(`call_${cleanId}`);
            socket.join(`chat_${cleanId}`);
            socket.join(`room_${cleanId}`);
            socket.join(cleanId);
            console.log(`📞 Socket ${socket.id} joined call room channels: ${cleanId}`);

            try {
                const Session = require("../models/session.model");
                const session = await Session.findById(cleanId).catch(() => null) || await VideoSession.findById(cleanId).catch(() => null);
                socket.emit("call_state", {
                    session,
                    sessionId: session ? session._id : sessionId
                });
            } catch (err) {
                console.error("Error fetching call session on join:", err);
            }
        });

        // 6. Mute / Camera Toggle State Sync
        socket.on("media_state_change", (data) => {
            const roomId = data.sessionId;
            const payload = {
                sessionId: roomId,
                userId: data.userId,
                isAudioMuted: Boolean(data.isAudioMuted),
                isVideoMuted: Boolean(data.isVideoMuted),
                senderType: data.senderType
            };
            socket.broadcast.to(`session_${roomId}`)
              .to(`call_${roomId}`)
              .to(roomId)
              .emit("media_state_changed", payload);

            socket.broadcast.to(`session_${roomId}`)
              .to(`call_${roomId}`)
              .to(roomId)
              .emit("peer_media_state_changed", payload);
        });

        // Relay video filter and effect updates
        socket.on("video_filter_applied", (data) => {
            if (!data || !data.sessionId) return;
            const roomId = data.sessionId;
            const payload = {
                sessionId: roomId,
                filter: data.filter || 'none',
                effect: data.effect || 'none',
                isLowLightOn: Boolean(data.isLowLightOn),
                senderType: data.senderType || 'USER'
            };
            socket.broadcast.to(`session_${roomId}`)
              .to(`call_${roomId}`)
              .to(roomId)
              .emit("video_filter_applied", payload);
            socket.broadcast.to(`session_${roomId}`)
              .to(`call_${roomId}`)
              .to(roomId)
              .emit("filter_changed", payload);
        });

        socket.on("filter_changed", (data) => {
            if (!data || !data.sessionId) return;
            const roomId = data.sessionId;
            const payload = {
                sessionId: roomId,
                filter: data.filter || 'none',
                effect: data.effect || 'none',
                isLowLightOn: Boolean(data.isLowLightOn),
                senderType: data.senderType || 'USER'
            };
            socket.broadcast.to(`session_${roomId}`)
              .to(`call_${roomId}`)
              .to(roomId)
              .emit("video_filter_applied", payload);
            socket.broadcast.to(`session_${roomId}`)
              .to(`call_${roomId}`)
              .to(roomId)
              .emit("filter_changed", payload);
        });

        // ── Real-time Presence Events ──────────────────────────────────────────

        // Heartbeat from astrologer client to refresh TTL
        socket.on("presence:heartbeat", async () => {
            if (socket.associatedAstroId) {
                const astroId = socket.associatedAstroId;
                const { getPresence, setPresence } = require("../services/presence.service");
                
                try {
                    let presence = await getPresence(astroId);
                    if (!presence) {
                        // Recreate presence if expired but socket is still active
                        const mongoose = require("mongoose");
                        const Astrologer = mongoose.model("Astrologer");
                        const astro = await Astrologer.findById(astroId);
                        const status = (astro && astro.isOnline && !astro.manualOffline) ? "ONLINE" : "OFFLINE";
                        presence = {
                            status: status,
                            connections: 1,
                            lastHeartbeat: Date.now(),
                            activeSessionId: null,
                            timestamp: Date.now(),
                            version: 1
                        };
                        console.log(`♻️ Recreated expired presence for Astrologer ${astro?.name || astroId} on heartbeat (Status: ${status})`);
                    } else {
                        presence.lastHeartbeat = Date.now();
                        if (presence.connections < 1) {
                            presence.connections = 1;
                        }
                    }
                    await setPresence(astroId, presence);
                    socket.emit("presence:heartbeat_acknowledged", { timestamp: Date.now() });
                } catch (err) {
                    console.error(`Failed to handle heartbeat for astro ${astroId}:`, err.message);
                }
            }
        });

        // User client presence subscription
        socket.on("presence:subscribe", async (data) => {
            if (!data) return;
            const astroIds = Array.isArray(data.astrologerIds) ? data.astrologerIds : [data.astrologerId].filter(Boolean);
            
            for (const id of astroIds) {
                socket.join(`astrologer:${id}`);
            }
            console.log(`👤 Socket ${socket.id} subscribed to presence of:`, astroIds);

            // Fetch and send the current presence state of the subscribed astrologers to the client
            try {
                const { getPresence } = require("../services/presence.service");
                const initialPresences = {};
                for (const id of astroIds) {
                    const presence = await getPresence(id);
                    initialPresences[id] = presence ? presence.status : "OFFLINE";
                }
                socket.emit("presence:initial_state", { presences: initialPresences });
            } catch (err) {
                console.error("Error sending initial presence state to user socket:", err.message);
            }
        });

        socket.on("presence:unsubscribe", (data) => {
            if (!data) return;
            const astroIds = Array.isArray(data.astrologerIds) ? data.astrologerIds : [data.astrologerId].filter(Boolean);
            
            for (const id of astroIds) {
                socket.leave(`astrologer:${id}`);
            }
            console.log(`👤 Socket ${socket.id} unsubscribed from presence of:`, astroIds);
        });

        // Manual status update request via socket
        socket.on("presence:status_changed", async (data) => {
            if (socket.associatedAstroId && data && data.status) {
                const { transitionStatus } = require("../services/presence.service");
                try {
                    await transitionStatus(socket.associatedAstroId, data.status);
                } catch (err) {
                    socket.emit("error", { message: err.message });
                }
            }
        });

        // Disconnect Handler
        socket.on("disconnect", async () => {
            console.log(`🔌 Socket Disconnected: ${socket.id}`);

            // Start this participant's grace window if it was their last socket (durable, in MongoDB)
            require("../services/session/handlers").onSocketDisconnected(io, socket).catch((err) => console.error("session disconnect handling error:", err.message));

            if (socket.associatedAstroId) {
                const astroId = socket.associatedAstroId;
                const { getPresence, setPresence, transitionStatus } = require("../services/presence.service");
                
                // Clear any existing disconnect timeout for this astro to reset grace period
                if (disconnectTimeouts.has(astroId)) {
                    clearTimeout(disconnectTimeouts.get(astroId));
                    disconnectTimeouts.delete(astroId);
                }

                try {
                    let presence = await getPresence(astroId);
                    if (presence) {
                        presence.connections = Math.max(0, presence.connections - 1);
                        await setPresence(astroId, presence);

                        if (presence.connections === 0) {
                            const gracePeriod = (parseInt(process.env.PRESENCE_DISCONNECT_GRACE_PERIOD) || 5) * 1000;
                            console.log(`⏳ Astrologer connections reached 0. Starting disconnect grace period of ${gracePeriod / 1000}s for: ${astroId}`);
                            
                            const timeoutId = setTimeout(async () => {
                                disconnectTimeouts.delete(astroId);
                                try {
                                    const freshPresence = await getPresence(astroId);
                                    // Only transition if connections are still 0
                                    if (!freshPresence || freshPresence.connections === 0) {
                                        await transitionStatus(astroId, "OFFLINE");
                                    }
                                } catch (err) {
                                    console.error("Error transitioning offline in disconnect grace period:", err.message);
                                }
                            }, gracePeriod);

                            disconnectTimeouts.set(astroId, timeoutId);
                        }
                    }
                } catch (err) {
                    console.error("Error decrementing connections on disconnect:", err.message);
                }
            }
        });
    });

    return io;
};

const getIO = () => {
    if (!io) {
        throw new Error("Socket.io not initialized!");
    }
    return io;
};

module.exports = {
    initSocket,
    getIO,
    cleanupStaleSessions,
    broadcastSessionEnded
};
