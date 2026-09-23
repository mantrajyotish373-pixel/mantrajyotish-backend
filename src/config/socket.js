const formatDate = (dateVal) => {
    if (!dateVal) return "Not Specified";
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
};

const { Server } = require("socket.io");
const ChatSession = require("../models/chatSession.model");
const ChatMessage = require("../models/chatMessage.model");
const VideoSession = require("../models/videoSession.model");
const User = require("../models/user.model");
const Astrologer = require("../models/astro.model");
const { startBillingTimer, stopBillingTimer, pauseChatBilling, resumeChatBilling } = require("../services/chatBilling.service");
const { startCallBillingTimer, stopCallBillingTimer, pauseCallBilling, resumeCallBilling } = require("../services/callBilling.service");
const videoSessionService = require("../services/videoSession.service");

let io;
const disconnectTimeouts = new Map();
const sessionDisconnectTimeouts = new Map();

const extractSessionId = (data) => {
    if (!data) return null;
    let idStr = null;
    if (typeof data === "string") {
        idStr = data;
    } else {
        idStr = data.sessionId || data.chatId || data.callId || data._id || data.id || (data.session && (data.session._id || data.session.id));
    }
    if (!idStr || typeof idStr !== "string") return null;

    let cleanId = idStr;
    if (idStr.startsWith("call_")) cleanId = idStr.replace("call_", "");
    if (idStr.startsWith("session_")) cleanId = idStr.replace("session_", "");

    if (/^[0-9a-fA-F]{24}$/.test(cleanId)) {
        return cleanId;
    }
    return null;
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

const cleanupStaleSessions = async (astrologerId) => {
    try {
        const ChatSession = require("../models/chatSession.model");
        const VideoSession = require("../models/videoSession.model");
        const { endChatSession } = require("../services/chatBilling.service");
        const { endCallSession } = require("../services/videoSession.service");

        // Consider sessions older than 30 minutes as stale
        const staleTime = new Date(Date.now() - 30 * 60 * 1000);

        const staleChats = await ChatSession.find({
            astrologer: astrologerId,
            status: { $in: ["ACTIVE", "PENDING"] },
            createdAt: { $lt: staleTime }
        });

        for (const session of staleChats) {
            console.log(`🧹 Auto-ending stale chat session ${session._id} for astrologer ${astrologerId}`);
            await endChatSession(session._id).catch(err => console.error("Error auto-ending stale chat:", err));
        }

        const staleCalls = await VideoSession.find({
            astrologer: astrologerId,
            status: { $in: ["ACTIVE", "PENDING"] },
            createdAt: { $lt: staleTime }
        });

        for (const session of staleCalls) {
            console.log(`🧹 Auto-ending stale call session ${session._id} for astrologer ${astrologerId}`);
            await endCallSession(session._id).catch(err => console.error("Error auto-ending stale call:", err));
        }
    } catch (err) {
        console.error("Failed to run cleanupStaleSessions:", err);
    }
};

const findUserByIdOrRef = async (id) => {
    if (!id) return null;
    const mongoose = require("mongoose");
    let user = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
        user = await User.findById(id);
    }
    if (!user) {
        user = await User.findOne({
            $or: [
                { phone: id },
                { phone: "+91" + String(id).replace(/\D/g, "") },
                { uniqueId: id },
                { userLogin: id },
                { email: id }
            ]
        });
    }
    return user;
};

