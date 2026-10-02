const express = require("express");

const router = express.Router();

const authController = require("../controllers/auth.controller");
const { rateLimit } = require("../utils/rateLimit");

// Per-IP limits. Per-number limits (cooldown, send cap, wrong-guess cap) live in auth.service.
const sendOtpLimiter = rateLimit({ keyPrefix: "otp-send", windowMs: 15 * 60 * 1000, max: 20, message: "Too many OTP requests. Please try again in a few minutes." });
const verifyOtpLimiter = rateLimit({ keyPrefix: "otp-verify", windowMs: 15 * 60 * 1000, max: 60, message: "Too many attempts. Please try again in a few minutes." });
const refreshLimiter = rateLimit({ keyPrefix: "auth-refresh", windowMs: 15 * 60 * 1000, max: 120 });

router.post("/send-otp", sendOtpLimiter, authController.sendOtp);
router.post("/verify-otp", verifyOtpLimiter, authController.verifyOtp);
router.post("/refresh", refreshLimiter, authController.refresh);

module.exports = router;
