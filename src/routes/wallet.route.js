const express = require("express");
const router = express.Router();
const User = require("../models/user.model");
const mongoose = require("mongoose");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");

/**
 * Robust User Resolver: Finds user by MongoDB _id, phone, uniqueId, email, or userLogin
 */
const findUserByIdentifier = async (identifier, phoneFallback = null) => {
    if (!identifier && !phoneFallback) return null;

    let user = null;

    // 1. Try finding by MongoDB ObjectId
    if (identifier && mongoose.Types.ObjectId.isValid(identifier)) {
        user = await User.findById(identifier);
    }

    // 2. Try finding by phone, uniqueId, or email
    if (!user && identifier) {
        user = await User.findOne({
            $or: [
                { phone: identifier },
                { uniqueId: identifier },
                { email: identifier },
                { userLogin: identifier }
            ]
        });
    }

    // 3. Try finding by phoneFallback
    if (!user && phoneFallback) {
        const cleanPhone = phoneFallback.trim();
        user = await User.findOne({
            $or: [
                { phone: cleanPhone },
                { phone: cleanPhone.replace("+91", "") },
                { phone: "+91" + cleanPhone.replace("+91", "") }
            ]
        });
    }

    return user;
};

/**
 * Calculates astrologer stats: total earnings and pending payouts
 */
const calculateAstrologerStats = async (astrologerId) => {
    const VideoSession = require("../models/videoSession.model");
    const ChatSession = require("../models/chatSession.model");
    const Payout = require("../models/payout.model");

    const [calls, chats, payouts] = await Promise.all([
        VideoSession.find({ astrologer: astrologerId, status: "COMPLETED" }),
        ChatSession.find({ astrologer: astrologerId, status: "COMPLETED" }),
        Payout.find({ astrologer: astrologerId, status: "Pending" })
    ]);

    const callEarnings = calls.reduce((sum, s) => sum + (s.astrologerEarnings || 0), 0);
    const chatEarnings = chats.reduce((sum, s) => sum + (s.astrologerEarnings || 0), 0);
    const totalEarnings = callEarnings + chatEarnings;

    const pendingPayout = payouts.reduce((sum, p) => sum + (p.amount || 0), 0);

    return { totalEarnings, pendingPayout };
};

/**
 * GET /api/wallet/balance
 * Returns current wallet balance.
 */
