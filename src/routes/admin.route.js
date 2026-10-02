const express = require("express");

const router = express.Router();

const adminController = require("../controllers/admin.controller");
const teamController = require("../controllers/team.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { requirePermission, requireSuperadmin } = adminMiddleware;
const settingsController = require("../controllers/settings.controller");
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

// Own account: profile, password, login sessions (any active admin)
const passwordLimiter = rateLimit({ keyPrefix: "admin-password", windowMs: 15 * 60 * 1000, max: 10, message: "Too many password attempts. Try again later." });
router.put("/profile", authMiddleware, adminMiddleware, wrap(settingsController.updateProfile));
router.put("/password", passwordLimiter, authMiddleware, adminMiddleware, wrap(settingsController.changePassword));
router.post("/sessions", authMiddleware, adminMiddleware, wrap(settingsController.listSessions));
router.post("/sessions/revoke-others", authMiddleware, adminMiddleware, wrap(settingsController.revokeOthers));
router.delete("/sessions/:sid", authMiddleware, adminMiddleware, wrap(settingsController.revokeSession));

// Platform settings and system status (super admin only)
router.get("/settings", authMiddleware, requireSuperadmin, wrap(settingsController.getPlatformSettings));
router.put("/settings", authMiddleware, requireSuperadmin, wrap(settingsController.updatePlatformSettings));
router.get("/system-info", authMiddleware, requireSuperadmin, wrap(settingsController.getSystemInfo));

// Dashboard (revenue figures are stripped unless the admin has dashboard.financials)
router.get("/dashboard-stats", authMiddleware, requirePermission("dashboard.view"), adminController.getDashboardStats);

// Consultation history (appointments + chat + call sessions)
router.get("/bookings", authMiddleware, requirePermission("bookings.view"), wrap(adminController.getBookings));

// Admin Astrologer CRUD
router.get("/astrologers", authMiddleware, requirePermission("astrologers.view"), adminController.getAstrologers);
router.get("/astrologers/:id", authMiddleware, requirePermission("astrologers.view"), adminController.getAstrologerById);
router.put("/astrologers/:id", authMiddleware, requirePermission("astrologers.edit"), adminController.updateAstrologer);
router.delete("/astrologers/:id", authMiddleware, requirePermission("astrologers.delete"), adminController.deleteAstrologer);

// Super admin only: team, roles, permissions catalog, audit log
router.get("/permissions", authMiddleware, adminMiddleware, teamController.getPermissionCatalog);

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
