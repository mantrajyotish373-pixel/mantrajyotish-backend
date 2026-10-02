const ChatSession = require("../models/chatSession.model");
const ChatMessage = require("../models/chatMessage.model");
const User = require("../models/user.model");
const Astrologer = require("../models/astro.model");
const Session = require("../models/session.model");
const VideoSession = require("../models/videoSession.model");

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
 * 1-4. Chat lifecycle (initiate / accept / reject / end) is owned by the Session Engine
 * (services/session). These endpoints keep their URLs and response shapes and delegate to the
 * same handlers the socket events use.
 */
const handlers = require("../services/session/handlers");
const sessionRealtime = require("../services/session/realtime");

const sendSessionError = (res, err) => {
    const d = handlers.describeError(err);
    return res.status(d.status || 400).json({ success: false, message: d.message, code: d.code });
};

const chatResponseData = (session, extra = {}) => ({
    ...session,
    sessionId: session._id,
    chatId: session._id,
    _id: session._id,
    id: session._id,
    ...extra
});

/**
 * 1. Initiate Chat Request (User side)
 */
exports.initiateChat = async (req, res, next) => {
    try {
        const result = await handlers.requestSession({
            decoded: req.user,
            body: req.body || {},
            defaultType: "CHAT",
            protocol: req.body && req.body.protocol
        });
        return res.status(201).json({
            success: true,
            message: "Chat request initiated successfully. Waiting for astrologer acceptance.",
            data: chatResponseData(result.session, { user: result.userDetails, serverNow: new Date().toISOString() })
        });
    } catch (error) {
        if (error && error.name === "SessionError") return sendSessionError(res, error);
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
            return res.status(400).json({ success: false, message: "sessionId (or chatId / _id / id) is required." });
        }
        const result = await handlers.acceptSession({
            decoded: req.user,
            sessionId,
            protocol: req.body && req.body.protocol
        });
        const startIso = result.session.startedAt ? new Date(result.session.startedAt).toISOString() : null;
        return res.status(200).json({
            success: true,
            message: "Chat request accepted. Session is now ACTIVE.",
            data: chatResponseData(result.session, { startTime: startIso, startedAt: startIso, serverNow: new Date().toISOString() })
        });
    } catch (error) {
        if (error && error.name === "SessionError") return sendSessionError(res, error);
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
            return res.status(400).json({ success: false, message: "sessionId (or chatId / _id / id) is required." });
        }
        const result = await handlers.rejectOrCancel({
            decoded: req.user,
            sessionId,
            reason: (req.body && req.body.reason) || "Astrologer rejected the request."
        });
        return res.status(200).json({
            success: true,
            message: "Chat request rejected successfully.",
            data: chatResponseData(result.session)
        });
    } catch (error) {
        if (error && error.name === "SessionError") return sendSessionError(res, error);
        next(error);
    }
};

/**
 * 4. End Chat Session (either participant). The server decides endedAt, duration, price and
 * settlement once; a second End returns the same final result.
 */
