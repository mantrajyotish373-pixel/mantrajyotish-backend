const AddMoneyConfig = require("../models/addMoneyConfig.model");
const { getConfig } = require("../services/addMoneyConfig.service");
const { logAudit } = require("../utils/audit");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const audit = (req, entry) => { req.skipAutoAudit = true; logAudit(req, req.admin, entry); };

const view = (c) => ({
    presets: c.presets.map((p) => ({ amount: p.amount, extraAmount: p.extraAmount || 0, label: p.label || "" })),
    minAmount: c.minAmount, maxAmount: c.maxAmount, extraValidityDays: c.extraValidityDays ?? null,
    gstPercent: c.gstPercent ?? 18
});

const adminGet = async (req, res) => res.json({ success: true, data: view(await getConfig()) });

const adminUpdate = async (req, res) => {
    const b = req.body || {};
    const min = Number(b.minAmount), max = Number(b.maxAmount);
    if (!Number.isFinite(min) || min < 1) return fail(res, 400, "Minimum amount must be at least ₹1");
    if (!Number.isFinite(max) || max < min || max > 1000000) return fail(res, 400, "Maximum amount must be at least the minimum, and at most ₹10,00,000");
    let days = null;
    if (b.extraValidityDays !== "" && b.extraValidityDays !== null && b.extraValidityDays !== undefined) {
        days = Number(b.extraValidityDays);
        if (!Number.isInteger(days) || days < 1 || days > 3650) return fail(res, 400, "Extra bonus validity must be 1 to 3650 days, or empty for no expiry");
    }
    const gst = b.gstPercent === "" || b.gstPercent === undefined ? 18 : Number(b.gstPercent);
    if (!Number.isFinite(gst) || gst < 0 || gst > 100) return fail(res, 400, "GST must be between 0% and 100%");
    if (!Array.isArray(b.presets) || b.presets.length < 1 || b.presets.length > 20) return fail(res, 400, "Add between 1 and 20 quick amounts");
    const seen = new Set();
    const presets = [];
    for (const p of b.presets) {
        const amount = Number(p.amount);
        const extra = Number(p.extraAmount) || 0;
        if (!Number.isFinite(amount) || amount < min || amount > max) return fail(res, 400, `Quick amount ₹${p.amount} must be between ₹${min} and ₹${max}`);
        if (seen.has(amount)) return fail(res, 400, `₹${amount} is listed twice`);
        seen.add(amount);
        if (extra < 0 || extra > 100000) return fail(res, 400, "Extra amount must be between ₹0 and ₹1,00,000");
        presets.push({ amount, extraAmount: Math.round(extra * 100) / 100, label: String(p.label || "").trim().slice(0, 20) });
    }
    const before = view(await getConfig());
    await AddMoneyConfig.updateOne(
        { key: "default" },
        { $set: { presets, minAmount: min, maxAmount: max, extraValidityDays: days, gstPercent: gst, updatedBy: req.admin._id } },
        { upsert: true }
    );
    const after = view(await getConfig());
    audit(req, { action: "addmoney.manage", module: "addmoney", statusCode: 200, summary: "Updated Add Money settings", details: { from: before, to: after } });
    res.json({ success: true, data: after });
};

// Public: what the user app shows on the Add Money screen
const publicGet = async (req, res) => res.json({ success: true, data: view(await getConfig()) });

module.exports = { adminGet, adminUpdate, publicGet };
