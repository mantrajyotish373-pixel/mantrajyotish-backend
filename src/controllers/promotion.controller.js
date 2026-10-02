const mongoose = require("mongoose");
const Promotion = require("../models/promotion.model");
const BonusGrant = require("../models/bonusGrant.model");
const User = require("../models/user.model");
const { logAudit } = require("../utils/audit");
const bonus = require("../services/bonus.service");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const audit = (req, entry) => { req.skipAutoAudit = true; logAudit(req, req.admin, entry); };
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const num = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

// Builds a validated field set from the request body (null clears an optional limit).
const parseFields = (b, { partial }) => {
    const out = {};
    if (!partial || b.name !== undefined) {
        const n = String(b.name || "").trim();
        if (!n || n.length > 80) throw new Error("Name is required (max 80 characters)");
        out.name = n;
    }
    if (!partial || b.amount !== undefined) {
        const a = Number(b.amount);
        if (!Number.isFinite(a) || a <= 0 || a > 100000) throw new Error("Bonus amount must be between ₹1 and ₹1,00,000");
        out.amount = Math.round(a * 100) / 100;
    }
    if (b.status !== undefined) {
        if (!["active", "paused"].includes(b.status)) throw new Error("Invalid status");
        out.status = b.status;
    }
    if (b.startsAt !== undefined) out.startsAt = b.startsAt ? new Date(b.startsAt) : null;
    if (b.endsAt !== undefined) out.endsAt = b.endsAt ? new Date(b.endsAt) : null;
    if (out.startsAt && out.endsAt && out.endsAt < out.startsAt) throw new Error("End date must be after the start date");
    if (b.bonusValidityDays !== undefined) {
        const d = num(b.bonusValidityDays);
        if (d !== null && (!Number.isInteger(d) || d < 1 || d > 3650)) throw new Error("Bonus validity must be 1 to 3650 days, or empty for unlimited");
        out.bonusValidityDays = d;
    }
    if (b.maxRedemptions !== undefined) {
        const m = num(b.maxRedemptions);
        if (m !== null && (!Number.isInteger(m) || m < 1)) throw new Error("Total uses must be a whole number, or empty for unlimited");
        out.maxRedemptions = m;
    }
    if (b.perUserLimit !== undefined) {
        const p = Number(b.perUserLimit);
        if (!Number.isInteger(p) || p < 1 || p > 100) throw new Error("Uses per user must be 1 to 100");
        out.perUserLimit = p;
    }
    if (b.description !== undefined) out.description = String(b.description).slice(0, 300);
    return out;
};

const listPromotions = async (req, res) => {
    const promos = await Promotion.find().sort({ kind: 1, createdAt: -1 }).lean();
    const sums = await BonusGrant.aggregate([
        { $match: { promotion: { $ne: null } } },
        { $group: { _id: "$promotion", granted: { $sum: "$amount" }, remaining: { $sum: "$remaining" } } }
    ]);
    const byPromo = new Map(sums.map((s) => [String(s._id), s]));
    const all = await BonusGrant.aggregate([{ $group: { _id: null, granted: { $sum: "$amount" }, remaining: { $sum: "$remaining" } } }]);
    res.json({
        success: true,
        data: promos.map((p) => ({ ...p, totalGranted: byPromo.get(String(p._id))?.granted || 0, totalUnspent: byPromo.get(String(p._id))?.remaining || 0 })),
        totals: { totalGranted: all[0]?.granted || 0, totalUnspent: all[0]?.remaining || 0 }
    });
};

const createPromotion = async (req, res) => {
    try {
        const b = req.body || {};
        if (b.kind !== "coupon") return fail(res, 400, "Only coupons can be created. The signup bonus already exists, edit it instead.");
        const code = String(b.code || "").trim().toUpperCase();
        if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return fail(res, 400, "Coupon code must be 3 to 30 letters, numbers, - or _");
        if (await Promotion.exists({ code })) return fail(res, 400, "This coupon code already exists");
        const fields = parseFields(b, { partial: false });
        const promo = await Promotion.create({ ...fields, kind: "coupon", code, createdBy: req.admin._id });
        audit(req, { action: "promotions.create", module: "promotions", statusCode: 201, summary: `Created coupon ${code} (₹${promo.amount})`, details: fields });
        res.status(201).json({ success: true, data: promo });
    } catch (e) { fail(res, 400, e.message); }
};

