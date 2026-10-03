const mongoose = require("mongoose");
const Banner = require("../models/banner.model");
const bannerService = require("../services/banner.service");
const cloudinaryService = require("../services/cloudinary.service");
const { logAudit } = require("../utils/audit");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const audit = (req, entry) => { req.skipAutoAudit = true; logAudit(req, req.admin, entry); };
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const uploadedFile = (req) => (req.file && req.file.buffer ? req.file : null);

const parseFields = (b, { partial }) => {
    const out = {};
    if (!partial || b.name !== undefined) {
        const n = String(b.name || "").trim();
        if (!n || n.length > 80) throw Object.assign(new Error("Name is required (max 80 characters)"), { status: 400 });
        out.name = n;
    }
    if (b.route !== undefined) out.route = String(b.route || "").trim().slice(0, 40);
    if (b.order !== undefined && b.order !== "") {
        const o = Number(b.order);
        if (!Number.isFinite(o)) throw Object.assign(new Error("Order must be a number"), { status: 400 });
        out.order = o;
    }
    if (b.status !== undefined) {
        if (!["active", "paused"].includes(b.status)) throw Object.assign(new Error("Invalid status"), { status: 400 });
        out.status = b.status;
    }
    if (b.startsAt !== undefined) out.startsAt = b.startsAt ? new Date(b.startsAt) : null;
    if (b.endsAt !== undefined) out.endsAt = b.endsAt ? new Date(b.endsAt) : null;
    if (out.startsAt && out.endsAt && out.endsAt < out.startsAt) throw Object.assign(new Error("End date must be after the start date"), { status: 400 });
    return out;
};

const send = (res, e) => fail(res, e.status || 500, e.message || "Something went wrong");

// ---------- Admin ----------
const list = async (req, res) => {
    const banners = await Banner.find().sort({ order: 1, createdAt: -1 }).lean();
    res.json({ success: true, data: banners });
};

const create = async (req, res) => {
    try {
        const file = uploadedFile(req);
        if (!file) return fail(res, 400, "Choose a banner image (JPG, JPEG or PNG)");
        const fields = parseFields(req.body || {}, { partial: false });
        if (fields.order === undefined) fields.order = (await Banner.countDocuments()) + 1;
        const image = await bannerService.uploadBannerImage(file.buffer);
        const banner = await Banner.create({ ...fields, ...image, createdBy: req.admin?._id || null });
        audit(req, { action: "banners.create", module: "banners", statusCode: 201, summary: `Created banner ${banner.name}`, details: fields });
        res.status(201).json({ success: true, data: banner });
    } catch (e) { send(res, e); }
};

const update = async (req, res) => {
    try {
        if (!validId(req.params.id)) return fail(res, 400, "Invalid banner");
        const banner = await Banner.findById(req.params.id);
        if (!banner) return fail(res, 404, "Banner not found");
        const fields = parseFields(req.body || {}, { partial: true });
        const file = uploadedFile(req);
        let oldPublicId = null;
        if (file) {
            const image = await bannerService.uploadBannerImage(file.buffer);
            oldPublicId = banner.imagePublicId;
            Object.assign(fields, image);
        }
        banner.set(fields);
        await banner.save();
        if (oldPublicId) cloudinaryService.deleteByPublicId(oldPublicId);
        audit(req, { action: "banners.update", module: "banners", statusCode: 200, summary: `Updated banner ${banner.name}`, details: { ...fields, imageReplaced: !!file } });
        res.json({ success: true, data: banner });
    } catch (e) { send(res, e); }
};

const remove = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid banner");
    const banner = await Banner.findByIdAndDelete(req.params.id);
    if (!banner) return fail(res, 404, "Banner not found");
    cloudinaryService.deleteByPublicId(banner.imagePublicId);
    audit(req, { action: "banners.delete", module: "banners", statusCode: 200, summary: `Deleted banner ${banner.name}` });
    res.json({ success: true, message: "Banner deleted" });
};

// ---------- Public (user app) ----------
// Returns the live banners plus a `version` the app compares to know if anything changed.
const publicList = async (req, res) => {
    const now = new Date();
    const banners = await Banner.find({
        status: "active",
        $and: [
            { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
            { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }
        ]
    }).sort({ order: 1, createdAt: -1 }).lean();

    const data = banners.map((b) => ({ id: String(b._id), imageUrl: b.imageUrl, route: b.route || "", order: b.order }));
    // version changes whenever a banner is added, edited, replaced, reordered, or one leaves its schedule window
    const version = banners.length ? banners.map((b) => `${b._id}:${new Date(b.updatedAt).getTime()}:${b.order}`).join("|") : "empty";
    const etag = `W/"${require("crypto").createHash("sha1").update(version).digest("hex").slice(0, 16)}"`;

    res.set("Cache-Control", "no-cache");
    res.set("ETag", etag);
    if (req.headers["if-none-match"] === etag) return res.status(304).end();
    res.json({ success: true, version: etag, data });
};

module.exports = { list, create, update, remove, publicList };
