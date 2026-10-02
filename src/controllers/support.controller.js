const mongoose = require("mongoose");
const SupportTicket = require("../models/supportTicket.model");
const Payment = require("../models/payment.model");
const ChatSession = require("../models/chatSession.model");
const VideoSession = require("../models/videoSession.model");
const User = require("../models/user.model");
const { nextSeq } = require("../models/counter.model");
const realtime = require("../services/supportRealtime.service");

const CATEGORIES = SupportTicket.CATEGORIES;
const fail = (res, code, message) => res.status(code).json({ success: false, message });
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);

const DAY = 24 * 3600 * 1000;
const MAX_MESSAGES = 60; // stops a thread being used as a dumping ground

const userView = (t, { withMessages = false } = {}) => ({
    id: String(t._id),
    number: t.number,
    status: t.status,
    category: t.category,
    ref: t.ref,
    resolution: t.status === "resolved" || t.status === "rejected" ? t.resolution : "",
    createdAt: t.createdAt,
    lastActivityAt: t.lastActivityAt,
    unread: !!t.userUnread,
    lastMessage: (() => {
        const m = [...(t.messages || [])].reverse().find((x) => !x.internal);
        return m ? { from: m.from, text: m.text.slice(0, 120), createdAt: m.createdAt } : null;
    })(),
    ...(withMessages ? { messages: (t.messages || []).filter((m) => !m.internal).map((m) => ({ id: String(m._id), from: m.from, authorName: m.from === "admin" ? "Support team" : m.authorName, text: m.text, createdAt: m.createdAt })) } : {})
});

// Checks the transaction really belongs to this user and returns a snapshot of it
const resolveTransaction = async (userId, type, id) => {
    if (!validId(id)) return null;
    if (type === "payment") {
        const p = await Payment.findOne({ _id: id, user: userId }).lean();
        if (!p) return null;
        const title = p.paymentGateway === "Admin" ? "Wallet adjustment / reward" : p.appointment ? "Payment for appointment" : "Added Money";
        return { type, id: String(p._id), title, amount: Math.abs(p.walletCredit != null ? p.walletCredit : p.amount), status: p.paymentStatus, transactionId: p.transactionId || p.orderId || String(p._id), date: p.paidAt || p.createdAt, paymentGateway: p.paymentGateway, paymentStatus: p.paymentStatus, createdAt: p.createdAt };
    }
    if (type === "chat" || type === "call") {
        const Model = type === "chat" ? ChatSession : VideoSession;
        const s = await Model.findOne({ _id: id, user: userId }).populate("astrologer", "name").lean();
        if (!s) return null;
        return { type, id: String(s._id), title: `${type === "chat" ? "Chat" : (s.callType === "VIDEO" ? "Video call" : "Audio call")} with ${s.astrologer?.name || "Astrologer"}`, amount: s.totalAmountDeducted || 0, status: String(s.status || "").toLowerCase(), transactionId: s.sessionCode || String(s._id), date: s.startTime || s.createdAt };
    }
    return null;
};

// ---------------- customer ----------------

const createTicket = async (req, res) => {
    const userId = req.user.userId;
    if (req.user.role !== "user") return fail(res, 403, "Only customers can raise a complaint");
    const { refType, refId } = req.body || {};
    const category = String((req.body && req.body.category) || "");
    const message = clean(req.body && req.body.message, 1000);
    if (!CATEGORIES.includes(category)) return fail(res, 400, "Please choose what the problem is");
    if (message.length < 10) return fail(res, 400, "Please describe the problem in at least 10 characters");

    const tx = await resolveTransaction(userId, String(refType), String(refId));
    if (!tx) return fail(res, 404, "We could not find that transaction");

    // A complaint is only meaningful for the right kind of transaction
    if (category === "money_deducted_not_added" && tx.type !== "payment") return fail(res, 400, "This option is only for wallet payments");

    // A previous complaint about the same transaction that is still open
    const open = await SupportTicket.findOne({ user: userId, "ref.type": tx.type, "ref.id": tx.id, status: { $in: ["open", "in_progress"] } });
    if (open) return res.status(409).json({ success: false, message: "You already have an open complaint for this transaction.", data: userView(open) });

    // Throttle: a handful of complaints per day per customer
    const recent = await SupportTicket.countDocuments({ user: userId, createdAt: { $gte: new Date(Date.now() - DAY) } });
    if (recent >= 5) return fail(res, 429, "You have raised several complaints today. Please wait for our reply or try again tomorrow.");

    const user = await User.findById(userId).select("name phone").lean();
    const seq = await nextSeq("support_ticket");
    const money = category === "money_deducted_not_added" || category === "payment_failed" || category === "wrong_amount";
    try {
        const ticket = await SupportTicket.create({
            number: `MJ-${String(seq).padStart(6, "0")}`,
            user: userId,
            ref: { type: tx.type, id: tx.id, title: tx.title, amount: tx.amount, status: tx.status, transactionId: tx.transactionId, date: tx.date },
            category,
            priority: money ? "high" : "normal",
            messages: [{ from: "user", authorName: user?.name || "Customer", text: message }],
            adminUnread: true, userUnread: false
        });
        realtime.notify({ ticket, kind: "created", toUser: false });
        return res.status(201).json({ success: true, data: userView(ticket, { withMessages: true }) });
    } catch (e) {
        if (e && e.code === 11000) return fail(res, 409, "You already have an open complaint for this transaction.");
        throw e;
    }
};

const myTickets = async (req, res) => {
    const list = await SupportTicket.find({ user: req.user.userId }).sort({ lastActivityAt: -1 }).limit(100).lean();
    res.json({ success: true, data: list.map((t) => userView(t)), unread: list.filter((t) => t.userUnread).length });
};

const myTicket = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid complaint");
    const t = await SupportTicket.findOne({ _id: req.params.id, user: req.user.userId });
    if (!t) return fail(res, 404, "Complaint not found");
    if (t.userUnread) { t.userUnread = false; await t.save(); }
    res.json({ success: true, data: userView(t.toObject(), { withMessages: true }) });
};

const myReply = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid complaint");
    const text = clean(req.body && req.body.text, 1000);
    if (text.length < 1) return fail(res, 400, "Write a message first");
    const t = await SupportTicket.findOne({ _id: req.params.id, user: req.user.userId });
    if (!t) return fail(res, 404, "Complaint not found");
    if (t.status === "resolved" || t.status === "rejected") return fail(res, 400, "This complaint is closed. Please raise a new one if you still need help.");
    if (t.messages.length >= MAX_MESSAGES) return fail(res, 400, "This conversation is too long. Please wait for our team to reply.");
    const user = await User.findById(req.user.userId).select("name").lean();
    t.messages.push({ from: "user", authorName: user?.name || "Customer", text });
    t.lastActivityAt = new Date();
    t.adminUnread = true;
    await t.save();
    realtime.notify({ ticket: t, kind: "message", toUser: false });
    res.json({ success: true, data: userView(t.toObject(), { withMessages: true }) });
};

module.exports = { createTicket, myTickets, myTicket, myReply, userView, CATEGORIES };
