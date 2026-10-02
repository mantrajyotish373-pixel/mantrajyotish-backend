const mongoose = require("mongoose");
const Session = require("../models/session.model");
const VideoSession = require("../models/videoSession.model");
const ChatSession = require("../models/chatSession.model");
const Astrologer = require("../models/astro.model");

const isAdminRole = (role) => role === "admin" || role === "superadmin";

const getRequestSessionId = (req) => {
    const body = req.body || {};
    const params = req.params || {};
    const query = req.query || {};

    return params.id || params.sessionId ||
           body.sessionId || body.chatId || body.callId || body._id || body.id ||
           query.sessionId || query.chatId || query.id || null;
};

const findAnySession = async (id) => {
    if (!id) return null;
    const cleanId = String(id);

    if (mongoose.Types.ObjectId.isValid(cleanId)) {
        const byId = await Session.findById(cleanId).catch(() => null) ||
                     await VideoSession.findById(cleanId).catch(() => null) ||
                     await ChatSession.findById(cleanId).catch(() => null);
        if (byId) return byId;
    }

    return await Session.findOne({
        $or: [{ roomId: cleanId }, { channelName: cleanId }, { sessionCode: cleanId }]
    }).catch(() => null) ||
    await VideoSession.findOne({
        $or: [{ roomId: cleanId }, { channelName: cleanId }]
    }).catch(() => null);
};

/**
 * Resolves which side of the session the authenticated caller is on.
 * Returns "admin", "user", "astrologer" or null when the caller is not a participant.
 */
const getParticipantRole = async (session, reqUser) => {
    if (!session || !reqUser) return null;
    if (isAdminRole(reqUser.role)) return "admin";

    const callerId = String(reqUser.userId || reqUser.id || reqUser._id || "");
    if (!callerId) return null;

    const sessionUser = String(session.user && (session.user._id || session.user));
    const sessionAstro = String(session.astrologer && (session.astrologer._id || session.astrologer));

    if (callerId === sessionUser) return "user";
    if (callerId === sessionAstro) return "astrologer";

    // Older astrologer tokens may carry the AstrologerLogin id instead of the Astrologer id
    if (mongoose.Types.ObjectId.isValid(callerId)) {
        const astroProfile = await Astrologer.findOne({
            $or: [{ _id: callerId }, { astrologerLogin: callerId }]
        }).select("_id").lean().catch(() => null);
        if (astroProfile && String(astroProfile._id) === sessionAstro) return "astrologer";
    }

    return null;
};

/**
 * Requires authMiddleware first. Ensures the caller is a participant (or an admin)
 * of the session referenced by the request's params, body or query.
 */
const sessionAuthMiddleware = async (req, res, next) => {
    try {
        if (!req.user) {
            return res.status(401).json({ success: false, message: "Unauthorized: Missing user credentials" });
        }

        const id = getRequestSessionId(req);
        if (!id) {
            return res.status(400).json({ success: false, message: "sessionId is required" });
        }

        const session = await findAnySession(id);
        if (!session) {
            return res.status(404).json({ success: false, message: "Consultation session not found" });
        }

        const participantRole = await getParticipantRole(session, req.user);
        if (!participantRole) {
            return res.status(403).json({
                success: false,
                message: "Forbidden: You are not authorized to access this consultation session"
            });
        }

        req.sessionObj = session;
        req.sessionRole = participantRole;
        next();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Internal server error during session authorization"
        });
    }
};

module.exports = sessionAuthMiddleware;
module.exports.getParticipantRole = getParticipantRole;
module.exports.findAnySession = findAnySession;
module.exports.isAdminRole = isAdminRole;