const findAstrologerByIdOrRef = async (id) => {
    if (!id) return null;
    const mongoose = require("mongoose");
    let astro = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
        astro = await Astrologer.findById(id);
    }
    if (!astro) {
        astro = await Astrologer.findOne({
            $or: [{ user: id }, { astrologerLogin: id }, { email: id }]
        });
    }
    if (!astro) {
        astro = await Astrologer.findOne({ isApproved: true }) || await Astrologer.findOne();
    }
    return astro;
};

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

    // Authenticate socket connections using JWT
    io.use((socket, next) => {
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;
        if (token) {
            try {
                const { verifyToken } = require("../utils/jwt");
                const decoded = verifyToken(token);
                socket.decodedUser = decoded;
            } catch (err) {
                console.error("Socket JWT Authentication Failure:", err.message);
                return next(new Error("Authentication error: Invalid or expired token."));
            }
        }
        next();
    });

    io.on("connection", (socket) => {
        console.log(`🔌 New Socket Connection Established: ${socket.id}`);

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

        // 1. Initiate Chat Request via Socket
        const handleChatRequest = async (data) => {
            try {
                const userId = data ? (data.userId || data.user) : null;
                const astrologerId = data ? (data.astrologerId || data.astrologer) : null;

                if (!userId || !astrologerId) {
                    socket.emit("error", { message: "userId and astrologerId are required." });
                    return;
                }

                const userObj = await findUserByIdOrRef(userId);
                if (!userObj) {
                    socket.emit("error", { message: `User not found for ID: ${userId}` });
                    return;
                }

                const astroObj = await findAstrologerByIdOrRef(astrologerId);
                if (!astroObj) {
                    socket.emit("error", { message: `Astrologer not found for ID: ${astrologerId}` });
                    return;
                }

                if (astroObj.status !== "approved") {
                    socket.emit("error", { message: "Astrologer is not approved to take consultations yet." });
                    return;
                }

                if (!astroObj.isOnline) {
                    socket.emit("error", { message: "Astrologer is currently offline." });
                    return;
                }

                if (!astroObj.isAvailable) {
                    socket.emit("error", { message: "Astrologer is busy with another consultation." });
                    return;
                }

                // Check if there is currently a PENDING chat request to prioritize based on wallet balance
                const pendingSession = await ChatSession.findOne({
                    astrologer: astroObj._id,
                    status: "PENDING"
                }).populate("user");

                if (pendingSession) {
                    const existingUser = pendingSession.user;
                    const existingWallet = existingUser ? (existingUser.walletBalance || 0) : 0;
                    const newWallet = userObj.walletBalance || 0;

                    if (newWallet > existingWallet) {
                        // Cancel the existing pending session
                        pendingSession.status = "CANCELLED";
                        pendingSession.rejectionReason = "Prioritized chat with higher wallet balance.";
                        await pendingSession.save();

                        // Notify the previous user via socket
                        try {
                            const cancelPayload = {
                                sessionId: pendingSession._id,
                                status: "CANCELLED",
                                message: "Your chat request was cancelled because another user with a higher wallet balance requested a consultation."
                            };
                            io.to(`session_${pendingSession._id}`).emit("chat_ended", cancelPayload);
                            if (pendingSession.user) {
                                io.to(`user_${pendingSession.user._id}`).emit("chat_ended", cancelPayload);
                            }
                        } catch (socketErr) {
                            console.error("Failed to emit chat_ended for replaced session:", socketErr.message);
                        }
                        console.log(`🔄 Prioritized chat: Replaced pending chat session ${pendingSession._id} (User balance: ₹${existingWallet}) with new request from User ${userObj._id} (User balance: ₹${newWallet})`);
                    } else {
                        socket.emit("error", { message: "Astrologer is currently receiving another chat request. Please try again in a moment." });
                        return;
                    }
                }

                const perMinuteRate = 9; // Flat 9 Rupees per minute
                const minBalanceRequired = perMinuteRate * 2;

                if ((userObj.walletBalance || 0) < minBalanceRequired) {
                    socket.emit("error", {
                        message: `Insufficient wallet balance. Minimum ₹${minBalanceRequired} (2 mins) required to initiate chat. Current Balance: ₹${userObj.walletBalance || 0}`
                    });
                    return;
                }

                let session = await ChatSession.findOne({
                    user: userObj._id,
                    astrologer: astroObj._id,
                    status: { $in: ["PENDING", "ACTIVE"] }
                });

                if (!session) {
                    session = await ChatSession.create({
                        user: userObj._id,
                        astrologer: astroObj._id,
                        perMinuteRate,
                        status: "PENDING"
                    });
                }

                const incomingName = data ? (data.name || data.userName || data.fullName || (data.user && (data.user.name || data.user.userName))) : null;
                const dbName = userObj.name || `${userObj.firstname || ""} ${userObj.lastname || ""}`.trim() || userObj.username;
                const resolvedName = (incomingName && typeof incomingName === "string" && incomingName.trim())
                    ? incomingName.trim()
                    : (dbName || (userObj.phone ? `User (${userObj.phone})` : "Client User"));

                if (incomingName && (!userObj.name || userObj.name === "Client User")) {
                    userObj.name = incomingName;
                    await userObj.save().catch(() => null);
                }

                const userDetails = {
                    _id: userObj._id,
                    id: userObj._id,
                    name: resolvedName,
                    firstname: userObj.firstname || resolvedName.split(" ")[0],
                    lastname: userObj.lastname || resolvedName.split(" ").slice(1).join(" "),
                    phone: userObj.phone || "",
                    email: userObj.email || "",
                    avatar: userObj.profileImage || userObj.avatar || "",
                    profileImage: userObj.profileImage || userObj.avatar || "",
                    dob: userObj.dateofbirth ? formatDate(userObj.dateofbirth) : (userObj.dob || "Not Specified"),
                    tob: userObj.timeofbirth || userObj.tob || "Not Specified",
                    pob: userObj.placeofbirth || userObj.pob || "Not Specified",
                    gender: userObj.gender || "Not Specified"
                };

                const responseData = {
                    ...session.toObject(),
                    user: userDetails,
                    sessionId: session._id,
                    chatId: session._id,
                    _id: session._id,
                    id: session._id
                };

                socket.join(`session_${session._id}`);

                const payload = {
                    message: "New incoming chat request!",
                    session: responseData,
                    sessionId: session._id,
                    _id: session._id,
                    user: userDetails,
                    sound: "ringtone.mp3",
                    ringtoneUrl: "/public/sounds/ringtone.mp3",
                    ringtoneDuration: 30,
                    playRingtone: true
                };

                io.to(`user_${astroObj._id}`).emit("incoming_chat_request", payload);
                if (astroObj.user) io.to(`user_${astroObj.user}`).emit("incoming_chat_request", payload);
                if (astroObj.astrologerLogin) io.to(`user_${astroObj.astrologerLogin}`).emit("incoming_chat_request", payload);
                io.to(`session_${session._id}`).emit("incoming_chat_request", payload);

                socket.emit("chat_request_created", {
                    success: true,
                    message: "Chat request initiated successfully.",
                    session: responseData
                });

            } catch (err) {
                console.error("handleChatRequest error:", err);
                socket.emit("error", { message: err.message || "Failed to initiate chat request." });
            }
        };

        socket.on("request_chat", handleChatRequest);
        socket.on("initiate_chat", handleChatRequest);

        // 2. Join Chat Session Room
        const handleJoinRoom = async (data) => {
            const sessionId = extractSessionId(data);
            if (!sessionId) return;

            const cleanId = String(sessionId);
            if (cleanId === String(socket.associatedAstroId) || cleanId === String(socket.associatedUserId)) {
                return;
            }
            socket.activeSessionId = cleanId;
            if (sessionDisconnectTimeouts.has(cleanId)) {
                clearTimeout(sessionDisconnectTimeouts.get(cleanId));
                sessionDisconnectTimeouts.delete(cleanId);
                console.log(`🔌 Restored active chat session ${cleanId} (reconnect within grace period)`);
            }

            socket.join(`session_${cleanId}`);
            socket.join(cleanId);
            socket.join(`chat_${cleanId}`);
            socket.join(`room_${cleanId}`);
            console.log(`👤 Socket ${socket.id} joined chat room channels for session: ${cleanId}`);

            try {
                const mongoose = require("mongoose");
                if (mongoose.Types.ObjectId.isValid(cleanId)) {
                    const session = await ChatSession.findById(cleanId).catch(() => null);
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

                // Only require sessionId and content (senderId can be resolved from session)
                if (!sessionId || (!text && !mediaUrl)) {
                    socket.emit("error", { message: "Invalid message payload: missing sessionId or content." });
                    return;
                }

                const mongoose = require("mongoose");
                let session = null;
                if (mongoose.Types.ObjectId.isValid(sessionId)) {
                    session = await ChatSession.findById(sessionId).catch(() => null);
                    if (!session) {
                        session = await VideoSession.findById(sessionId).catch(() => null);
                    }
                }

                const normalizedSenderType = String(senderType || "USER").toUpperCase() === "ASTROLOGER" ? "ASTROLOGER" : "USER";

                const validSenderId = (senderId && mongoose.Types.ObjectId.isValid(senderId))
                    ? senderId
                    : (session ? (normalizedSenderType === "ASTROLOGER" ? session.astrologer : session.user) : new mongoose.Types.ObjectId());

                let newMessage;
                if (session) {
                    // Each call creates a new ChatMessage document with its own unique MongoDB _id.
                    // Identical text is intentionally allowed – no deduplication on content.
                    newMessage = await ChatMessage.create({
                        session: sessionId,
                        senderId: validSenderId,
                        senderType: normalizedSenderType,
                        messageType,
                        text,
                        mediaUrl
                    });
                    console.log(`💬 [Chat] Message saved. _id=${newMessage._id} session=${sessionId} senderType=${normalizedSenderType}`);
                } else {
                    // Session not found – create an ephemeral in-memory object so delivery still works.
                    // This message is NOT persisted to the database.
                    newMessage = {
                        session: sessionId,
                        senderId: validSenderId,
                        senderType: normalizedSenderType,
                        messageType,
                        text,
                        mediaUrl,
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
                    senderType: normalizedSenderType,
                    _id: String(newMessage._id),
                    id: String(newMessage._id)
                };

                // Emit the canonical "receive_message" event ONCE via chained .to() rooms.
                // Socket.io v4 automatically deduplicates sockets that are in multiple matched rooms,
                // so each connected client receives exactly one copy of this event.
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

        // 5. Astrologer Accepts Chat Request
        socket.on("accept_chat_request", async (data) => {
            try {
                const sessionId = extractSessionId(data);
                if (!sessionId) return;

                const session = await ChatSession.findById(sessionId);
                if (!session || session.status !== "PENDING") {
                    socket.emit("error", { message: "Session is no longer pending or not found." });
                    return;
                }

                session.status = "ACTIVE";
                session.startTime = new Date();
                await session.save();

                // Transition status atomically to BUSY
                try {
                    const { transitionStatus } = require("../services/presence.service");
                    await transitionStatus(session.astrologer, "BUSY", session._id);
                } catch (err) {
                    console.error("Failed to transition presence status to BUSY in Socket accept_chat_request:", err.message);
                }

                startBillingTimer(sessionId, io);

                const responsePayload = {
                    success: true,
                    message: "Astrologer accepted chat request. Live session started!",
                    session,
                    sessionId: session._id,
                    _id: session._id,
                    id: session._id
                };

                io.to(`session_${sessionId}`).emit("chat_accepted", responsePayload);
                io.to(`user_${session.user}`).emit("chat_accepted", responsePayload);
            } catch (err) {
                console.error("accept_chat_request socket error:", err);
            }
        });

        // 6. Astrologer Rejects Chat Request
        socket.on("reject_chat_request", async (data) => {
            try {
                const sessionId = extractSessionId(data);
                if (!sessionId) return;

                const session = await ChatSession.findById(sessionId);
                if (session) {
                    session.status = "REJECTED";
                    session.rejectionReason = data.reason || "Astrologer unavailable";
                    await session.save();

                    const responsePayload = {
                        success: false,
                        message: "Astrologer rejected chat request.",
                        reason: session.rejectionReason,
                        session,
                        sessionId: session._id,
                        _id: session._id
                    };

                    io.to(`session_${sessionId}`).emit("chat_rejected", responsePayload);
                    io.to(`user_${session.user}`).emit("chat_rejected", responsePayload);
                }
            } catch (err) {
                console.error("reject_chat_request socket error:", err);
            }
        });

        socket.on("end_chat_session", async (data) => {
            try {
                const sessionId = extractSessionId(data);
                if (!sessionId) return;

                const { endChatSession } = require("../services/chatBilling.service");
                const session = await endChatSession(sessionId);

                io.to(`session_${sessionId}`).emit("chat_ended", {
                    success: true,
                    message: "Chat session ended successfully.",
                    session,
                    sessionId: session._id,
                    _id: session._id
                });
            } catch (err) {
                console.error("end_chat_session socket error:", err);
            }
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
            socket.activeSessionId = cleanId;
            if (sessionDisconnectTimeouts.has(cleanId)) {
                clearTimeout(sessionDisconnectTimeouts.get(cleanId));
                sessionDisconnectTimeouts.delete(cleanId);
                console.log(`🔌 Restored active call session ${cleanId} (reconnect within grace period)`);
            }

            const roomName = `call_${cleanId}`;
            socket.join(roomName);
            console.log(`📞 Socket ${socket.id} joined call room: ${roomName}`);

            try {
                const session = await VideoSession.findById(sessionId);
                socket.emit("call_state", {
                    session,
                    sessionId: session ? session._id : sessionId
                });
            } catch (err) {
                console.error("Error fetching call session on join:", err);
            }
        });

        // 2. User Requests Audio or Video Call
        socket.on("request_call", async (data) => {
            try {
                const userId = data ? (data.userId || data.user) : null;
                const astrologerId = data ? (data.astrologerId || data.astrologer) : null;
                const callType = (data && data.callType) ? data.callType : "VIDEO";

                if (!userId || !astrologerId) {
                    socket.emit("error", { message: "Invalid payload: missing userId or astrologerId." });
                    return;
                }

                const session = await videoSessionService.requestCallSession({
                    userId,
                    astrologerId,
                    callType
                });

                socket.join(`call_${session._id}`);

                // Build flattened user details for IncomingCallModal
                const sessionUserObj = session.user && typeof session.user === "object" ? session.user : {};
                const resolvedUserName = sessionUserObj.name ||
                    `${sessionUserObj.firstname || ""} ${sessionUserObj.lastname || ""}`.trim() ||
                    (sessionUserObj.phone ? `User (${sessionUserObj.phone})` : "Client");

                const flatUser = {
                    _id: sessionUserObj._id || sessionUserObj.id || userId,
                    id: sessionUserObj._id || sessionUserObj.id || userId,
                    name: resolvedUserName,
                    firstname: sessionUserObj.firstname || "",
                    lastname: sessionUserObj.lastname || "",
                    phone: sessionUserObj.phone || "",
                    avatar: sessionUserObj.profileImage || sessionUserObj.avatar || "",
                    profileImage: sessionUserObj.profileImage || sessionUserObj.avatar || "",
                    dob: sessionUserObj.dateofbirth ? formatDate(sessionUserObj.dateofbirth) : (sessionUserObj.dob || "Not Specified"),
                    tob: sessionUserObj.timeofbirth || sessionUserObj.tob || "Not Specified",
                    pob: sessionUserObj.placeofbirth || sessionUserObj.pob || "Not Specified",
                };

                const payload = {
                    sessionId: session._id,
                    callId: session._id,
                    callType: session.callType,
                    user: flatUser,
                    astrologer: session.astrologer,
                    perMinuteRate: session.perMinuteRate,
                    channelName: session.channelName,
                    sound: "ringtone.mp3",
                    ringtoneUrl: "/public/sounds/ringtone.mp3",
                    ringtoneDuration: 30,
                    playRingtone: true
                };

                const astroObj = await findAstrologerByIdOrRef(astrologerId);
                const targetRooms = new Set();
                targetRooms.add(`user_${astrologerId}`);
                targetRooms.add(`astro_${astrologerId}`);
                targetRooms.add(`astrologer_${astrologerId}`);
                targetRooms.add(String(astrologerId));

                if (astroObj) {
                    if (astroObj._id) {
                        targetRooms.add(`user_${astroObj._id}`);
                        targetRooms.add(`astro_${astroObj._id}`);
                        targetRooms.add(String(astroObj._id));
                    }
                    if (astroObj.user) {
                        targetRooms.add(`user_${astroObj.user}`);
                        targetRooms.add(`astro_${astroObj.user}`);
                        targetRooms.add(String(astroObj.user));
                    }
                    if (astroObj.astrologerLogin) {
                        targetRooms.add(`user_${astroObj.astrologerLogin}`);
                        targetRooms.add(String(astroObj.astrologerLogin));
                    }
                }

                targetRooms.forEach(room => {
                    io.to(room).emit("incoming_call_request", payload);
                });

                io.to(`call_${session._id}`).emit("incoming_call_request", payload);
                // Removed global broadcast for privacy. Only targeted astrologer receives this.

                socket.emit("call_request_sent", {
                    success: true,
                    message: "Call request sent to astrologer. Waiting for response...",
                    session
                });

            } catch (error) {
                console.error("request_call socket error:", error);
                socket.emit("error", { message: error.message || "Failed to initiate call request." });
            }
        });

        // 3. Astrologer Accepts Call Request
        socket.on("accept_call_request", async (data) => {
            try {
                const sessionId = extractSessionId(data);
                if (!sessionId) return;

                const result = await videoSessionService.acceptCallSession(sessionId);

                socket.join(`call_${sessionId}`);
                socket.activeSessionId = String(sessionId);

                startCallBillingTimer(sessionId, io);

                // Safely extract user ID whether session.user is populated object or plain ID string
                const rawUser = result.session.user;
                const userIdForRoom = (rawUser && typeof rawUser === "object")
                    ? String(rawUser._id || rawUser.id || "")
                    : String(rawUser || "");

                const responsePayload = {
                    success: true,
                    message: "Call request accepted! Agora RTC token generated.",
                    sessionId: result.session._id,
                    callType: result.session.callType,
                    channelName: result.session.channelName || result.agora.channelName,
                    agora: result.agora,
                    appId: result.agora.appId,
                    token: result.agora.token,
                    session: result.session
                };

                io.to(`call_${sessionId}`).emit("call_accepted", responsePayload);
                if (userIdForRoom) io.to(`user_${userIdForRoom}`).emit("call_accepted", responsePayload);

            } catch (err) {
                console.error("accept_call_request socket error:", err);
                socket.emit("error", { message: err.message || "Failed to accept call request." });
            }
        });

        // 4. Astrologer Rejects Call Request
        socket.on("reject_call_request", async (data) => {
            try {
                const sessionId = extractSessionId(data);
                if (!sessionId) return;

                const reason = data ? (data.reason || "Astrologer busy") : "Astrologer busy";
                const session = await videoSessionService.rejectCallSession(sessionId, reason);

                // Safely extract user ID whether session.user is populated object or plain ID
                const rawUser = session.user;
                const userIdForRoom = (rawUser && typeof rawUser === "object")
                    ? String(rawUser._id || rawUser.id || "")
                    : String(rawUser || "");

                const responsePayload = {
                    success: false,
                    message: "Call request was rejected.",
                    reason: session.rejectionReason,
                    session
                };

                io.to(`call_${sessionId}`).emit("call_rejected", responsePayload);
                if (userIdForRoom) io.to(`user_${userIdForRoom}`).emit("call_rejected", responsePayload);

            } catch (err) {
                console.error("reject_call_request socket error:", err);
            }
        });

        // 5. End Audio/Video Call Session
        socket.on("end_call_session", async (data) => {
            try {
                const sessionId = extractSessionId(data);
                if (!sessionId) return;

                stopCallBillingTimer(sessionId);
                const session = await videoSessionService.endCallSession(sessionId);

                const payload = {
                    success: true,
                    message: "Call session ended successfully.",
                    session
                };

                io.to(`call_${sessionId}`).emit("call_ended", payload);

                // Safely broadcast to individual user and astrologer personal rooms
                const rawUser = session.user;
                const userId = (rawUser && typeof rawUser === "object")
                    ? String(rawUser._id || rawUser.id || "")
                    : String(rawUser || "");

                const rawAstro = session.astrologer;
                const astroId = (rawAstro && typeof rawAstro === "object")
                    ? String(rawAstro._id || rawAstro.id || "")
                    : String(rawAstro || "");

                if (userId) {
                    io.to(`user_${userId}`).emit("call_ended", payload);
                    io.to(userId).emit("call_ended", payload);
                }
                if (astroId) {
                    io.to(`user_${astroId}`).emit("call_ended", payload);
                    io.to(`astro_${astroId}`).emit("call_ended", payload);
                    io.to(`astrologer_${astroId}`).emit("call_ended", payload);
                    io.to(astroId).emit("call_ended", payload);
                }

            } catch (err) {
                console.error("end_call_session socket error:", err);
            }
        });

        // Billing Pause & Resume handlers (triggered when user goes to recharge wallet)
        socket.on("pause_session_billing", async (data) => {
            try {
                const sessionId = extractSessionId(data);
                if (!sessionId) return;

                console.log(`⏸️ Pause requested for session: ${sessionId}`);
                // Try call billing first, then chat billing
                await pauseCallBilling(sessionId, io);
                await pauseChatBilling(sessionId, io);
            } catch (err) {
                console.error("Error in pause_session_billing event:", err.message);
            }
        });

        socket.on("resume_session_billing", async (data) => {
            try {
                const sessionId = extractSessionId(data);
                if (!sessionId) return;

                console.log(`▶️ Resume requested for session: ${sessionId}`);
                // Try call billing first, then chat billing
                await resumeCallBilling(sessionId, io);
                await resumeChatBilling(sessionId, io);
            } catch (err) {
                console.error("Error in resume_session_billing event:", err.message);
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

            if (socket.activeSessionId) {
                const sessionId = socket.activeSessionId;

                if (sessionDisconnectTimeouts.has(sessionId)) {
                    clearTimeout(sessionDisconnectTimeouts.get(sessionId));
                    sessionDisconnectTimeouts.delete(sessionId);
                }

                const gracePeriod = 120000; // 120 seconds (2 minutes) grace period to accommodate mobile phone locking & app switching
                console.log(`⏳ Session connection lost. Starting grace period of 120s for session ${sessionId}`);

                const timeoutId = setTimeout(async () => {
                    sessionDisconnectTimeouts.delete(sessionId);
                    try {
                        const VideoSession = require("../models/videoSession.model");
                        const ChatSession = require("../models/chatSession.model");
                        const { endCallSession } = require("../services/videoSession.service");
                        const { endChatSession } = require("../services/chatBilling.service");

                        const videoSession = await VideoSession.findById(sessionId);
                        if (videoSession && videoSession.status === "ACTIVE") {
                            console.log(`🔌 Disconnect Grace Period Expired: Auto-ending call session ${sessionId}`);
                            stopCallBillingTimer(sessionId);
                            await endCallSession(sessionId);
                        } else {
                            const chatSession = await ChatSession.findById(sessionId);
                            if (chatSession && chatSession.status === "ACTIVE") {
                                console.log(`🔌 Disconnect Grace Period Expired: Auto-ending chat session ${sessionId}`);
                                stopBillingTimer(sessionId);
                                await endChatSession(sessionId);
                            }
                        }
                    } catch (err) {
                        console.error("Error in session disconnect timeout handler:", err.message);
                    }
                }, gracePeriod);

                sessionDisconnectTimeouts.set(sessionId, timeoutId);
            }

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
    cleanupStaleSessions
};
