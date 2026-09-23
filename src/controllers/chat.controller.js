const ChatSession = require("../models/chatSession.model");
const ChatMessage = require("../models/chatMessage.model");
const User = require("../models/user.model");
const Astrologer = require("../models/astro.model");
const VideoSession = require("../models/videoSession.model");
const { startBillingTimer, stopBillingTimer } = require("../services/chatBilling.service");

const getSessionIdFromBodyOrParams = (req) => {
    const body = req.body || {};
    const params = req.params || {};
    const query = req.query || {};

    return body.sessionId || body.chatId || body._id || body.id ||
           params.sessionId || params.id ||
           query.sessionId || query.chatId || query.id || null;
};

/**
 * Helper to resolve User document even if UserLogin ID or User ID is passed
 */
const findUserByIdOrRef = async (id) => {
    if (!id) return null;
    let user = await User.findById(id);
    if (!user) {
        user = await User.findOne({ userLogin: id });
    }
    return user;
};

/**
 * Helper to resolve Astrologer document even if User ID or AstrologerLogin ID is passed
 */
const findAstrologerByIdOrRef = async (id) => {
    if (!id) return null;
    let astro = await Astrologer.findById(id);
    if (!astro) {
        astro = await Astrologer.findOne({
            $or: [{ user: id }, { astrologerLogin: id }]
        });
    }
    return astro;
};

/**
 * 1. Initiate Chat Request (User side)
 */
exports.initiateChat = async (req, res, next) => {
    try {
        const { userId, astrologerId } = req.body;
        const currentUserId = userId || (req.user ? req.user.id || req.user._id : null);

        if (!currentUserId || !astrologerId) {
            return res.status(400).json({
                success: false,
                message: "userId and astrologerId are required."
            });
        }

        const user = await findUserByIdOrRef(currentUserId);
        if (!user) {
            return res.status(404).json({
                success: false,
                message: `User not found for ID: ${currentUserId}`
            });
        }

        const astrologer = await findAstrologerByIdOrRef(astrologerId);
        if (!astrologer) {
            return res.status(404).json({
                success: false,
                message: `Astrologer not found for ID: ${astrologerId}`
            });
        }

        if (astrologer.status !== "approved") {
            return res.status(403).json({
                success: false,
                message: "Astrologer is not approved to accept chat consultations yet."
            });
        }

        if (!astrologer.isOnline) {
            return res.status(400).json({
                success: false,
                message: "Astrologer is currently offline."
            });
        }

        if (!astrologer.isAvailable) {
            return res.status(400).json({
                success: false,
                message: "Astrologer is busy with another consultation."
            });
        }

        const perMinuteRate = 9; // Flat 9 Rupees per minute
        const minBalanceRequired = perMinuteRate * 2;

        if ((user.walletBalance || 0) < minBalanceRequired) {
            return res.status(400).json({
                success: false,
                message: `Insufficient wallet balance. Minimum ₹${minBalanceRequired} (2 mins) required to initiate chat. Current Balance: ₹${user.walletBalance || 0}`
            });
        }

        let session = await ChatSession.findOne({
            user: user._id,
            astrologer: astrologer._id,
            status: { $in: ["PENDING", "ACTIVE"] }
        });

        if (!session) {
            session = await ChatSession.create({
                user: user._id,
                astrologer: astrologer._id,
                perMinuteRate,
                status: "PENDING"
            });
        }

        const incomingName = req.body.name || req.body.userName || req.body.fullName || (req.body.user && (req.body.user.name || req.body.user.userName));
        const dbName = user.name || `${user.firstname || ""} ${user.lastname || ""}`.trim() || user.username;
        const resolvedName = (incomingName && typeof incomingName === "string" && incomingName.trim())
            ? incomingName.trim()
            : (dbName || (user.phone ? `User (${user.phone})` : "Client User"));

        if (incomingName && (!user.name || user.name === "Client User")) {
            user.name = incomingName;
            await user.save().catch(() => null);
        }

        const formatDate = (dateVal) => {
            if (!dateVal) return "Not Specified";
            const d = new Date(dateVal);
            if (isNaN(d.getTime())) return String(dateVal);
            const day = String(d.getDate()).padStart(2, "0");
            const month = String(d.getMonth() + 1).padStart(2, "0");
            const year = d.getFullYear();
            return `${day}/${month}/${year}`;
        };

        const userDetails = {
            _id: user._id,
            id: user._id,
            name: resolvedName,
            firstname: user.firstname || resolvedName.split(" ")[0],
            lastname: user.lastname || resolvedName.split(" ").slice(1).join(" "),
            phone: user.phone || "",
            email: user.email || "",
            profileImage: user.profileImage || user.avatar || "",
            dob: user.dateofbirth ? formatDate(user.dateofbirth) : (user.dob || "Not Specified"),
            tob: user.timeofbirth || user.tob || "Not Specified",
            pob: user.placeofbirth || user.pob || "Not Specified",
            gender: user.gender || "Not Specified"
        };

        const responseData = {
            ...session.toObject(),
            user: userDetails,
            sessionId: session._id,
            chatId: session._id,
            _id: session._id,
            id: session._id
        };

        // Broadcast to astrologer socket personal rooms & session room
        try {
            const { getIO } = require("../config/socket");
            const io = getIO();
            if (io) {
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
                
                // Broadcast to Astrologer document ID, User ID, and AstrologerLogin ID rooms
                io.to(`user_${astrologer._id}`).emit("incoming_chat_request", payload);
                if (astrologer.user) io.to(`user_${astrologer.user}`).emit("incoming_chat_request", payload);
                if (astrologer.astrologerLogin) io.to(`user_${astrologer.astrologerLogin}`).emit("incoming_chat_request", payload);
                io.to(`session_${session._id}`).emit("incoming_chat_request", payload);
            }
        } catch (e) {
            console.error("Socket emit error on initiateChat:", e);
        }

        return res.status(201).json({
            success: true,
            message: "Chat request initiated successfully. Waiting for astrologer acceptance.",
            data: responseData
        });

    } catch (error) {
        console.error("initiateChat Error:", error);
        next(error);
    }
};

