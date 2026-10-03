const express = require("express");

const router = express.Router();

const adminController = require("../controllers/admin.controller");
const teamController = require("../controllers/team.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { requirePermission, requireSuperadmin } = adminMiddleware;
const settingsController = require("../controllers/settings.controller");
const promotionController = require("../controllers/promotion.controller");
const promoPayoutController = require("../controllers/promoPayout.controller");
const couponController = require("../controllers/coupon.controller");
const supportAdmin = require("../controllers/supportAdmin.controller");
const paymentLogsController = require("../controllers/paymentLogs.controller");
const addMoneyController = require("../controllers/addMoneyConfig.controller");
const catalogController = require("../controllers/catalog.controller");
const bannerController = require("../controllers/banner.controller");
const multer = require("multer");
const { rateLimit } = require("../utils/rateLimit");

const loginLimiter = rateLimit({ keyPrefix: "admin-login", windowMs: 15 * 60 * 1000, max: 10, message: "Too many login attempts. Try again in 15 minutes." });
const refreshLimiter = rateLimit({ keyPrefix: "admin-refresh", windowMs: 15 * 60 * 1000, max: 120 });

// Banner images: JPG / JPEG / PNG / WebP up to 5 MB, held in memory and converted to WebP by the banner service
const bannerUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (["image/jpeg", "image/png", "image/webp"].includes(String(file.mimetype).toLowerCase())) return cb(null, true);
        return cb(Object.assign(new Error("Upload a JPG, JPEG, PNG or WebP image"), { status: 400 }));
    }
}).single("image");
const acceptBannerImage = (req, res, next) => bannerUpload(req, res, (err) => {
    if (!err) return next();
    const message = err.code === "LIMIT_FILE_SIZE" ? "Image is too large (max 5 MB)" : err.message;
    return res.status(err.status || 400).json({ success: false, message });
});

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

// Offers & Bonus: signup bonus, coupons, bonus history
router.get("/promotions", authMiddleware, requirePermission("promotions.view"), wrap(promotionController.listPromotions));
router.post("/promotions", authMiddleware, requirePermission("promotions.manage"), wrap(promotionController.createPromotion));
router.put("/promotions/:id", authMiddleware, requirePermission("promotions.manage"), wrap(promotionController.updatePromotion));
router.delete("/promotions/:id", authMiddleware, requirePermission("promotions.manage"), wrap(promotionController.deletePromotion));
router.get("/promotions/:id/grants", authMiddleware, requirePermission("promotions.view"), wrap(promotionController.listGrants));
router.post("/bonus-grants", authMiddleware, requirePermission("promotions.manage"), wrap(promotionController.grantManual));

// Customer complaints about transactions
router.get("/support-tickets", authMiddleware, requirePermission("support.view"), wrap(supportAdmin.list));
router.get("/support-agents", authMiddleware, requirePermission("support.view"), wrap(supportAdmin.agents));
router.get("/support-tickets/:id", authMiddleware, requirePermission("support.view"), wrap(supportAdmin.detail));
router.post("/support-tickets/:id/reply", authMiddleware, requirePermission("support.manage"), wrap(supportAdmin.reply));
router.put("/support-tickets/:id", authMiddleware, requirePermission("support.manage"), wrap(supportAdmin.update));

// Payment audit trail and reconciliation
router.get("/payment-events", authMiddleware, requirePermission("payments.view"), wrap(paymentLogsController.listEvents));
router.get("/payments-attention", authMiddleware, requirePermission("payments.view"), wrap(paymentLogsController.attention));
router.post("/payments/:id/recheck", authMiddleware, requirePermission("payments.manage"), wrap(paymentLogsController.recheck));

// Add Money screen settings: quick amounts, extra bonus, limits
router.get("/add-money-settings", authMiddleware, requirePermission("addmoney.view"), wrap(addMoneyController.adminGet));
router.put("/add-money-settings", authMiddleware, requirePermission("addmoney.manage"), wrap(addMoneyController.adminUpdate));

// App banners
router.get("/banners", authMiddleware, requirePermission("banners.view"), wrap(bannerController.list));
router.post("/banners", authMiddleware, requirePermission("banners.manage"), acceptBannerImage, wrap(bannerController.create));
router.put("/banners/:id", authMiddleware, requirePermission("banners.manage"), acceptBannerImage, wrap(bannerController.update));
router.delete("/banners/:id", authMiddleware, requirePermission("banners.manage"), wrap(bannerController.remove));

// Payment-page coupons (discounts on wallet top-ups)
router.get("/coupons", authMiddleware, requirePermission("promotions.view"), wrap(couponController.list));
router.post("/coupons", authMiddleware, requirePermission("promotions.manage"), wrap(couponController.create));
router.put("/coupons/:id", authMiddleware, requirePermission("promotions.manage"), wrap(couponController.update));
router.delete("/coupons/:id", authMiddleware, requirePermission("promotions.manage"), wrap(couponController.remove));

// Promo payouts: free-session time owed to astrologers
router.get("/promo-payouts", authMiddleware, requirePermission("promopayouts.view"), wrap(promoPayoutController.overview));
router.get("/promo-payouts/history", authMiddleware, requirePermission("promopayouts.view"), wrap(promoPayoutController.history));
router.put("/promo-payouts/rate", authMiddleware, requirePermission("promopayouts.manage"), wrap(promoPayoutController.setRate));
router.post("/promo-payouts/:astrologerId/pay", authMiddleware, requirePermission("promopayouts.manage"), wrap(promoPayoutController.markPaid));

// Astro Store and Planetary Insights content shown in the user app
router.get("/store-products", authMiddleware, requirePermission("store.view"), wrap(catalogController.store.list));
router.post("/store-products", authMiddleware, requirePermission("store.manage"), wrap(catalogController.store.create));
router.put("/store-products/:id", authMiddleware, requirePermission("store.manage"), wrap(catalogController.store.update));
router.delete("/store-products/:id", authMiddleware, requirePermission("store.manage"), wrap(catalogController.store.remove));
router.get("/planet-insights", authMiddleware, requirePermission("planets.view"), wrap(catalogController.planets.list));
router.post("/planet-insights", authMiddleware, requirePermission("planets.manage"), wrap(catalogController.planets.create));
router.put("/planet-insights/:id", authMiddleware, requirePermission("planets.manage"), wrap(catalogController.planets.update));
router.delete("/planet-insights/:id", authMiddleware, requirePermission("planets.manage"), wrap(catalogController.planets.remove));

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
