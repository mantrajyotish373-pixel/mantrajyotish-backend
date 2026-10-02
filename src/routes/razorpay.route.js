const express = require("express");
const router = express.Router();

const razorpayController = require("../controllers/razorpay.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const { rateLimit } = require("../utils/rateLimit");

const orderLimiter = rateLimit({ keyPrefix: "rzp-order", windowMs: 10 * 60 * 1000, max: 20, message: "Too many payment attempts. Please try again in a few minutes." });
const verifyLimiter = rateLimit({ keyPrefix: "rzp-verify", windowMs: 10 * 60 * 1000, max: 60, message: "Too many requests. Please try again shortly." });
const statusLimiter = rateLimit({ keyPrefix: "rzp-status", windowMs: 5 * 60 * 1000, max: 120 });

// Payment-page coupons
router.get("/coupons", authMiddleware, razorpayController.listCoupons);
router.post("/coupons/validate", authMiddleware, razorpayController.validateCoupon);

// Create order for client
router.post("/order", orderLimiter, authMiddleware, razorpayController.createOrder);

// Verify payment signature from client
router.post("/verify", verifyLimiter, authMiddleware, razorpayController.verifyPayment);

// Where did this payment end up? (after a UPI redirect, a failure, or when the app is reopened)
router.get("/status/:orderId", statusLimiter, authMiddleware, razorpayController.paymentStatus);

// The app reports how the checkout ended (cancelled / failed); the server verifies with Razorpay
router.post("/checkout-result", verifyLimiter, authMiddleware, razorpayController.checkoutResult);

// Webhook endpoint (Razorpay will POST here)
router.post("/webhook", express.raw({ type: 'application/json' }), razorpayController.webhookHandler);

module.exports = router;