router.get("/balance", async (req, res) => {
    try {
        let identifier = null;
        let role = null;

        // Check JWT token
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            try {
                const { verifyToken } = require("../utils/jwt");
                const decoded = verifyToken(authHeader.split(" ")[1]);
                identifier = decoded.userId || decoded.id || decoded._id || decoded.phone;
                role = decoded.role;
            } catch (err) {}
        }

        // Identity comes only from a verified token. Guests (no / invalid token)
        // get the zero-balance response below instead of someone else's wallet.
        const phoneFallback = null;

        let user = null;
        let astrologer = null;

        if (role === "astrologer") {
            const Astrologer = require("../models/astro.model");
            if (identifier && mongoose.Types.ObjectId.isValid(identifier)) {
                astrologer = await Astrologer.findById(identifier);
            }
            if (!astrologer && identifier) {
                astrologer = await Astrologer.findOne({
                    $or: [
                        { email: identifier },
                        { phone: identifier },
                        { name: identifier }
                    ]
                });
            }
            if (!astrologer && phoneFallback) {
                astrologer = await Astrologer.findOne({ phone: phoneFallback });
            }
        } else {
            user = await findUserByIdentifier(identifier, phoneFallback);
            if (!user && identifier && mongoose.Types.ObjectId.isValid(identifier)) {
                const Astrologer = require("../models/astro.model");
                astrologer = await Astrologer.findById(identifier);
            }
        }

        if (!user && !astrologer) {
            // Return 200 with 0 balance for guest users instead of breaking front-end
            return res.status(200).json({
                success: true,
                data: {
                    walletBalance: 0,
                    name: "Guest User"
                }
            });
        }

        if (astrologer) {
            const { totalEarnings, pendingPayout } = await calculateAstrologerStats(astrologer._id);
            return res.status(200).json({
                success: true,
                data: {
                    walletBalance: astrologer.walletBalance || 0,
                    name: astrologer.name || "Astrologer",
                    totalEarnings,
                    pendingPayout
                }
            });
        }

        return res.status(200).json({
            success: true,
            data: {
                walletBalance: user.walletBalance || 0,
                name: user.name || `${user.firstname || ""} ${user.lastname || ""}`.trim() || user.phone
            }
        });
    } catch (error) {
        console.error("GET /api/wallet/balance error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/wallet/add
 * Adds funds to user's wallet balance in MongoDB.
 * Body: { amount: Number, userId?: String, phone?: String }
 */
router.post("/add", authMiddleware, adminMiddleware.requirePermission("users.wallet"), async (req, res) => {
    try {
        // Admin-only manual credit. Customer top-ups must go through Razorpay
        // (/api/razorpay/order + /verify), which credits the wallet after payment.
        const identifier = req.body.userId || req.body.user_id || req.body.id || null;
        const phoneFallback = req.body.phone || null;
        const { amount } = req.body;

        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({ success: false, message: "Invalid deposit amount. Must be a positive number." });
        }

        const target = await findUserByIdentifier(identifier, phoneFallback);
        if (!target) {
            return res.status(404).json({ success: false, message: "User record not found in system." });
        }

        // Atomic increment so concurrent credits/debits are not lost
        const user = await User.findByIdAndUpdate(
            target._id,
            { $inc: { walletBalance: numericAmount } },
            { new: true }
        );
        const previousBalance = (user.walletBalance || 0) - numericAmount;

        console.log(`💰 Added ₹${numericAmount} to User ${user._id} (${user.phone}). New balance: ₹${user.walletBalance}`);

        return res.status(200).json({
            success: true,
            message: `₹${numericAmount.toFixed(2)} added to wallet successfully`,
            data: {
                previousBalance,
                addedAmount: numericAmount,
                newBalance: user.walletBalance,
                transactionId: `TXN_${Date.now()}`
            }
        });
    } catch (error) {
        console.error("POST /api/wallet/add error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/wallet/update-balance
 * Admins use this to directly adjust a user's wallet balance.
 * Body: { userId: String, amount: Number, action: 'add'|'deduct' }
 */
router.post("/update-balance", authMiddleware, adminMiddleware.requirePermission("users.wallet"), async (req, res) => {
    try {
        const { userId, amount, action } = req.body;
        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({ success: false, message: "Invalid amount. Must be a positive number." });
        }

        const User = require("../models/user.model");
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const previousBalance = user.walletBalance || 0;
        if (action === "deduct") {
            user.walletBalance = Math.max(0, previousBalance - numericAmount);
        } else {
            user.walletBalance = previousBalance + numericAmount;
        }

        await user.save();

        // Create transaction history log in Payment model
        try {
            const Payment = require("../models/payment.model");
            const txnId = `ADJ_${Date.now()}`;
            await Payment.create({
                user: user._id,
                amount: action === "deduct" ? -numericAmount : numericAmount,
                currency: "INR",
                paymentGateway: "Admin",
                transactionId: txnId,
                orderId: txnId,
                paymentStatus: "success",
                paidAt: new Date()
            });
        } catch (paymentErr) {
            console.error("Failed to log admin wallet adjustment to Payment collection:", paymentErr.message);
        }

        console.log(`💰 Admin adjusted User ${user._id} balance. Action: ${action}, Amount: ₹${numericAmount}. Previous: ₹${previousBalance}, New: ₹${user.walletBalance}`);

        return res.status(200).json({
            success: true,
            message: `Wallet balance updated successfully.`,
            data: {
                previousBalance,
                newBalance: user.walletBalance
            }
        });
    } catch (error) {
        console.error("POST /api/wallet/update-balance error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * POST /api/wallet/withdraw
 * Astrologer requests withdrawal of funds.
 * Body: { amount: Number, payoutMethod: 'upi'|'bank', upiId?: String, accountNumber?: String, ifscCode?: String, accountHolder?: String }
 */
router.post("/withdraw", authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== "astrologer") {
            return res.status(403).json({ success: false, message: "Only astrologers can request withdrawals." });
        }

        // Withdrawals are always for the authenticated astrologer
        const identifier = req.user.userId;
        const { amount, payoutMethod, upiId, accountNumber, ifscCode, accountHolder } = req.body;

        const numericAmount = parseFloat(amount);
        if (isNaN(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({ success: false, message: "Invalid withdrawal amount. Must be a positive number." });
        }

        if (numericAmount < 100) {
            return res.status(400).json({ success: false, message: "Minimum withdrawal amount is ₹100." });
        }

        const Astrologer = require("../models/astro.model");
        let astrologer = null;

        if (identifier && mongoose.Types.ObjectId.isValid(identifier)) {
            astrologer = await Astrologer.findById(identifier);
        }
        if (!astrologer && identifier) {
            astrologer = await Astrologer.findOne({ astrologerLogin: identifier });
        }

        if (!astrologer) {
            return res.status(404).json({ success: false, message: "Astrologer record not found in system." });
        }

        if (payoutMethod === "upi" && !upiId) {
            return res.status(400).json({ success: false, message: "UPI ID is required for UPI withdrawal." });
        }

        if (payoutMethod === "bank" && (!accountNumber || !ifscCode || !accountHolder)) {
            return res.status(400).json({ success: false, message: "Complete Bank account details are required." });
        }

        // Atomic conditional deduction: prevents concurrent requests from overdrawing
        const debited = await Astrologer.findOneAndUpdate(
            { _id: astrologer._id, walletBalance: { $gte: numericAmount } },
            { $inc: { walletBalance: -numericAmount } },
            { new: true }
        );
        if (!debited) {
            return res.status(400).json({ success: false, message: "Insufficient wallet balance for withdrawal." });
        }

        // Create Payout request
        const Payout = require("../models/payout.model");
        const payout = await Payout.create({
            astrologer: astrologer._id,
            amount: numericAmount,
            payoutMethod,
            upiId: payoutMethod === "upi" ? upiId : null,
            accountNumber: payoutMethod === "bank" ? accountNumber : null,
            ifscCode: payoutMethod === "bank" ? ifscCode : null,
            accountHolder: payoutMethod === "bank" ? accountHolder : null,
            status: "Pending"
        });

        console.log(`💸 Withdrawal requested by Astrologer ${astrologer._id} for ₹${numericAmount}. Payout ID: ${payout._id}`);

        return res.status(200).json({
            success: true,
            message: `Withdrawal request for ₹${numericAmount.toFixed(2)} submitted successfully.`,
            data: payout
        });

    } catch (error) {
        console.error("POST /api/wallet/withdraw error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/wallet/transactions
 * Returns transaction history for user or astrologer
 */
router.get("/transactions", async (req, res) => {
    try {
        let identifier = null;
        let role = null;

        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
            try {
                const { verifyToken } = require("../utils/jwt");
                const decoded = verifyToken(authHeader.split(" ")[1]);
                identifier = decoded.userId || decoded.id || decoded._id || decoded.phone;
                role = decoded.role;
            } catch (err) {}
        }

        // Identity comes only from a verified token
        const phoneFallback = null;

        let user = null;
        let astrologer = null;

        if (role === "astrologer") {
            const Astrologer = require("../models/astro.model");
            if (identifier && mongoose.Types.ObjectId.isValid(identifier)) {
                astrologer = await Astrologer.findById(identifier);
            }
            if (!astrologer && identifier) {
                astrologer = await Astrologer.findOne({
                    $or: [
                        { email: identifier },
                        { phone: identifier },
                        { name: identifier }
                    ]
                });
            }
            if (!astrologer && phoneFallback) {
                astrologer = await Astrologer.findOne({ phone: phoneFallback });
            }
        } else {
            user = await findUserByIdentifier(identifier, phoneFallback);
            if (!user && identifier && mongoose.Types.ObjectId.isValid(identifier)) {
                const Astrologer = require("../models/astro.model");
                astrologer = await Astrologer.findById(identifier);
            }
        }

        if (!user && !astrologer) {
            return res.status(200).json({ success: true, count: 0, data: [] });
        }

        const VideoSession = require("../models/videoSession.model");
        const ChatSession = require("../models/chatSession.model");
        const Payment = require("../models/payment.model");
        const Payout = require("../models/payout.model");

        const formatKolkataDate = (dateVal) => {
            if (!dateVal) return "Not Specified";
            return new Date(dateVal).toLocaleString("en-GB", {
                timeZone: "Asia/Kolkata",
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                hour12: true
            });
        };

        const txns = [];

        if (astrologer) {
            const [callSessions, chatSessions, payoutList] = await Promise.all([
                VideoSession.find({ astrologer: astrologer._id, status: "COMPLETED" })
                    .sort({ updatedAt: -1 })
                    .limit(20)
                    .populate("user", "name firstname lastname phone")
                    .lean(),
                ChatSession.find({ astrologer: astrologer._id, status: "COMPLETED" })
                    .sort({ updatedAt: -1 })
                    .limit(20)
                    .populate("user", "name firstname lastname phone")
                    .lean(),
                Payout.find({ astrologer: astrologer._id })
                    .sort({ createdAt: -1 })
                    .limit(20)
                    .lean()
            ]);

            callSessions.forEach(s => {
                if (s.astrologerEarnings > 0) {
                    const clientName = s.user?.name || `${s.user?.firstname || ""} ${s.user?.lastname || ""}`.trim() || s.user?.phone || "Client";
                    txns.push({
                        id: String(s._id),
                        transactionId: String(s._id),
                        sessionCode: s.sessionCode || String(s._id),
                        title: `${s.callType === "VIDEO" ? "Video" : "Audio"} Call with ${clientName}`,
                        description: `Session Code: ${s.sessionCode || String(s._id)} | Duration: ${s.totalDurationMinutes || 0} mins`,
                        paymentMethod: `${s.callType === "VIDEO" ? "Video" : "Audio"} Call`,
                        date: formatKolkataDate(s.startTime || s.createdAt),
                        createdAt: s.startTime || s.createdAt,
                        amount: s.astrologerEarnings,
                        status: "Completed",
                        type: "credit",
                        details: {
                            sessionId: String(s._id),
                            sessionCode: s.sessionCode || String(s._id),
                            durationMinutes: s.totalDurationMinutes || 0,
                            durationSeconds: s.totalDurationSeconds || 0,
                            startTime: s.startTime ? formatKolkataDate(s.startTime) : null,
                            endTime: s.endTime ? formatKolkataDate(s.endTime) : null,
                            perMinuteRate: s.perMinuteRate || 0,
                            totalAmountDeducted: s.totalAmountDeducted || 0,
                            astrologerEarnings: s.astrologerEarnings || 0,
                            platformFee: s.platformFee || 0
                        }
                    });
                }
            });

            chatSessions.forEach(s => {
                if (s.astrologerEarnings > 0) {
                    const clientName = s.user?.name || `${s.user?.firstname || ""} ${s.user?.lastname || ""}`.trim() || s.user?.phone || "Client";
                    txns.push({
                        id: String(s._id),
                        transactionId: String(s._id),
                        sessionCode: s.sessionCode || String(s._id),
                        title: `Chat with ${clientName}`,
                        description: `Session Code: ${s.sessionCode || String(s._id)} | Duration: ${s.totalDurationMinutes || 0} mins`,
                        paymentMethod: `Chat Session`,
                        date: formatKolkataDate(s.startTime || s.createdAt),
                        createdAt: s.startTime || s.createdAt,
                        amount: s.astrologerEarnings,
                        status: "Completed",
                        type: "credit",
                        details: {
                            sessionId: String(s._id),
                            sessionCode: s.sessionCode || String(s._id),
                            durationMinutes: s.totalDurationMinutes || 0,
                            durationSeconds: s.totalDurationSeconds || 0,
                            startTime: s.startTime ? formatKolkataDate(s.startTime) : null,
                            endTime: s.endTime ? formatKolkataDate(s.endTime) : null,
                            perMinuteRate: s.perMinuteRate || 0,
                            totalAmountDeducted: s.totalAmountDeducted || 0,
                            astrologerEarnings: s.astrologerEarnings || 0,
                            platformFee: s.platformFee || 0
                        }
                    });
                }
            });

            payoutList.forEach(p => {
                const methodStr = p.payoutMethod === "upi" ? `UPI Withdrawal (${p.upiId})` : `Bank Withdrawal (A/C: ...${String(p.accountNumber).slice(-4)})`;
                txns.push({
                    id: String(p._id),
                    transactionId: `WDR-${String(p._id).slice(-4).toUpperCase()}`,
                    title: methodStr,
                    description: methodStr,
                    paymentMethod: methodStr,
                    date: formatKolkataDate(p.createdAt),
                    createdAt: p.createdAt,
                    amount: p.amount,
                    status: p.status,
                    type: "debit"
                });
            });
        } else {
            const [callSessions, chatSessions] = await Promise.all([
                VideoSession.find({ user: user._id, status: { $in: ["COMPLETED", "ACTIVE"] } })
                    .sort({ updatedAt: -1 })
                    .limit(20)
                    .populate("astrologer", "name")
                    .lean(),
                ChatSession.find({ user: user._id, status: { $in: ["COMPLETED", "ACTIVE"] } })
                    .sort({ updatedAt: -1 })
                    .limit(20)
                    .populate("astrologer", "name")
                    .lean()
            ]);

            callSessions.forEach(s => {
                if (s.totalAmountDeducted > 0) {
                    txns.push({
                        id: String(s._id),
                        transactionId: String(s._id),
                        sessionCode: s.sessionCode || String(s._id),
                        title: `${s.callType === "VIDEO" ? "Video" : "Audio"} Call with ${s.astrologer?.name || "Astrologer"}`,
                        description: `Session Code: ${s.sessionCode || String(s._id)} | Duration: ${s.totalDurationMinutes || 0} mins`,
                        date: formatKolkataDate(s.startTime || s.createdAt),
                        createdAt: s.startTime || s.createdAt,
                        amount: s.totalAmountDeducted,
                        status: "Completed",
                        type: "debit",
                        details: {
                            sessionId: String(s._id),
                            sessionCode: s.sessionCode || String(s._id),
                            durationMinutes: s.totalDurationMinutes || 0,
                            durationSeconds: s.totalDurationSeconds || 0,
                            startTime: s.startTime ? formatKolkataDate(s.startTime) : null,
                            endTime: s.endTime ? formatKolkataDate(s.endTime) : null,
                            perMinuteRate: s.perMinuteRate || 0,
                            totalAmountDeducted: s.totalAmountDeducted || 0,
                            astrologerEarnings: s.astrologerEarnings || 0,
                            platformFee: s.platformFee || 0
                        }
                    });
                }
            });

            chatSessions.forEach(s => {
                if (s.totalAmountDeducted > 0) {
                    txns.push({
                        id: String(s._id),
                        transactionId: String(s._id),
                        sessionCode: s.sessionCode || String(s._id),
                        title: `Chat with ${s.astrologer?.name || "Astrologer"}`,
                        description: `Session Code: ${s.sessionCode || String(s._id)} | Duration: ${s.totalDurationMinutes || 0} mins`,
                        date: formatKolkataDate(s.startTime || s.createdAt),
                        createdAt: s.startTime || s.createdAt,
                        amount: s.totalAmountDeducted,
                        status: "Completed",
                        type: "debit",
                        details: {
                            sessionId: String(s._id),
                            sessionCode: s.sessionCode || String(s._id),
                            durationMinutes: s.totalDurationMinutes || 0,
                            durationSeconds: s.totalDurationSeconds || 0,
                            startTime: s.startTime ? formatKolkataDate(s.startTime) : null,
                            endTime: s.endTime ? formatKolkataDate(s.endTime) : null,
                            perMinuteRate: s.perMinuteRate || 0,
                            totalAmountDeducted: s.totalAmountDeducted || 0,
                            astrologerEarnings: s.astrologerEarnings || 0,
                            platformFee: s.platformFee || 0
                        }
                    });
                }
            });

            // Include Payment (top-up / adjustments) records
            try {
                const payments = await Payment.find({ user: user._id }).sort({ createdAt: -1 }).limit(20).lean();
                payments.forEach(p => {
                    if (p.paymentStatus === "success") {
                        const isDebit = p.amount < 0;
                        txns.push({
                            id: String(p._id),
                            transactionId: p.transactionId || String(p._id),
                            title: p.paymentGateway === "Admin"
                                ? (p.transactionId && p.transactionId.startsWith("SIGNUP_") ? `Signup Reward` : (isDebit ? `Debit Adjustment by Admin` : `Reward from App`))
                                : (p.appointment ? `Payment for appointment` : `Added Money`),
                            date: formatKolkataDate(p.paidAt || p.createdAt),
                            createdAt: p.paidAt || p.createdAt,
                            amount: Math.abs(p.amount),
                            status: "Success",
                            type: isDebit ? "debit" : "credit",
                            meta: {
                                paymentGateway: p.paymentGateway,
                                transactionId: p.transactionId,
                                orderId: p.orderId
                            }
                        });
                    } else if (p.paymentStatus === "failed") {
                        txns.push({
                            id: String(p._id),
                            transactionId: p.transactionId || String(p._id),
                            title: `Failed Payment`,
                            date: formatKolkataDate(p.createdAt),
                            createdAt: p.createdAt,
                            amount: p.amount,
                            status: "Failed",
                            type: "failed",
                            meta: {
                                paymentGateway: p.paymentGateway,
                                transactionId: p.transactionId,
                                orderId: p.orderId
                            }
                        });
                    }
                });
            } catch (e) {
                console.warn("Could not load payments for transactions view:", e.message);
            }
        }

        // Sort descending by date/createdAt
        txns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        return res.status(200).json({
            success: true,
            count: txns.length,
            data: txns
        });
    } catch (error) {
        console.error("GET /api/wallet/transactions error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

/**
 * GET /api/wallet/admin/profit
 * Returns company profit (admin wallet balance and platform fee summary)
 */
router.get("/admin/profit", authMiddleware, adminMiddleware.requirePermission("finance.view"), async (req, res) => {
    try {
        const Admin = require("../models/admin.model");
        const VideoSession = require("../models/videoSession.model");
        const ChatSession = require("../models/chatSession.model");

        const admin = await Admin.findOne({ role: "superadmin" }).sort({ createdAt: 1 });
        
        const [calls, chats] = await Promise.all([
            VideoSession.find({ status: "COMPLETED" }),
            ChatSession.find({ status: "COMPLETED" })
        ]);

        const callProfit = calls.reduce((sum, s) => sum + (s.platformFee || 0), 0);
        const chatProfit = chats.reduce((sum, s) => sum + (s.platformFee || 0), 0);
        const totalPlatformFees = parseFloat((callProfit + chatProfit).toFixed(2));

        return res.status(200).json({
            success: true,
            data: {
                adminWalletBalance: admin ? (admin.walletBalance || 0) : 0,
                totalPlatformFeesCollected: totalPlatformFees,
                callPlatformFees: parseFloat(callProfit.toFixed(2)),
                chatPlatformFees: parseFloat(chatProfit.toFixed(2))
            }
        });
    } catch (error) {
        console.error("GET /api/wallet/admin/profit error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = router;