/**
 * 2. Accept Chat Request (Astrologer side)
 */
exports.acceptChat = async (req, res, next) => {
    try {
        const sessionId = getSessionIdFromBodyOrParams(req);

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                message: "sessionId (or chatId / _id / id) is required."
            });
        }

        const session = await ChatSession.findById(sessionId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: "Chat session not found."
            });
        }

        if (session.status !== "PENDING" && session.status !== "ACTIVE") {
            return res.status(400).json({
                success: false,
                message: `Session is currently '${session.status}', cannot accept.`
            });
        }

        session.status = "ACTIVE";
        if (!session.startTime) session.startTime = new Date();
        await session.save();

        // Transition status atomically to BUSY
        try {
            const { transitionStatus } = require("../services/presence.service");
            await transitionStatus(session.astrologer, "BUSY", session._id);
        } catch (err) {
            console.error("Failed to transition presence status to BUSY in REST acceptChat:", err.message);
        }

        // Start per-minute billing recurring timer
        try {
            const { getIO } = require("../config/socket");
            const io = getIO();
            startBillingTimer(sessionId, io);

            if (io) {
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
            }
        } catch (e) {
            startBillingTimer(sessionId, null);
        }

        const responseData = {
            ...session.toObject(),
            sessionId: session._id,
            chatId: session._id,
            _id: session._id,
            id: session._id
        };

        return res.status(200).json({
            success: true,
            message: "Chat request accepted. Session is now ACTIVE.",
            data: responseData
        });

    } catch (error) {
        next(error);
    }
};

/**
 * 3. Reject Chat Request (Astrologer side)
 */
exports.rejectChat = async (req, res, next) => {
    try {
        const sessionId = getSessionIdFromBodyOrParams(req);

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                message: "sessionId (or chatId / _id / id) is required."
            });
        }

        const session = await ChatSession.findById(sessionId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: "Chat session not found."
            });
        }

        session.status = "REJECTED";
        session.rejectionReason = req.body.reason || "Astrologer rejected the request.";
        await session.save();

        try {
            const { getIO } = require("../config/socket");
            const io = getIO();
            if (io) {
                const payload = {
                    success: false,
                    message: "Astrologer rejected chat request.",
                    reason: session.rejectionReason,
                    session,
                    sessionId: session._id,
                    _id: session._id
                };
                io.to(`session_${sessionId}`).emit("chat_rejected", payload);
                io.to(`user_${session.user}`).emit("chat_rejected", payload);
            }
        } catch (e) {}

        const responseData = {
            ...session.toObject(),
            sessionId: session._id,
            chatId: session._id,
            _id: session._id,
            id: session._id
        };

        return res.status(200).json({
            success: true,
            message: "Chat request rejected successfully.",
            data: responseData
        });

    } catch (error) {
        next(error);
    }
};

/**
 * 4. End Active Chat Session
 */
