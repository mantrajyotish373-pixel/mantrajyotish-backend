const mongoose = require("mongoose");
const SupportTicket = require("../models/supportTicket.model");
const Payment = require("../models/payment.model");
const PaymentEvent = require("../models/paymentEvent.model");
const Admin = require("../models/admin.model");
const { logAudit } = require("../utils/audit");
const realtime = require("../services/supportRealtime.service");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
const audit = (req, entry) => { req.skipAutoAudit = true; logAudit(req, req.admin, entry); };
const STATUSES = ["open", "in_progress", "resolved", "rejected"];

const row = (t) => ({
    id: String(t._id), number: t.number, status: t.status, priority: t.priority, category: t.category,
    ref: t.ref, user: t.user, assignedTo: t.assignedTo, createdAt: t.createdAt, lastActivityAt: t.lastActivityAt,
    adminUnread: !!t.adminUnread,
    preview: (() => { const m = [...(t.messages || [])].reverse().find((x) => !x.internal); return m ? m.text.slice(0, 100) : ""; })()
});

const list = async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const filter = {};
    if (STATUSES.includes(req.query.status)) filter.status = req.query.status;
    else if (req.query.status === "active") filter.status = { $in: ["open", "in_progress"] };
    if (req.query.priority === "high") filter.priority = "high";
    if (req.query.mine === "1") filter.assignedTo = req.admin._id;
    if (req.query.q) {
        const q = String(req.query.q).trim().slice(0, 40);
        const or = [{ number: new RegExp("^" + q.replace(/[^A-Za-z0-9-]/g, ""), "i") }, { "ref.transactionId": q }];
        if (validId(q)) or.push({ user: q });
        filter.$or = or;
    }
    const [items, total, counts] = await Promise.all([
        SupportTicket.find(filter).sort({ priority: -1, lastActivityAt: -1 }).skip((page - 1) * limit).limit(limit)
            .populate("user", "name phone").populate("assignedTo", "name").lean(),
        SupportTicket.countDocuments(filter),
        SupportTicket.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])
    ]);
    const byStatus = Object.fromEntries(counts.map((c) => [c._id, c.n]));
    res.json({ success: true, data: items.map(row), pagination: { page, limit, total, pages: Math.ceil(total / limit) }, counts: { open: byStatus.open || 0, in_progress: byStatus.in_progress || 0, resolved: byStatus.resolved || 0, rejected: byStatus.rejected || 0 } });
};

const detail = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
    const t = await SupportTicket.findById(req.params.id).populate("user", "name phone email walletBalance").populate("assignedTo", "name").populate("resolvedBy", "name").lean();
    if (!t) return fail(res, 404, "Complaint not found");
    if (t.adminUnread) await SupportTicket.updateOne({ _id: t._id }, { $set: { adminUnread: false } });

    // For payment complaints, give the agent the real payment record and its trail so they can decide without leaving this page
    let payment = null, events = [];
    if (t.ref.type === "payment" && validId(t.ref.id)) {
        payment = await Payment.findById(t.ref.id).select("-__v").lean();
        if (payment) events = await PaymentEvent.find({ payment: payment._id }).sort({ createdAt: 1 }).limit(60).select("createdAt type level message source").lean();
    }
    res.json({ success: true, data: { ...t, id: String(t._id), payment, events } });
};

const reply = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
    const text = clean(req.body && req.body.text, 1500);
    if (!text) return fail(res, 400, "Write a message first");
    const internal = !!(req.body && req.body.internal);
    const t = await SupportTicket.findById(req.params.id);
    if (!t) return fail(res, 404, "Complaint not found");
    if (!internal && (t.status === "resolved" || t.status === "rejected")) return fail(res, 400, "This complaint is closed. Reopen it first to reply to the customer.");
    t.messages.push({ from: "admin", authorName: req.admin.name || "Support", authorAdmin: req.admin._id, text, internal });
    t.lastActivityAt = new Date();
    if (!internal) {
        t.userUnread = true;
        if (t.status === "open") t.status = "in_progress";
        if (!t.assignedTo) t.assignedTo = req.admin._id;
    }
    t.adminUnread = false;
    await t.save();
    realtime.notify({ ticket: t, kind: "message", toUser: !internal });
    audit(req, { action: "support.reply", module: "support", statusCode: 200, summary: `${internal ? "Added a note to" : "Replied to"} complaint ${t.number}` });
    res.json({ success: true });
};

// status / assignment / resolution
const update = async (req, res) => {
    if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
    const t = await SupportTicket.findById(req.params.id);
    if (!t) return fail(res, 404, "Complaint not found");
    const b = req.body || {};
    const before = { status: t.status, assignedTo: t.assignedTo ? String(t.assignedTo) : null };

    if (b.assignedTo !== undefined) {
        if (b.assignedTo === null || b.assignedTo === "") t.assignedTo = null;
        else {
            if (!validId(b.assignedTo) || !(await Admin.exists({ _id: b.assignedTo, status: { $ne: "disabled" } }))) return fail(res, 400, "Choose a valid team member");
            t.assignedTo = b.assignedTo;
        }
    }
    if (b.priority !== undefined) {
        if (!["normal", "high"].includes(b.priority)) return fail(res, 400, "Invalid priority");
        t.priority = b.priority;
    }
    if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return fail(res, 400, "Invalid status");
        const resolution = clean(b.resolution, 1000);
        if ((b.status === "resolved" || b.status === "rejected") && resolution.length < 5) {
            return fail(res, 400, `Write a short note for the customer explaining why this is ${b.status === "resolved" ? "resolved" : "rejected"}`);
        }
        t.status = b.status;
        if (b.status === "resolved" || b.status === "rejected") {
            t.resolution = resolution; t.resolvedAt = new Date(); t.resolvedBy = req.admin._id;
            t.messages.push({ from: "system", authorName: "Support team", text: `${b.status === "resolved" ? "Resolved" : "Closed"}: ${resolution}` });
            t.userUnread = true;
        } else {
            t.resolvedAt = null; t.resolvedBy = null;
            if (before.status === "resolved" || before.status === "rejected") t.messages.push({ from: "system", authorName: "Support team", text: "This complaint was reopened." });
            if (!t.assignedTo) t.assignedTo = req.admin._id;
        }
    }
    t.lastActivityAt = new Date();
    await t.save();
    realtime.notify({ ticket: t, kind: "status" });
    audit(req, { action: "support.update", module: "support", statusCode: 200, summary: `Complaint ${t.number}: ${before.status} → ${t.status}`, details: { before, after: { status: t.status, assignedTo: t.assignedTo ? String(t.assignedTo) : null } } });
    res.json({ success: true });
};

// Team members who can be assigned (anyone who can manage complaints)
const agents = async (req, res) => {
    const admins = await Admin.find({ status: { $ne: "disabled" } }).select("name role permissions").lean();
    res.json({ success: true, data: admins.filter((a) => a.role === "superadmin" || (a.permissions || []).includes("support.manage")).map((a) => ({ id: String(a._id), name: a.name })) });
};

module.exports = { list, detail, reply, update, agents };
