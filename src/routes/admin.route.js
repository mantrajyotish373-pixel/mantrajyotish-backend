const express = require("express");

const router = express.Router();

const adminController = require("../controllers/admin.controller");
const teamController = require("../controllers/team.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { requirePermission, requireSuperadmin } = adminMiddleware;
const { rateLimit } = require("../utils/rateLimit");

const loginLimiter = rateLimit({ keyPrefix: "admin-login", windowMs: 15 * 60 * 1000, max: 10, message: "Too many login attempts. Try again in 15 minutes." });
const refreshLimiter = rateLimit({ keyPrefix: "admin-refresh", windowMs: 15 * 60 * 1000, max: 120 });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Session
router.post("/login", loginLimiter, adminController.loginAdmin);
router.post("/refresh", refreshLimiter, adminController.refreshSession);
router.post("/logout", refreshLimiter, adminController.logoutAdmin);

// Logged-in admin's own profile + permissions (any active admin)
router.get("/profile", authMiddleware, adminMiddleware, adminController.getProfile);

// Dashboard (revenue figures are stripped unless the admin has dashboard.financials)
router.get("/dashboard-stats", authMiddleware, requirePermission("dashboard.view"), adminController.getDashboardStats);

// Admin Astrologer CRUD
router.get("/astrologers", authMiddleware, requirePermission("astrologers.view"), adminController.getAstrologers);
router.get("/astrologers/:id", authMiddleware, requirePermission("astrologers.view"), adminController.getAstrologerById);
router.put("/astrologers/:id", authMiddleware, requirePermission("astrologers.edit"), adminController.updateAstrologer);
router.delete("/astrologers/:id", authMiddleware, requirePermission("astrologers.delete"), adminController.deleteAstrologer);

// Super admin only: team, roles, permissions catalog, audit log
router.get("/permissions", authMiddleware, requireSuperadmin, teamController.getPermissionCatalog);

router.get("/roles", authMiddleware, requireSuperadmin, wrap(teamController.listRoles));
router.post("/roles", authMiddleware, requireSuperadmin, wrap(teamController.createRole));
router.put("/roles/:id", authMiddleware, requireSuperadmin, wrap(teamController.updateRole));
router.delete("/roles/:id", authMiddleware, requireSuperadmin, wrap(teamController.deleteRole));

router.get("/team", authMiddleware, requireSuperadmin, wrap(teamController.listTeam));
router.post("/team", authMiddleware, requireSuperadmin, wrap(teamController.createMember));
router.put("/team/:id", authMiddleware, requireSuperadmin, wrap(teamController.updateMember));
router.post("/team/:id/reset-password", authMiddleware, requireSuperadmin, wrap(teamController.resetMemberPassword));
router.delete("/team/:id", authMiddleware, requireSuperadmin, wrap(teamController.deleteMember));

router.get("/audit-logs", authMiddleware, requireSuperadmin, wrap(teamController.listAuditLogs));

module.exports = router;
