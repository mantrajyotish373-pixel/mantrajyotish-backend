/**
 * ChatSession / VideoSession are legacy copies of the unified Session (same _id). Admin pages and
 * older clients still read them. The engine writes them through this one helper, after the
 * response has been sent, so the hot path never waits on them.
 */
const ChatSession = require("../../models/chatSession.model");
const VideoSession = require("../../models/videoSession.model");

const { runInBackground, flushBackground } = require("./background");

// ChatSession has no CONNECTING/ENDING/MISSED; map to the closest legacy status.
const CHAT_STATUS = {
    PENDING: "PENDING", CONNECTING: "PENDING", ACTIVE: "ACTIVE", ENDING: "ACTIVE",
    COMPLETED: "COMPLETED", REJECTED: "REJECTED", CANCELLED: "CANCELLED", MISSED: "CANCELLED"
};
const VIDEO_STATUS = {
    PENDING: "PENDING", CONNECTING: "PENDING", ACTIVE: "ACTIVE", ENDING: "ACTIVE",
    COMPLETED: "COMPLETED", REJECTED: "REJECTED", CANCELLED: "CANCELLED", MISSED: "MISSED"
};

const toPlain = (s) => (s && typeof s.toObject === "function" ? s.toObject() : s);

const mirrorNow = async (sessionDoc) => {
    const s = toPlain(sessionDoc);
    if (!s) return;

    const common = {
        user: s.user,
        astrologer: s.astrologer,
        perMinuteRate: s.perMinuteRate,
        sessionCode: s.sessionCode,
        startTime: s.startedAt || s.startTime || null,
        endTime: s.endedAt || s.endTime || null,
        rejectionReason: s.rejectionReason || s.endReason || null,
        totalDurationSeconds: s.totalDurationSeconds || 0,
        totalDurationMinutes: s.totalDurationMinutes || 0,
        totalAmountDeducted: s.totalAmountDeducted || 0,
        astrologerEarnings: s.astrologerEarnings || 0,
        platformFee: s.platformFee || 0,
        promoSeconds: s.promoSeconds || 0
    };

    if (s.type === "CHAT") {
        await ChatSession.findOneAndUpdate(
            { _id: s._id },
            { $set: { ...common, status: CHAT_STATUS[s.status] || "PENDING" } },
            { upsert: true, setDefaultsOnInsert: true }
        );
    } else {
        await VideoSession.findOneAndUpdate(
            { _id: s._id },
            {
                $set: {
                    ...common,
                    status: VIDEO_STATUS[s.status] || "PENDING",
                    callType: s.type,
                    provider: "Agora",
                    roomId: s.roomId,
                    channelName: s.channelName,
                    duration: s.totalDurationMinutes || 0
                }
            },
            { upsert: true, setDefaultsOnInsert: true }
        );
    }
};

/** Fire-and-forget mirror; failures are logged, never thrown into the lifecycle. */
const scheduleMirror = (sessionDoc) => runInBackground(mirrorNow(sessionDoc), "legacy mirror");

module.exports = { scheduleMirror, flushMirrors: flushBackground, mirrorNow };