const updatePromotion = async (req, res) => {
    try {
        if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
        const promo = await Promotion.findById(req.params.id);
        if (!promo) return fail(res, 404, "Offer not found");
        const before = promo.toObject();
        const fields = parseFields(req.body || {}, { partial: true });
        if (promo.kind === "coupon" && req.body.code !== undefined) {
            const code = String(req.body.code).trim().toUpperCase();
            if (!/^[A-Z0-9_-]{3,30}$/.test(code)) return fail(res, 400, "Coupon code must be 3 to 30 letters, numbers, - or _");
            if (code !== promo.code && (await Promotion.exists({ code }))) return fail(res, 400, "This coupon code already exists");
            fields.code = code;
        }
        Object.assign(promo, fields);
        await promo.save();
        const diff = Object.fromEntries(Object.keys(fields).filter((k) => String(before[k]) !== String(promo[k])).map((k) => [k, { from: before[k], to: promo[k] }]));
        audit(req, { action: fields.status && before.status !== promo.status ? (promo.status === "active" ? "promotions.resume" : "promotions.pause") : "promotions.update", module: "promotions", statusCode: 200, summary: `Updated ${promo.kind === "signup" ? "signup bonus" : `coupon ${promo.code}`}`, details: diff });
        res.json({ success: true, data: promo });
    } catch (e) { fail(res, 400, e.message); }
};

const deletePromotion = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
    const promo = await Promotion.findById(req.params.id);
    if (!promo) return fail(res, 404, "Offer not found");
    if (promo.kind === "signup") return fail(res, 400, "The signup bonus cannot be deleted. Pause it instead.");
    if (promo.redemptionCount > 0) return fail(res, 400, "This coupon has been used, so it cannot be deleted. Pause it to stop new use.");
    await promo.deleteOne();
    audit(req, { action: "promotions.delete", module: "promotions", statusCode: 200, summary: `Deleted coupon ${promo.code}` });
    res.json({ success: true, message: "Coupon deleted" });
};

// Who received this bonus (or every bonus when :id is "all")
const listGrants = async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = {};
    if (req.params.id && req.params.id !== "all") {
        if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
        filter.promotion = req.params.id;
    }
    if (req.query.source) filter.source = String(req.query.source);
    const [items, total] = await Promise.all([
        BonusGrant.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit)
            .populate("user", "name phone email").populate("promotion", "name code kind").lean(),
        BonusGrant.countDocuments(filter)
    ]);
    res.json({ success: true, data: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

// Manual bonus to one user
const grantManual = async (req, res) => {
    try {
        const b = req.body || {};
        const amount = Number(b.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) return fail(res, 400, "Amount must be between ₹1 and ₹1,00,000");
        let user = null;
        if (b.userId && validId(b.userId)) user = await User.findById(b.userId).select("name phone");
        else if (b.phone) user = await User.findOne({ phone: String(b.phone).trim() }).select("name phone");
        if (!user) return fail(res, 404, "User not found. Check the phone number.");
        const days = num(b.validityDays);
        if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650)) return fail(res, 400, "Validity must be 1 to 3650 days, or empty for unlimited");
        const grant = await bonus.grantBonus({
            userId: user._id, amount, source: "admin", reason: String(b.reason || "Admin bonus").slice(0, 200), createdBy: req.admin._id,
            expiresAt: days ? new Date(Date.now() + days * 86400000) : null, paymentPrefix: "ADMINBONUS"
        });
        audit(req, { action: "promotions.grant", module: "promotions", statusCode: 201, summary: `Gave ₹${amount} bonus to ${user.name || user.phone}`, details: { userId: String(user._id), reason: b.reason || "" } });
        res.status(201).json({ success: true, data: grant });
    } catch (e) { fail(res, e.status || 400, e.message); }
};

module.exports = { listPromotions, createPromotion, updatePromotion, deletePromotion, listGrants, grantManual };
