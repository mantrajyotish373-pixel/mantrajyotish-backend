const mongoose = require("mongoose");
const Payout = require("../models/payout.model");
const Astrologer = require("../models/astro.model");
const { logAudit } = require("../utils/audit");

const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;
const IST = { timeZone: "Asia/Kolkata" };
const uiStatus = { Pending: "Pending", Completed: "Approved", Rejected: "Rejected" };

const toView = (p) => {
    const a = p.astrologer || {};
    const created = new Date(p.createdAt);
    const account = p.payoutMethod === "upi"
        ? `UPI ID ${p.upiId || "N/A"}`
        : `${p.accountHolder || "N/A"} | A/C ${p.accountNumber || "N/A"} | IFSC ${p.ifscCode || "N/A"}`;
    return {
        id: String(p._id),
        displayId: `#WR${String(p._id).slice(-6).toUpperCase()}`,
        user: { name: a.name || "Astrologer", email: a.email || "N/A", avatar: a.profileImage || null },
        amount: inr(p.amount),
        amountVal: p.amount,
        method: p.payoutMethod === "upi" ? "UPI" : "Bank Transfer",
        accountDetails: account,
        requestedOn: {
            date: created.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", ...IST }),
            time: created.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true, ...IST })
        },
        status: uiStatus[p.status] || p.status
    };
};

const getAllWithdrawals = async (req, res) => {
    const payouts = await Payout.find().sort({ createdAt: -1 }).limit(1000).populate("astrologer", "name email profileImage").lean();
    res.json({ success: true, data: payouts.map(toView) });
};

// Approve = the admin has transferred the money outside the platform; the wallet was already debited at request time.
const approveWithdrawal = async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const payout = await Payout.findOneAndUpdate(
        { _id: req.params.id, status: "Pending" },
        { status: "Completed", processedBy: req.admin._id, processedAt: new Date() },
        { new: true }
    );
    if (!payout) return res.status(409).json({ success: false, message: "Request not found or already processed" });
    res.json({ success: true, message: "Withdrawal marked as paid" });
};

// Reject = refund the amount that was held from the astrologer's wallet. The Pending->Rejected claim is
// atomic, so a double click or two admins can never refund twice.
const rejectWithdrawal = async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ success: false, message: "Invalid id" });
    const payout = await Payout.findOneAndUpdate(
        { _id: req.params.id, status: "Pending" },
        { status: "Rejected", processedBy: req.admin._id, processedAt: new Date() },
        { new: true }
    );
    if (!payout) return res.status(409).json({ success: false, message: "Request not found or already processed" });
    await Astrologer.updateOne({ _id: payout.astrologer }, { $inc: { walletBalance: payout.amount } });
    logAudit(req, req.admin, { action: "withdrawals.refund", module: "withdrawals", statusCode: 200, summary: `Refunded ${inr(payout.amount)} to astrologer wallet`, details: { payoutId: String(payout._id) } });
    res.json({ success: true, message: "Withdrawal rejected and amount refunded to the astrologer's wallet" });
};

module.exports = { getAllWithdrawals, approveWithdrawal, rejectWithdrawal };