exports.endChat = async (req, res, next) => {
    try {
        const sessionId = getSessionIdFromBodyOrParams(req);

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                message: "sessionId (or chatId / _id / id) is required."
            });
        }

        const { endChatSession } = require("../services/chatBilling.service");
        const session = await endChatSession(sessionId);

        try {
            const { getIO } = require("../config/socket");
            const io = getIO();
            if (io) {
                const payload = {
                    success: true,
                    message: "Chat session ended successfully.",
                    session,
                    sessionId: session._id,
                    _id: session._id
                };
                io.to(`session_${sessionId}`).emit("chat_ended", payload);

                // Safely broadcast to individual user and astrologer personal rooms
                const extractIdString = (val) => {
                    if (!val) return "";
                    if (typeof val === "string") return val;
                    if (typeof val === "object") {
                        if (val._id) return String(val._id);
                        if (val.id) return String(val.id);
                    }
                    return String(val);
                };

                const userId = extractIdString(session.user);
                const astroId = extractIdString(session.astrologer);

                if (userId) {
                    io.to(`user_${userId}`).emit("chat_ended", payload);
                    io.to(userId).emit("chat_ended", payload);
                }
                if (astroId) {
                    io.to(`user_${astroId}`).emit("chat_ended", payload);
                    io.to(`astro_${astroId}`).emit("chat_ended", payload);
                    io.to(`astrologer_${astroId}`).emit("chat_ended", payload);
                    io.to(astroId).emit("chat_ended", payload);
                }
            }
        } catch (e) {}

        const responseData = {
            ...session.toObject(),
            sessionId: session._id,
            chatId: session._id,
            _id: session._id,
            id: session._id
        };

        return res.status(200).json({
            success: true,
            message: "Chat session ended successfully.",
            data: responseData
        });

    } catch (error) {
        next(error);
    }
};

/**
 * 4b. Send Chat Message (REST API endpoint fallback)
 */
exports.sendMessage = async (req, res, next) => {
    try {
        const sessionId = getSessionIdFromBodyOrParams(req);
        const { senderId, senderType, text, messageType, mediaUrl, clientMessageId, tempId, clientMsgId } = req.body;
        const resolvedClientMsgId = clientMessageId || tempId || clientMsgId || null;

        if (!sessionId || (!text && !mediaUrl)) {
            return res.status(400).json({
                success: false,
                message: "sessionId and text/mediaUrl are required."
            });
        }

        const mongoose = require("mongoose");
        const cleanSessionId = String(sessionId);
        let session = null;
        if (mongoose.Types.ObjectId.isValid(cleanSessionId)) {
            session = await ChatSession.findById(cleanSessionId).catch(() => null);
            if (!session) {
                session = await VideoSession.findById(cleanSessionId).catch(() => null);
            }
        }

        let normalizedSenderType = String(senderType || "USER").toUpperCase() === "ASTROLOGER" ? "ASTROLOGER" : "USER";
        let validSenderId = (senderId && mongoose.Types.ObjectId.isValid(senderId)) ? senderId : null;

        if (session) {
            if (session.status === "COMPLETED" || session.status === "REJECTED" || session.status === "CANCELLED") {
                return res.status(400).json({
                    success: false,
                    message: "Chat session is no longer active."
                });
            }

            const authUserId = req.user ? String(req.user.id || req.user._id || "") : "";
            const sessionUser = String(session.user || "");
            const sessionAstro = String(session.astrologer || "");

            const isAstroClaim = String(senderType || "").toUpperCase() === "ASTROLOGER" || (senderId && String(senderId) === sessionAstro) || (authUserId && authUserId === sessionAstro);

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
            if (resolvedClientMsgId) {
                newMessage = await ChatMessage.findOne({ session: cleanSessionId, clientMessageId: resolvedClientMsgId }).catch(() => null);
            }

            if (!newMessage) {
                try {
                    newMessage = await ChatMessage.create({
                        session: cleanSessionId,
                        senderId: validSenderId,
                        senderType: normalizedSenderType,
                        messageType: messageType || "text",
                        text: text || "",
                        mediaUrl: mediaUrl || null,
                        clientMessageId: resolvedClientMsgId || null
                    });
                    console.log(`💬 [Chat REST] Message saved. _id=${newMessage._id} clientMessageId=${resolvedClientMsgId} session=${cleanSessionId} senderType=${normalizedSenderType}`);
                } catch (createErr) {
                    if (createErr.code === 11000 && resolvedClientMsgId) {
                        newMessage = await ChatMessage.findOne({ session: cleanSessionId, clientMessageId: resolvedClientMsgId }).catch(() => null);
                    } else {
                        throw createErr;
                    }
                }
            } else {
                console.log(`♻️ [Chat REST] Idempotent match found. _id=${newMessage._id} clientMessageId=${resolvedClientMsgId}`);
            }
        } else {
            // Session not found – create an ephemeral in-memory object so the REST response still works.
            newMessage = {
                session: cleanSessionId,
                senderId: validSenderId,
                senderType: normalizedSenderType,
                messageType: messageType || "text",
                text: text || "",
                mediaUrl: mediaUrl || null,
                clientMessageId: resolvedClientMsgId || null,
                _id: new mongoose.Types.ObjectId(),
                createdAt: new Date()
            };
            console.warn(`⚠️ [Chat REST] No ChatSession found for ${cleanSessionId}. Message NOT persisted.`);
        }

        const formattedMsg = {
            ...(newMessage.toObject ? newMessage.toObject() : newMessage),
            session: cleanSessionId,
            sessionId: cleanSessionId,
            chatId: cleanSessionId,
            roomId: cleanSessionId,
            senderId: String(newMessage.senderId),
            senderType: normalizedSenderType,
            messageType: newMessage.messageType || messageType || "text",
            text: newMessage.text || text || "",
            mediaUrl: newMessage.mediaUrl || mediaUrl || null,
            clientMessageId: newMessage.clientMessageId || resolvedClientMsgId || null,
            _id: String(newMessage._id),
            id: String(newMessage._id),
            createdAt: newMessage.createdAt || new Date().toISOString()
        };

        try {
            const { getIO } = require("../config/socket");
            const io = getIO();
            if (io) {
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
            }
        } catch (e) {
            console.error("Socket emit error in sendMessage API:", e);
        }

        return res.status(201).json({
            success: true,
            data: formattedMsg
        });

    } catch (error) {
        next(error);
    }
};


