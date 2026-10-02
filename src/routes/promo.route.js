const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/auth.middleware");
const { rateLimit } = require("../utils/rateLimit");
const User = require("../models/user.model");
const { redeemCoupon, PromoError } = require("../services/bonus.service");

// Stops anyone guessing coupon codes
const limiter = rateLimit({ keyPrefix: "coupon-redeem", windowMs: 15 * 60 * 1000, max: 20, message: "Too many attempts. Please try again later." });

router.post("/redeem", limiter, authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== "user") return res.status(403).json({ success: false, message: "Only customers can redeem coupons" });
        const { grant } = await redeemCoupon(req.user.userId, req.body && req.body.code);
        const user = await User.findById(req.user.userId).select("walletBalance").lean();
        res.json({ success: true, message: `₹${grant.amount} added to your wallet`, data: { amount: grant.amount, walletBalance: user.walletBalance } });
    } catch (e) {
        if (e instanceof PromoError) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
        console.error("POST /api/promo/redeem error:", e);
        res.status(500).json({ success: false, message: "Could not redeem coupon" });
    }
});

module.exports = router;
