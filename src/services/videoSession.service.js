const VideoSession = require("../models/videoSession.model");
const Session = require("../models/session.model");
const Appointment = require("../models/appointment.model");
const User = require("../models/user.model");
const Astrologer = require("../models/astro.model");
const agoraService = require("./agora.service");
const sessionEngine = require("./sessionEngine.service");

const generateRoomId = (prefix = "room") => {
    return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
};

const findUserByIdOrRef = sessionEngine.findUserByIdOrRef;
const findAstrologerByIdOrRef = sessionEngine.findAstrologerByIdOrRef;

/**
 * Generate standalone Agora RTC Token
 */
const generateAgoraToken = (channelName, uid = 0, role = "publisher") => {
    return agoraService.generateRtcToken(channelName, uid, role);
};

/**
 * End Active Call Session (system-initiated). Participant-initiated ends go through
 * services/session/handlers.
 */
const endCallSession = async (sessionId) => {
    const result = await require("./session/engine").endSession({ sessionId, actor: { system: true }, reason: "Call consultation ended" });
    return result.session;
};

/**
 * Get Call Session Details by ID
 */
const getVideoSessionById = async (id) => {
    let session = await Session.findById(id)
        .populate("user", "firstname lastname phone profileImage walletBalance dateofbirth timeofbirth placeofbirth name")
        .populate("astrologer", "name profileImage consultationFee specialization");

    if (!session) {
        session = await VideoSession.findById(id)
            .populate("appointment")
            .populate("user", "firstname lastname phone profileImage walletBalance dateofbirth timeofbirth placeofbirth name")
            .populate("astrologer", "name profileImage consultationFee specialization");
    }

    if (!session) return null;

    let freshAgoraToken = null;
    let appId = process.env.AGORA_APP_ID || null;
    if (session.status === "ACTIVE" && session.channelName) {
        try {
            freshAgoraToken = agoraService.generateRtcToken(session.channelName, 0, "publisher");
        } catch (e) {
            console.warn("Could not generate fresh Agora token for rejoin:", e.message);
        }
    }

    return {
        ...session.toObject(),
        appId,
        agoraToken: freshAgoraToken,
        channelName: session.channelName || session.roomId,
        callType: session.type || session.callType,
        status: session.status,
        sessionId: session._id.toString(),
    };
};

/**
 * Get Call History for User or Astrologer
 */
const getCallHistory = async (userId, role = "user") => {
    const userObj = await findUserByIdOrRef(userId);
    const astroObj = await findAstrologerByIdOrRef(userId);

    const targetId = role === "astrologer" 
        ? (astroObj ? astroObj._id : userId)
        : (userObj ? userObj._id : userId);

    const query = role === "astrologer" 
        ? { astrologer: targetId, type: { $in: ["AUDIO", "VIDEO"] } } 
        : { user: targetId, type: { $in: ["AUDIO", "VIDEO"] } };

    const unifiedSessions = await Session.find(query)
        .sort({ createdAt: -1 })
        .populate("user", "firstname lastname phone profileImage dateofbirth timeofbirth placeofbirth name")
        .populate("astrologer", "name profileImage consultationFee");

    if (unifiedSessions && unifiedSessions.length > 0) {
        return unifiedSessions;
    }

    const legacyQuery = role === "astrologer" ? { astrologer: targetId } : { user: targetId };
    return await VideoSession.find(legacyQuery)
        .sort({ createdAt: -1 })
        .populate("user", "firstname lastname phone profileImage dateofbirth timeofbirth placeofbirth name")
        .populate("astrologer", "name profileImage consultationFee");
};

// Legacy compatibility functions
const createVideoSession = async (videoData) => {
    const roomId = videoData.roomId || generateRoomId();
    const agoraData = agoraService.generateRtcToken(roomId, 0, "publisher");

    const session = await sessionEngine.createSessionRequest({
        type: videoData.callType || "VIDEO",
        userId: videoData.user,
        astrologerId: videoData.astrologer,
        roomId
    });

    return {
        session,
        agora: agoraData
    };
};

const getAllVideoSessions = async () => {
    return await Session.find({ type: { $in: ["AUDIO", "VIDEO"] } })
        .populate("user")
        .populate("astrologer");
};

const startVideoSession = async (id) => {
    return await acceptCallSession(id);
};

const endVideoSession = async (id) => {
    return await endCallSession(id);
};

const updateVideoSession = async (id, updateData) => {
    return await Session.findByIdAndUpdate(id, updateData, { new: true, runValidators: true });
};

const deleteVideoSession = async (id) => {
    await VideoSession.findByIdAndDelete(id);
    return await Session.findByIdAndDelete(id);
};

module.exports = {
    generateAgoraToken,
    endCallSession,
    getCallHistory,
    createVideoSession,
    getAllVideoSessions,
    getVideoSessionById,
    startVideoSession,
    endVideoSession,
    updateVideoSession,
    deleteVideoSession
};