/**
 * 5. Get Messages History for a Chat Session
 */
exports.getChatHistory = async (req, res, next) => {
    try {
        const sessionId = getSessionIdFromBodyOrParams(req);

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                message: "sessionId is required."
            });
        }

        const mongoose = require("mongoose");
        const cleanId = String(sessionId);
        let queryCondition = { session: cleanId };
        if (mongoose.Types.ObjectId.isValid(cleanId)) {
            queryCondition = { $or: [{ session: cleanId }, { session: new mongoose.Types.ObjectId(cleanId) }] };
        }

        const messages = await ChatMessage.find(queryCondition).sort({ createdAt: 1 });

        return res.status(200).json({
            success: true,
            count: messages.length,
            data: messages
        });

    } catch (error) {
        next(error);
    }
};

/**
 * 6. Get User or Astrologer's Chat Sessions List
 */
exports.getMySessions = async (req, res, next) => {
    try {
        const { userId, astrologerId, status } = req.query;

        let query = {};
        if (userId) {
            const userObj = await findUserByIdOrRef(userId);
            query.user = userObj ? userObj._id : userId;
        }
        if (astrologerId) {
            const astroObj = await findAstrologerByIdOrRef(astrologerId);
            query.astrologer = astroObj ? astroObj._id : astrologerId;
        }
        if (status) query.status = status;

        const rawSessions = await ChatSession.find(query)
            .populate("user", "firstname lastname email phone profileImage")
            .populate("astrologer", "name profileImage consultationFee rating")
            .sort({ createdAt: -1 });

        const sessions = rawSessions.map(s => ({
            ...s.toObject(),
            sessionId: s._id,
            chatId: s._id,
            id: s._id
        }));

        return res.status(200).json({
            success: true,
            count: sessions.length,
            data: sessions
        });

    } catch (error) {
        next(error);
    }
};

/**
 * 7. Rate & Review completed Chat Session
 */
exports.rateChat = async (req, res, next) => {
    try {
        const sessionId = getSessionIdFromBodyOrParams(req);
        const { rating, review } = req.body;

        if (!sessionId || !rating) {
            return res.status(400).json({
                success: false,
                message: "sessionId and rating are required."
            });
        }

        const session = await ChatSession.findById(sessionId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: "Chat session not found."
            });
        }

        session.rating = rating;
        if (review) session.review = review;
        await session.save();

        const astrologer = await Astrologer.findById(session.astrologer);
        if (astrologer) {
            const allRatings = await ChatSession.find({ astrologer: session.astrologer, rating: { $ne: null } });
            const total = allRatings.reduce((sum, item) => sum + item.rating, 0);
            astrologer.rating = Number((total / allRatings.length).toFixed(1));
            astrologer.totalReviews = allRatings.length;
            await astrologer.save();
        }

        return res.status(200).json({
            success: true,
            message: "Chat rating and review submitted successfully.",
            data: session
        });

    } catch (error) {
        next(error);
    }
};

/**
 * 8. Get Chat Session Details by Session ID
 */
exports.getSessionDetails = async (req, res, next) => {
    try {
        const sessionId = getSessionIdFromBodyOrParams(req);

        if (!sessionId) {
            return res.status(400).json({
                success: false,
                message: "sessionId is required."
            });
        }

        const session = await ChatSession.findById(sessionId)
            .populate("user", "firstname lastname email phone profileImage")
            .populate("astrologer", "name profileImage consultationFee rating");

        if (!session) {
            return res.status(404).json({
                success: false,
                message: "Chat session not found."
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                ...session.toObject(),
                sessionId: session._id,
                chatId: session._id,
                id: session._id
            }
        });

    } catch (error) {
        next(error);
    }
};
