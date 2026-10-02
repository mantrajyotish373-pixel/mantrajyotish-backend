const mongoose = require("mongoose");
const Payment = require("../models/payment.model");
const PaymentEvent = require("../models/paymentEvent.model");
const razorpay = require("./razorpay.controller");
const { logAudit } = require("../utils/audit");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const validId = (id) => mongoose.Types.ObjectId.isValid(id);

// Searchable list of payment events (newest first)
const listEvents = async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const filter = {};
    if (req.query.level && ["info", "warn", "error"].includes(req.query.level)) filter.level = req.query.level;
    if (req.query.source) filter.source = String(req.query.source);
    if (req.query.type) filter.type = new RegExp("^" + String(req.query.type).replace(/[^a-zA-Z0-9_.]/g, ""));
    if (req.query.q) {
        const q = String(req.query.q).trim().slice(0, 60);
        filter.$or = [{ orderId: q }, { paymentId: q }];
        if (validId(q)) { filter.$or.push({ payment: q }, { user: q }); }
    }
    if (req.query.paymentId && validId(req.query.paymentId)) filter.payment = req.query.paymentId;
    const [items, total] = await Promise.all([
        PaymentEvent.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate("user", "name phone").lean(),
        PaymentEvent.countDocuments(filter)
    ]);
    res.json({ success: true, data: items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
};

// Payments that need attention: held for review, wallet credit unfinished, or stuck pending
const attention = async (req, res) => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    const rows = await Payment.find({
        paymentGateway: "Razorpay",
        $or: [
            { needsReview: true },
            { paymentStatus: "success", creditPending: true },
            { paymentStatus: "pending", createdAt: { $lte: tenMinAgo, $gte: new Date(Date.now() - 7 * 24 * 3600 * 1000) } }
        ]
    }).sort({ createdAt: -1 }).limit(100).populate("user", "name phone").lean();
    const reasonOf = (p) => (p.needsReview ? `Held for review: ${p.reviewReason || ""}` : p.creditPending ? "Paid but wallet credit not finished" : "Pending for more than 10 minutes");
    res.json({ success: true, data: rows.map((p) => ({ ...p, attentionReason: reasonOf(p) })) });
};

// Asks Razorpay what happened to this payment and settles our record
const recheck = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
    const payment = await Payment.findById(req.params.id);
    if (!payment || !payment.orderId) return fail(res, 404, "Payment not found");
    const r = await razorpay.reconcileOrder(payment.orderId, { source: "admin", req });
    req.skipAutoAudit = true;
    logAudit(req, req.admin, { action: "payments.recheck", module: "payments", statusCode: 200, summary: `Re-checked payment ${payment.orderId}: ${r.status}`, details: { orderId: payment.orderId, result: r.status } });
    res.json({ success: true, data: { status: r.status, creditedAmount: r.creditedAmount ?? null } });
};

module.exports = { listEvents, attention, recheck };
