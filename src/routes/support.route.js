const express = require("express");
const router = express.Router();
const support = require("../controllers/support.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const { rateLimit } = require("../utils/rateLimit");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const writeLimiter = rateLimit({ keyPrefix: "support-write", windowMs: 15 * 60 * 1000, max: 30, message: "Too many requests. Please try again shortly." });

// Customer complaints about a transaction
router.post("/tickets", writeLimiter, authMiddleware, wrap(support.createTicket));
router.get("/tickets", authMiddleware, wrap(support.myTickets));
router.get("/tickets/:id", authMiddleware, wrap(support.myTicket));
router.post("/tickets/:id/reply", writeLimiter, authMiddleware, wrap(support.myReply));

module.exports = router;
