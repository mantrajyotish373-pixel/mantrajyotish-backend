const mongoose = require("mongoose");
const Follow = require("../models/follow.model");
const Astrologer = require("../models/astro.model");

const ASTRO_SUMMARY_FIELDS =
    "name profileImage rating totalReviews experience specialization languages consultationFee chatPrice audioCallPrice videoCallPrice isOnline isAvailable followersCount gender status";

const httpError = (status, message) => Object.assign(new Error(message), { status });
const validId = (id) => mongoose.Types.ObjectId.isValid(id);

const follow = async (userId, astroId) => {
    if (!validId(astroId)) throw httpError(400, "Invalid astrologer");
    const astro = await Astrologer.findById(astroId).select("_id status").lean();
    if (!astro || astro.status !== "approved") throw httpError(404, "Astrologer not found");

    const r = await Follow.updateOne({ user: userId, astro: astroId }, { $setOnInsert: { user: userId, astro: astroId } }, { upsert: true });
    if (r.upsertedCount === 1) await Astrologer.updateOne({ _id: astroId }, { $inc: { followersCount: 1 } });
    const updated = await Astrologer.findById(astroId).select("followersCount").lean();
    return { following: true, followersCount: updated ? updated.followersCount : 0 };
};

const unfollow = async (userId, astroId) => {
    if (!validId(astroId)) throw httpError(400, "Invalid astrologer");
    const r = await Follow.deleteOne({ user: userId, astro: astroId });
    if (r.deletedCount === 1) await Astrologer.updateOne({ _id: astroId, followersCount: { $gt: 0 } }, { $inc: { followersCount: -1 } });
    const updated = await Astrologer.findById(astroId).select("followersCount").lean();
    return { following: false, followersCount: updated ? updated.followersCount : 0 };
};

/** Astrologers the user follows, newest first. */
const listFollowing = async (userId) => {
    const rows = await Follow.find({ user: userId }).sort({ createdAt: -1 }).populate("astro", ASTRO_SUMMARY_FIELDS).lean();
    return rows.filter((r) => r.astro && r.astro.status === "approved").map((r) => ({ ...r.astro, followedAt: r.createdAt }));
};

/** Just the astrologer ids, so the app can show Follow / Following on every card cheaply. */
const followingIds = async (userId) => {
    const rows = await Follow.find({ user: userId }).select("astro").lean();
    return rows.map((r) => String(r.astro));
};

/** For the astrologer's own dashboard: total + the most recent followers. */
const followersOf = async (astroId, limit = 50) => {
    const [total, rows] = await Promise.all([
        Follow.countDocuments({ astro: astroId }),
        Follow.find({ astro: astroId }).sort({ createdAt: -1 }).limit(limit).populate("user", "name profileImage").lean()
    ]);
    return {
        total,
        followers: rows.filter((r) => r.user).map((r) => ({ id: String(r.user._id), name: r.user.name || "User", profileImage: r.user.profileImage || null, followedAt: r.createdAt }))
    };
};

const followerUserIds = async (astroId) => (await Follow.find({ astro: astroId }).select("user").lean()).map((r) => r.user);

module.exports = { follow, unfollow, listFollowing, followingIds, followersOf, followerUserIds };
