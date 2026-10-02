const express = require("express");

const router = express.Router();

const adminController = require("../controllers/admin.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { rateLimit } = require("../utils/rateLimit");

const loginLimiter = rateLimit({ keyPrefix: "admin-login", windowMs: 15 * 60 * 1000, max: 10, message: "Too many login attempts. Try again in 15 minutes." });
const refreshLimiter = rateLimit({ keyPrefix: "admin-refresh", windowMs: 15 * 60 * 1000, max: 120 });

// Admin Registration & Login
// Only existing admins can create admin accounts
router.post("/register", authMiddleware, adminMiddleware, adminController.registerAdmin);
router.post("/create", authMiddleware, adminMiddleware, adminController.registerAdmin);
router.post("/login", loginLimiter, adminController.loginAdmin);
router.post("/refresh", refreshLimiter, adminController.refreshSession);
router.post("/logout", refreshLimiter, adminController.logoutAdmin);

// Logged-in Admin Profile
router.get("/profile", authMiddleware, adminMiddleware, adminController.getProfile);

// Dashboard Statistics
router.get("/dashboard-stats", authMiddleware, adminMiddleware, adminController.getDashboardStats);

// Admin Astrologer CRUD Management
router.get("/astrologers", authMiddleware, adminMiddleware, adminController.getAstrologers);
router.get("/astrologers/:id", authMiddleware, adminMiddleware, adminController.getAstrologerById);
router.put("/astrologers/:id", authMiddleware, adminMiddleware, adminController.updateAstrologer);
router.delete("/astrologers/:id", authMiddleware, adminMiddleware, adminController.deleteAstrologer);

module.exports = router;
