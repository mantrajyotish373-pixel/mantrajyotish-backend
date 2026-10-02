const Session = require("../models/session.model");
const User = require("../models/user.model");
const Astrologer = require("../models/astro.model");
const sessionEngine = require("../services/sessionEngine.service");
const agoraService = require("../services/agora.service");

/**
 * "Do I have an active session?" The authoritative recovery call for reconnect / app restart.
 * Returns the caller's live session (PENDING, CONNECTING, ACTIVE or ENDING) or, if their last
 * session just finished and they have not acknowledged the result, that final result. Identity
 * comes from the token. Legacy response fields are kept; `snapshot` is the new authoritative state.
 */
exports.getActiveSession = async (req, res, next) => {
    try {
        const handlers = require("../services/session/handlers");
        const realtime = require("../services/session/realtime");

        const found = await handlers.getActive({ decoded: req.user });
        if (!found) {
            return res.status(200).json({ success: true, data: null });
        }

        const { session, role, snapshot } = found;
        const populated = await handlers.withParticipants(session);
        const serverNow = new Date().toISOString();
        const startedAtISO = session.startedAt ? new Date(session.startedAt).toISOString() : null;

        const agora = ["CONNECTING", "ACTIVE"].includes(session.status) ? realtime.agoraFor(session, role) : null;
        const astroData = populated.astrologer && typeof populated.astrologer === "object" ? populated.astrologer : {};
        const formattedAstro = {
            ...astroData,
            id: astroData._id || astroData.id,
            image: astroData.profileImage || astroData.image || "",
            price: `₹${session.perMinuteRate}/min`,
            priceRaw: session.perMinuteRate
        };

        return res.status(200).json({
            success: true,
            data: {
                ...populated,
                sessionId: session._id,
                chatId: session._id,
                callId: session._id,
                id: session._id,
                callType: session.type,
                startedAt: startedAtISO,
                startTime: startedAtISO,
                serverNow,
                astrologer: formattedAstro,
                appId: agora ? agora.appId : undefined,
                agoraToken: agora ? agora.token : null,
                agoraConfig: agora
                    ? { appId: agora.appId, channelName: agora.channelName, token: agora.token, uid: agora.uid }
                    : null,
                role,
                snapshot
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * End session API (either participant). Delegates to the Session Engine, which ends the session
 * once and returns the same final result to every caller.
 */
exports.endSession = async (req, res, next) => {
    try {
        const sessionId = req.body?.sessionId || req.body?.chatId || req.body?.id || req.params.sessionId;
        if (!sessionId) {
            return res.status(400).json({ success: false, message: "sessionId is required." });
        }

        const handlers = require("../services/session/handlers");
        const engine = require("../services/session/engine");
        const realtime = require("../services/session/realtime");
        const result = await handlers.endSession({
            decoded: req.user,
            sessionId,
            reason: req.body?.reason || "User ended session"
        });
        const role = await engine.roleOf(result.session, { user: req.user });

        return res.status(200).json({
            success: true,
            message: "Session ended successfully.",
            data: {
                ...result.session,
                sessionId: result.session._id,
                final: realtime.finalResult(result.session, role === "ASTROLOGER" ? "ASTROLOGER" : "USER")
            }
        });
    } catch (error) {
        if (error && error.name === "SessionError") {
            return res.status(error.status || 400).json({ success: false, message: error.message, code: error.code });
        }
        next(error);
    }
};

/**
 * Get Session Details
 */
exports.getSessionDetails = async (req, res, next) => {
    try {
        const sessionId = req.params.sessionId || req.query.sessionId;
        if (!sessionId) {
            return res.status(400).json({ success: false, message: "sessionId is required." });
        }

        const session = await Session.findById(sessionId)
            .populate("astrologer", "name profileImage consultationFee specialization rating")
            .populate("user", "firstname lastname phone profileImage walletBalance");

        if (!session) {
            return res.status(404).json({ success: false, message: "Session not found." });
        }

        const serverNow = new Date().toISOString();
        const startedAt = session.startedAt || session.startTime;
        const startedAtISO = startedAt ? new Date(startedAt).toISOString() : serverNow;

        return res.status(200).json({
            success: true,
            data: {
                ...session.toObject(),
                sessionId: session._id,
                startedAt: startedAtISO,
                startTime: startedAtISO,
                serverNow
            }
        });
    } catch (error) {
        next(error);
    }
};
