const mongoose = require("mongoose");
const Astrologer = require("../models/astro.model");
const PromoPayout = require("../models/promoPayout.model");
const settingsService = require("../services/settings.service");
const { logAudit } = require("../utils/audit");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const audit = (req, entry) => { req.skipAutoAudit = true; logAudit(req, req.admin, entry); };
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const amountFor = (seconds, rate) => round2((seconds / 60) * rate);

const overview = async (req, res) => {
    const { promoPayoutPerMinute: rate } = await settingsService.getSettings();
    const owed = await Astrologer.find({ promoSecondsPending: { $gt: 0 } }).select("name phone email profileImage promoSecondsPending promoSecondsEarnedTotal").sort({ promoSecondsPending: -1 }).lean();
    const paid = await PromoPayout.aggregate([{ $group: { _id: null, seconds: { $sum: "$seconds" }, amount: { $sum: "$amount" } } }]);
    const pendingSeconds = owed.reduce((s, a) => s + a.promoSecondsPending, 0);
    res.json({
        success: true,
        data: {
            ratePerMinute: rate,
            totals: { pendingSeconds, amountDue: amountFor(pendingSeconds, rate), paidSeconds: paid[0]?.seconds || 0, paidAmount: round2(paid[0]?.amount || 0) },
            astrologers: owed.map((a) => ({
                id: String(a._id), name: a.name, phone: a.phone, email: a.email, avatar: a.profileImage || null,
                pendingSeconds: a.promoSecondsPending, amountDue: amountFor(a.promoSecondsPending, rate), earnedTotalSeconds: a.promoSecondsEarnedTotal || 0
            }))
        }
    });
};

const setRate = async (req, res) => {
    const rate = Number(req.body && req.body.ratePerMinute);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1000) return fail(res, 400, "Rate must be between ₹0 and ₹1000 per minute");
    const before = (await settingsService.getSettings()).promoPayoutPerMinute;
    const after = await settingsService.updateSettings({ promoPayoutPerMinute: round2(rate) }, req.admin._id);
    audit(req, { action: "promopayouts.rate", module: "promopayouts", statusCode: 200, summary: `Changed promo payout rate ₹${before} → ₹${after.promoPayoutPerMinute} per minute` });
    res.json({ success: true, data: { ratePerMinute: after.promoPayoutPerMinute } });
};

// Marks everything owed to one astrologer as paid and resets it to 0. expectedSeconds must match what the admin saw,
// so a session that settled in the meantime can never be wiped without being paid. The claim is atomic (no double pay).
const markPaid = async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.astrologerId)) return fail(res, 400, "Invalid astrologer");
    const expected = Number(req.body && req.body.expectedSeconds);
    if (!Number.isInteger(expected) || expected <= 0) return fail(res, 400, "expectedSeconds is required");
    const claimed = await Astrologer.findOneAndUpdate(
        { _id: req.params.astrologerId, promoSecondsPending: expected },
        { $set: { promoSecondsPending: 0 } },
        { new: false }
    ).select("name");
    if (!claimed) return fail(res, 409, "The amount changed or was already paid. Refresh the page and check again.");

    const { promoPayoutPerMinute: rate } = await settingsService.getSettings();
    const payout = await PromoPayout.create({
        astrologer: claimed._id, seconds: expected, ratePerMinute: rate, amount: amountFor(expected, rate),
        reference: String((req.body && req.body.reference) || "").slice(0, 120), note: String((req.body && req.body.note) || "").slice(0, 300),
        paidBy: req.admin._id, paidByName: req.admin.name
    });
    audit(req, { action: "promopayouts.paid", module: "promopayouts", statusCode: 200, summary: `Paid ₹${payout.amount} promo payout to ${claimed.name}`, details: { seconds: expected, rate, reference: payout.reference } });
    res.json({ success: true, data: payout });
};

const history = async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = mongoose.Types.ObjectId.isValid(req.query.astrologerId) ? { astrologer: req.query.astrologerId } : {};
    const [items, total] = await Promise.all([
        PromoPayout.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("astrologer", "name phone").lean(),
        PromoPayout.countDocuments(filter)
    ]);
    res.json({ success: true, data: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

module.exports = { overview, setRate, markPaid, history };
