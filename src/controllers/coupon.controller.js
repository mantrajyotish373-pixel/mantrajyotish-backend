const mongoose = require("mongoose");
const Coupon = require("../models/coupon.model");
const Payment = require("../models/payment.model");
const { logAudit } = require("../utils/audit");
const { METHODS } = require("../services/paymentCoupon.service");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const audit = (req, entry) => { req.skipAutoAudit = true; logAudit(req, req.admin, entry); };
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const nul = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

const parseFields = (b, { partial }) => {
    const out = {};
    if (!partial || b.name !== undefined) {
        const n = String(b.name || "").trim();
        if (!n || n.length > 80) throw new Error("Name is required (max 80 characters)");
        out.name = n;
    }
    if (b.description !== undefined) out.description = String(b.description).trim().slice(0, 200);
    if (!partial || b.discountType !== undefined) {
        if (!["percent", "flat"].includes(b.discountType)) throw new Error("Choose a discount type: percent or flat amount");
        out.discountType = b.discountType;
    }
    if (!partial || b.discountValue !== undefined) {
        const v = Number(b.discountValue);
        const type = out.discountType || b.discountType;
        if (!Number.isFinite(v) || v <= 0) throw new Error("Discount must be greater than 0");
        if (type === "percent" && v > 100) throw new Error("Percent discount cannot be more than 100");
        if (type === "flat" && v > 100000) throw new Error("Flat discount is too large");
        out.discountValue = v;
    }
    if (b.maxDiscount !== undefined) {
        const m = nul(b.maxDiscount);
        if (m !== null && (!Number.isFinite(m) || m < 1)) throw new Error("Maximum discount must be at least ₹1, or empty for no cap");
        out.maxDiscount = m;
    }
    if (b.minAmount !== undefined) {
        const m = nul(b.minAmount) ?? 0;
        if (!Number.isFinite(m) || m < 0) throw new Error("Minimum amount is invalid");
        out.minAmount = m;
    }
    if (b.allowedMethods !== undefined) {
        const list = Array.isArray(b.allowedMethods) ? b.allowedMethods : [];
        if (list.some((m) => !METHODS.includes(m))) throw new Error("Unsupported payment method");
        out.allowedMethods = [...new Set(list)];
    }
    if (b.firstPaymentOnly !== undefined) out.firstPaymentOnly = !!b.firstPaymentOnly;
    if (b.startsAt !== undefined) out.startsAt = b.startsAt ? new Date(b.startsAt) : null;
    if (b.endsAt !== undefined) out.endsAt = b.endsAt ? new Date(b.endsAt) : null;
    if (out.startsAt && out.endsAt && out.endsAt < out.startsAt) throw new Error("End date must be after the start date");
    if (b.maxRedemptions !== undefined) {
        const m = nul(b.maxRedemptions);
        if (m !== null && (!Number.isInteger(m) || m < 1)) throw new Error("Total uses must be a whole number, or empty for unlimited");
        out.maxRedemptions = m;
    }
    if (b.perUserLimit !== undefined) {
        const p = Number(b.perUserLimit);
        if (!Number.isInteger(p) || p < 1 || p > 100) throw new Error("Uses per user must be 1 to 100");
        out.perUserLimit = p;
    }
    if (b.status !== undefined) {
        if (!["active", "paused"].includes(b.status)) throw new Error("Invalid status");
        out.status = b.status;
    }
    return out;
};

const validCode = (raw) => {
    const code = String(raw || "").trim().toUpperCase();
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new Error("Coupon code must be 3 to 30 letters, numbers, - or _");
    return code;
};

const list = async (req, res) => {
    const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();
    const sums = await Payment.aggregate([
        { $match: { coupon: { $ne: null }, paymentStatus: "success" } },
        { $group: { _id: "$coupon", discount: { $sum: "$discountAmount" }, payments: { $sum: 1 } } }
    ]);
    const by = new Map(sums.map((s) => [String(s._id), s]));
    res.json({ success: true, data: coupons.map((c) => ({ ...c, totalDiscount: by.get(String(c._id))?.discount || 0, paymentsCount: by.get(String(c._id))?.payments || 0 })) });
};

const create = async (req, res) => {
    try {
        const b = req.body || {};
        const code = validCode(b.code);
        if (await Coupon.exists({ code })) return fail(res, 400, "This coupon code already exists");
        const fields = parseFields(b, { partial: false });
        const c = await Coupon.create({ ...fields, code, createdBy: req.admin._id });
        audit(req, { action: "promotions.create", module: "promotions", statusCode: 201, summary: `Created payment coupon ${code}`, details: fields });
        res.status(201).json({ success: true, data: c });
    } catch (e) { fail(res, 400, e.message); }
};

const update = async (req, res) => {
    try {
        if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
        const c = await Coupon.findById(req.params.id);
        if (!c) return fail(res, 404, "Coupon not found");
        const fields = parseFields({ discountType: c.discountType, ...(req.body || {}) }, { partial: true });
        if (req.body.code !== undefined) {
            const code = validCode(req.body.code);
            if (code !== c.code) {
                if (c.redemptionCount > 0) return fail(res, 400, "A used coupon's code cannot be changed");
                if (await Coupon.exists({ code })) return fail(res, 400, "This coupon code already exists");
                fields.code = code;
            }
        }
        Object.assign(c, fields);
        await c.save();
        audit(req, { action: "promotions.update", module: "promotions", statusCode: 200, summary: `Updated payment coupon ${c.code}`, details: fields });
        res.json({ success: true, data: c });
    } catch (e) { fail(res, 400, e.message); }
};

const remove = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
    const c = await Coupon.findById(req.params.id);
    if (!c) return fail(res, 404, "Coupon not found");
    if (c.redemptionCount > 0 || (await Payment.exists({ coupon: c._id }))) return fail(res, 400, "This coupon has been used, so it cannot be deleted. Pause it to stop new use.");
    await c.deleteOne();
    audit(req, { action: "promotions.delete", module: "promotions", statusCode: 200, summary: `Deleted payment coupon ${c.code}` });
    res.json({ success: true, message: "Coupon deleted" });
};

module.exports = { list, create, update, remove };
