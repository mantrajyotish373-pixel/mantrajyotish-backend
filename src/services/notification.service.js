const mongoose = require("mongoose");
const Notification = require("../models/notification.model");
const Astrologer = require("../models/astro.model");
const followService = require("./follow.service");

/**
 * Tells everyone who follows an astrologer that they are live (or online).
 * Call this when an astrologer starts a live session:
 *   await notificationService.notifyFollowers(astroId, "astro_live");
 * Safe to call repeatedly: the same astrologer notifies the same follower at most once per cooldown window.
 */
const COOLDOWN_MS = 30 * 60 * 1000;
const COPY = {
    astro_live: (name) => ({ title: `${name} is live now`, body: "Join their live session and ask your questions." }),
    astro_online: (name) => ({ title: `${name} is online`, body: "Start a chat or call now." })
};

const notifyFollowers = async (astroId, type = "astro_live") => {
    const astro = await Astrologer.findById(astroId).select("name").lean();
    if (!astro) return { sent: 0 };
    const userIds = await followService.followerUserIds(astroId);
    if (!userIds.length) return { sent: 0 };

    // Skip followers who already got this exact alert recently
    const since = new Date(Date.now() - COOLDOWN_MS);
    const recent = await Notification.find({ user: { $in: userIds }, type, "data.astroId": String(astroId), createdAt: { $gte: since } }).select("user").lean();
    const skip = new Set(recent.map((n) => String(n.user)));
    const targets = userIds.filter((u) => !skip.has(String(u)));
    if (!targets.length) return { sent: 0 };

    const { title, body } = (COPY[type] || COPY.astro_live)(astro.name || "An astrologer");
    await Notification.insertMany(targets.map((user) => ({ user, type, title, body, data: { astroId: String(astroId), astroName: astro.name || "" } })), { ordered: false });
    return { sent: targets.length };
};

const list = async (userId, { limit = 30, before } = {}) => {
    const filter = { user: userId };
    if (before && mongoose.Types.ObjectId.isValid(before)) filter._id = { $lt: before };
    const [items, unread] = await Promise.all([
        Notification.find(filter).sort({ _id: -1 }).limit(Math.min(Number(limit) || 30, 50)).lean(),
        Notification.countDocuments({ user: userId, readAt: null })
    ]);
    return { items, unread };
};

const unreadCount = (userId) => Notification.countDocuments({ user: userId, readAt: null });

const markRead = async (userId, ids) => {
    const filter = { user: userId, readAt: null };
    if (Array.isArray(ids) && ids.length) filter._id = { $in: ids.filter((i) => mongoose.Types.ObjectId.isValid(i)) };
    const r = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
    return r.modifiedCount;
};

module.exports = { notifyFollowers, list, unreadCount, markRead };
