const videoSessionService = require("../services/videoSession.service");
const { getIO } = require("../config/socket");

const formatDate = (dateVal) => {
    if (!dateVal) return "Not Specified";
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
};

// 1. GENERATE AGORA RTC TOKEN
const generateAgoraToken = async (req, res) => {
    try {
        const { channelName, uid, role } = req.body;

        if (!channelName) {
            return res.status(400).json({
                success: false,
                message: "channelName is required"
            });
        }

        // Only participants of the session that owns this channel may join it
        const { findAnySession, getParticipantRole } = require("../middlewares/sessionAuth.middleware");
        const session = await findAnySession(channelName);
        if (!session || !(await getParticipantRole(session, req.user))) {
            return res.status(403).json({
                success: false,
                message: "Forbidden: You are not a participant of this call"
            });
        }

        const tokenData = videoSessionService.generateAgoraToken(channelName, uid, role);

        return res.status(200).json({
            success: true,
            message: "Agora RTC Token generated successfully",
            data: tokenData
        });

    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// 2-5. Call lifecycle (request / accept / reject / end) is owned by the Session Engine
// (services/session). These endpoints keep their URLs and response shapes and delegate to the
// same handlers the socket events use.
const sessionHandlers = require("../services/session/handlers");
const sessionEngine = require("../services/session/engine");
const sessionRealtime = require("../services/session/realtime");

const callError = (res, err) => {
    const d = sessionHandlers.describeError(err);
    return res.status(d.status || 400).json({ success: false, message: d.message, code: d.code });
};

const callResponseData = (session) => ({
    ...session,
    sessionId: session._id,
    callId: session._id,
    _id: session._id,
    id: session._id
});

// 2. REQUEST CALL (USER -> ASTROLOGER)
const requestCall = async (req, res) => {
    try {
        const result = await sessionHandlers.requestSession({
            decoded: req.user,
            body: req.body || {},
            defaultType: "VIDEO",
            protocol: req.body && req.body.protocol
        });
        const populated = await sessionHandlers.withParticipants(result.session);
        return res.status(201).json({
            success: true,
            message: "Call request created and sent to astrologer",
            data: { ...callResponseData(populated), serverNow: new Date().toISOString() }
        });
    } catch (error) {
        return callError(res, error);
    }
};

// 3. ACCEPT CALL (ASTROLOGER -> USER)
const acceptCall = async (req, res) => {
    try {
        const sessionId = req.params.id || (req.body && (req.body.sessionId || req.body.id || req.body.callId));
        if (!sessionId) {
            return res.status(400).json({ success: false, message: "sessionId is required" });
        }
        const result = await sessionHandlers.acceptSession({
            decoded: req.user,
            sessionId,
            protocol: req.body && req.body.protocol
        });
        const populated = await sessionHandlers.withParticipants(result.session);
        return res.status(200).json({
            success: true,
            message: "Call request accepted. Live call started!",
            data: {
                session: callResponseData(populated),
                agora: result.agora,
                status: result.session.status,
                started: result.started,
                serverNow: new Date().toISOString()
            }
        });
    } catch (error) {
        return callError(res, error);
    }
};

// 4. REJECT CALL
const rejectCall = async (req, res) => {
    try {
        const targetId = req.params.id || (req.body && (req.body.sessionId || req.body.id || req.body.callId));
        if (!targetId) {
            return res.status(400).json({ success: false, message: "sessionId is required" });
        }
        const result = await sessionHandlers.rejectOrCancel({
            decoded: req.user,
            sessionId: targetId,
            reason: (req.body && req.body.reason) || undefined
        });
        return res.status(200).json({
            success: true,
            message: "Call request rejected",
            data: callResponseData(result.session)
        });
    } catch (error) {
        return callError(res, error);
    }
};

// 5. END CALL SESSION (either participant; the server settles once)
const endCall = async (req, res) => {
    try {
        const sessionId = req.params.id || (req.body && (req.body.sessionId || req.body.id || req.body.callId));
        if (!sessionId) {
            return res.status(400).json({ success: false, message: "sessionId is required" });
        }
        const result = await sessionHandlers.endSession({
            decoded: req.user,
            sessionId,
            reason: (req.body && req.body.reason) || "Call consultation ended"
        });
        const role = await sessionEngine.roleOf(result.session, { user: req.user });
        return res.status(200).json({
            success: true,
            message: "Call session ended successfully",
            data: {
                ...callResponseData(result.session),
                final: sessionRealtime.finalResult(result.session, role === "ASTROLOGER" ? "ASTROLOGER" : "USER")
            }
        });
    } catch (error) {
        return callError(res, error);
    }
};

// 6. GET CALL HISTORY
const getCallHistory = async (req, res) => {
    try {
        const { role } = req.query;
        const userId = role === "astrologer"
            ? (req.query.astrologerId || req.query.userId)
            : req.query.userId;

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "userId query parameter is required"
            });
        }

        const history = await videoSessionService.getCallHistory(userId, role || "user");

        return res.status(200).json({
            success: true,
            count: history.length,
            data: history
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// Legacy compatibility endpoints
const createVideoSession = async (req, res) => {
    try {
        const result = await videoSessionService.createVideoSession(req.body);
        return res.status(201).json({ success: true, message: "Video Session Created", data: result });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const startVideoSession = async (req, res) => {
    try {
        const sessionId = req.params.id || req.body.sessionId;
        const result = await videoSessionService.startVideoSession(sessionId);
        return res.status(200).json({ success: true, message: "Video Session started", data: result });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
};

const endVideoSession = async (req, res) => {
    return await endCall(req, res);
};

const getAllVideoSessions = async (req, res) => {
    try {
        const sessions = await videoSessionService.getAllVideoSessions();
        return res.status(200).json({ success: true, count: sessions.length, data: sessions });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getVideoSessionById = async (req, res) => {
    try {
        const session = await videoSessionService.getVideoSessionById(req.params.id);
        if (!session) return res.status(404).json({ success: false, message: "Video Session Not Found" });
        return res.status(200).json({ success: true, data: session });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const updateVideoSession = async (req, res) => {
    try {
        const session = await videoSessionService.updateVideoSession(req.params.id, req.body);
        if (!session) return res.status(404).json({ success: false, message: "Video Session Not Found" });
        return res.status(200).json({ success: true, message: "Updated", data: session });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const deleteVideoSession = async (req, res) => {
    try {
        const session = await videoSessionService.deleteVideoSession(req.params.id);
        if (!session) return res.status(404).json({ success: false, message: "Video Session Not Found" });
        return res.status(200).json({ success: true, message: "Deleted" });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

const getPendingCallRequests = async (req, res) => {
    try {
        const astrologerId = req.query.astrologerId || req.query.astroId || req.query.userId || req.params.id;
        if (!astrologerId) {
            return res.status(200).json({ success: true, count: 0, data: [] });
        }

        const Astrologer = require("../models/astro.model");
        const mongoose = require("mongoose");
        let astroObj = null;
        if (mongoose.Types.ObjectId.isValid(astrologerId)) {
            astroObj = await Astrologer.findById(astrologerId);
        }
        if (!astroObj) {
            astroObj = await Astrologer.findOne({ $or: [{ user: astrologerId }, { astrologerLogin: astrologerId }] });
        }

        const astroIds = [astrologerId];
        if (astroObj) {
            if (astroObj._id) astroIds.push(astroObj._id.toString());
            if (astroObj.user) astroIds.push(astroObj.user.toString());
        }

        const VideoSession = require("../models/videoSession.model");
        const twoMinutesAgo = new Date(Date.now() - 2 * 60000); // 120 seconds limit
        const pendingSessions = await VideoSession.find({
            astrologer: { $in: astroIds },
            status: "PENDING",
            createdAt: { $gte: twoMinutesAgo }
        }).sort({ createdAt: -1 }).populate("user", "name firstname lastname phone profileImage avatar dateofbirth dob timeofbirth tob placeofbirth pob birthLocation topic gender").lean();

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

        const formatted = pendingSessions.map(s => {
            const userObj = s.user || {};
            const resolvedName = userObj.name || `${userObj.firstname || ""} ${userObj.lastname || ""}`.trim() || (userObj.phone ? `User (${userObj.phone})` : "Client User");
            return {
                sessionId: s._id,
                callId: s._id,
                _id: s._id,
                id: s._id,
                callType: s.callType,
                user: {
                    _id: userObj._id,
                    id: userObj._id,
                    name: resolvedName,
                    userName: resolvedName,
                    phone: userObj.phone || "",
                    avatar: userObj.profileImage || userObj.avatar || "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80",
                    profileImage: userObj.profileImage || userObj.avatar || "https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=120&auto=format&fit=crop&q=80",
                    dob: userObj.dateofbirth ? formatDobDate(userObj.dateofbirth) : (userObj.dob || "Not Specified"),
                    dateofbirth: userObj.dateofbirth ? formatDobDate(userObj.dateofbirth) : (userObj.dob || "Not Specified"),
                    tob: userObj.timeofbirth || userObj.tob || "Not Specified",
                    timeofbirth: userObj.timeofbirth || userObj.tob || "Not Specified",
                    pob: userObj.placeofbirth || userObj.pob || (userObj.birthLocation && (userObj.birthLocation.city || userObj.birthLocation.name || userObj.birthLocation.state)) || userObj.city || "Not Specified",
                    placeofbirth: userObj.placeofbirth || userObj.pob || (userObj.birthLocation && (userObj.birthLocation.city || userObj.birthLocation.name || userObj.birthLocation.state)) || userObj.city || "Not Specified",
                    topic: userObj.topic || "Astrology Consultation",
                    gender: userObj.gender || "Not Specified"
                },
                astrologer: s.astrologer,
                perMinuteRate: s.perMinuteRate,
                channelName: s.channelName,
                createdAt: s.createdAt
            };
        });

        return res.status(200).json({
            success: true,
            count: formatted.length,
            data: formatted
        });
    } catch (error) {
        console.error("getPendingCallRequests error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// 7. RATE CALL SESSION
const rateVideoSession = async (req, res) => {
    try {
        const sessionId = req.params.id || req.body.sessionId || req.body.id || req.body.callId;
        const { rating, review } = req.body;

        if (!sessionId || !rating) {
            return res.status(400).json({ success: false, message: "sessionId and rating are required." });
        }

        const numRating = parseFloat(rating);
        if (isNaN(numRating) || numRating < 1 || numRating > 5) {
            return res.status(400).json({ success: false, message: "Rating must be between 1 and 5." });
        }

        const Session = require("../models/session.model");
        const VideoSession = require("../models/videoSession.model");
        const Astrologer = require("../models/astro.model");

        let session = await Session.findById(sessionId);
        if (!session) {
            session = await VideoSession.findById(sessionId);
        }
        if (!session) {
            session = await Session.findOne({ $or: [{ roomId: sessionId }, { channelName: sessionId }] });
        }
        if (!session) {
            return res.status(404).json({ success: false, message: "Session not found." });
        }

        session.rating = numRating;
        if (review) session.review = review;
        await session.save();

        await VideoSession.findByIdAndUpdate(session._id, { rating: numRating, review: review || "" }).catch(() => null);

        // Recalculate astrologer average rating from all rated sessions
        const astrologer = await Astrologer.findById(session.astrologer);
        if (astrologer) {
            const allRated = await Session.find({ astrologer: session.astrologer, rating: { $ne: null } });
            if (allRated.length > 0) {
                const total = allRated.reduce((sum, s) => sum + (s.rating || 0), 0);
                astrologer.rating = Number((total / allRated.length).toFixed(1));
                astrologer.totalReviews = allRated.length;
                await astrologer.save();
            }
        }

        return res.status(200).json({
            success: true,
            message: "Rating submitted successfully.",
            data: session
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};


module.exports = {
    generateAgoraToken,
    requestCall,
    acceptCall,
    rejectCall,
    endCall,
    rateVideoSession,
    getCallHistory,
    getPendingCallRequests,
    createVideoSession,
    startVideoSession,
    endVideoSession,
    getAllVideoSessions,
    getVideoSessionById,
    updateVideoSession,
    deleteVideoSession
};