exports.endChat = async (req, res, next) => {
    try {
        const sessionId = getSessionIdFromBodyOrParams(req);
        if (!sessionId) {
            return res.status(400).json({ success: false, message: "sessionId (or chatId / _id / id) is required." });
        }
        const result = await handlers.endSession({
            decoded: req.user,
            sessionId,
            reason: (req.body && req.body.reason) || "Chat consultation completed"
        });
        const role = await require("../services/session/engine").roleOf(result.session, { user: req.user });
        return res.status(200).json({
            success: true,
            message: "Chat session ended successfully.",
            data: chatResponseData(result.session, {
                final: sessionRealtime.finalResult(result.session, role === "ASTROLOGER" ? "ASTROLOGER" : "USER")
            })
        });
    } catch (error) {
        if (error && error.name === "SessionError") return sendSessionError(res, error);
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
            // the unified Session is authoritative; the legacy collections are only mirrors
            session = await Session.findById(cleanSessionId).catch(() => null)
                || await ChatSession.findById(cleanSessionId).catch(() => null)
                || await VideoSession.findById(cleanSessionId).catch(() => null);
        }

        let normalizedSenderType = String(senderType || "USER").toUpperCase() === "ASTROLOGER" ? "ASTROLOGER" : "USER";
        let validSenderId = (senderId && mongoose.Types.ObjectId.isValid(senderId)) ? senderId : null;

        if (session) {
            if (["COMPLETED", "REJECTED", "CANCELLED", "MISSED", "ENDING"].includes(session.status)) {
                return res.status(400).json({
                    success: false,
                    message: "Chat session is no longer active."
                });
            }

            const authUserId = req.user ? String(req.user.id || req.user._id || "") : "";
            const sessionUser = String(session.user || "");
            const sessionAstro = String(session.astrologer || "");

            // sessionAuthMiddleware has already established which side the caller is on;
            // only fall back to client-supplied hints for admin callers.
            const isAstroClaim = req.sessionRole && req.sessionRole !== "admin"
                ? req.sessionRole === "astrologer"
                : String(senderType || "").toUpperCase() === "ASTROLOGER" || (senderId && String(senderId) === sessionAstro) || (authUserId && authUserId === sessionAstro);

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
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const skip = (page - 1) * limit;

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

        const totalSessions = await ChatSession.countDocuments(query);

        const rawSessions = await ChatSession.find(query)
            .populate("user", "name firstname lastname email phone profileImage avatar dateofbirth dob timeofbirth tob placeofbirth pob birthLocation topic gender")
            .populate("astrologer", "name profileImage consultationFee rating")
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);

        const formatDobDate = (dateVal) => {
            if (!dateVal) return "Not Specified";
            if (typeof dateVal === "string") return dateVal.trim();
            const d = new Date(dateVal);
            if (isNaN(d.getTime())) return "Not Specified";
            const day = String(d.getUTCDate()).padStart(2, "0");
            const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
            const monthStr = months[d.getUTCMonth()];
            const year = d.getUTCFullYear();
            return `${day} ${monthStr} ${year}`;
        };

        const sessions = rawSessions.map(s => {
            const sObj = s.toObject();
            const u = sObj.user;
            if (u && typeof u === "object") {
                const resolvedName = u.name || `${u.firstname || ""} ${u.lastname || ""}`.trim() || (u.phone ? `User (${u.phone})` : "Client User");
                sObj.user = {
                    ...u,
                    _id: u._id,
                    id: u._id,
                    name: resolvedName,
                    userName: resolvedName,
                    avatar: u.profileImage || u.avatar || "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80",
                    profileImage: u.profileImage || u.avatar || "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80",
                    dob: u.dateofbirth ? formatDobDate(u.dateofbirth) : (u.dob || "Not Specified"),
                    dateofbirth: u.dateofbirth ? formatDobDate(u.dateofbirth) : (u.dob || "Not Specified"),
                    tob: u.timeofbirth || u.tob || "Not Specified",
                    timeofbirth: u.timeofbirth || u.tob || "Not Specified",
                    pob: u.placeofbirth || u.pob || (u.birthLocation && (u.birthLocation.city || u.birthLocation.name || u.birthLocation.state)) || u.city || "Not Specified",
                    placeofbirth: u.placeofbirth || u.pob || (u.birthLocation && (u.birthLocation.city || u.birthLocation.name || u.birthLocation.state)) || u.city || "Not Specified",
                    topic: u.topic || "Astrology Consultation",
                    gender: u.gender || "Not Specified"
                };
            }
            return {
                ...sObj,
                sessionId: s._id,
                chatId: s._id,
                id: s._id
            };
        });

        const totalPages = Math.ceil(totalSessions / limit) || 1;
        const hasMore = page < totalPages;

        return res.status(200).json({
            success: true,
            count: sessions.length,
            total: totalSessions,
            page,
            totalPages,
            hasMore,
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

        const Session = require("../models/session.model");
        let session = await Session.findById(sessionId);
        if (!session) {
            session = await ChatSession.findById(sessionId);
        }
        if (!session) {
            session = await Session.findOne({ $or: [{ roomId: sessionId }, { channelName: sessionId }] });
        }
        if (!session) {
            return res.status(404).json({
                success: false,
                message: "Chat session not found."
            });
        }

        session.rating = rating;
        if (review) session.review = review;
        await session.save();

        await ChatSession.findByIdAndUpdate(session._id, { rating, review: review || "" }).catch(() => null);

        const astrologer = await Astrologer.findById(session.astrologer);
        if (astrologer) {
            const allRatings = await Session.find({ astrologer: session.astrologer, rating: { $ne: null } });
            if (allRatings.length > 0) {
                const total = allRatings.reduce((sum, item) => sum + (item.rating || 0), 0);
                astrologer.rating = Number((total / allRatings.length).toFixed(1));
                astrologer.totalReviews = allRatings.length;
                await astrologer.save();
            }
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

        const serverNow = new Date().toISOString();
        const startTimeISO = session.startTime ? new Date(session.startTime).toISOString() : serverNow;

        return res.status(200).json({
            success: true,
            data: {
                ...session.toObject(),
                sessionId: session._id,
                chatId: session._id,
                id: session._id,
                startTime: startTimeISO,
                serverNow
            }
        });

    } catch (error) {
        next(error);
    }
};
