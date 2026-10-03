const followService = require("../services/follow.service");
const Astrologer = require("../models/astro.model");

const send = (res, e) => res.status(e.status || 500).json({ success: false, message: e.message || "Something went wrong" });
const onlyUsers = (req, res) => {
    if (req.user.role === "user") return true;
    res.status(403).json({ success: false, message: "Only users can follow astrologers" });
    return false;
};

const follow = async (req, res) => {
    if (!onlyUsers(req, res)) return;
    try { res.json({ success: true, data: await followService.follow(req.user.userId, req.params.astroId) }); } catch (e) { send(res, e); }
};

const unfollow = async (req, res) => {
    if (!onlyUsers(req, res)) return;
    try { res.json({ success: true, data: await followService.unfollow(req.user.userId, req.params.astroId) }); } catch (e) { send(res, e); }
};

const mine = async (req, res) => {
    if (!onlyUsers(req, res)) return;
    try { res.json({ success: true, data: await followService.listFollowing(req.user.userId) }); } catch (e) { send(res, e); }
};

const ids = async (req, res) => {
    if (!onlyUsers(req, res)) return;
    try { res.json({ success: true, data: await followService.followingIds(req.user.userId) }); } catch (e) { send(res, e); }
};

// Astrologer's own followers (total + recent list)
const myFollowers = async (req, res) => {
    try {
        const id = String(req.user.userId);
        const astro = await Astrologer.findOne({ $or: [{ _id: id }, { astrologerLogin: id }] }).select("_id").lean();
        if (!astro) return res.status(403).json({ success: false, message: "Forbidden - Astrologer access required" });
        res.json({ success: true, data: await followService.followersOf(astro._id, Math.min(Number(req.query.limit) || 50, 100)) });
    } catch (e) { send(res, e); }
};

module.exports = { follow, unfollow, mine, ids, myFollowers };
