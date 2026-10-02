const express = require("express");

const router = express.Router();

const astroController = require("../controllers/astro.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { requirePermission } = adminMiddleware;
const { optionalAuth } = require("../utils/astroSanitize");
const { requireSelfAstrologer } = require("../middlewares/callerScope.middleware");

// Profile & Creation
// Authenticated only: an astrologer saves their own profile, an admin with astrologers.edit may create/update any.
const adminNeedsEditPermission = (req, res, next) =>
    (req.user.role === "admin" || req.user.role === "superadmin") ? requirePermission("astrologers.edit")(req, res, next) : next();
router.post("/create", authMiddleware, requireSelfAstrologer, adminNeedsEditPermission, astroController.createAstrologer);

// Listing & Filtering
router.get("/all", optionalAuth, astroController.getAllAstrologers);
router.get("/online", optionalAuth, astroController.getOnlineAstrologers);

// Admin Approval & Pending Requests (Supports both URL param :id and Body JSON { "astrologerId": "..." } / { "email": "..." })
router.get("/pending", authMiddleware, requirePermission("astrologers.view"), astroController.getPendingAstrologers);
router.put("/approve/:id", authMiddleware, requirePermission("astrologers.approve"), astroController.approveAstrologer);
router.post("/approve", authMiddleware, requirePermission("astrologers.approve"), astroController.approveAstrologer);
router.put("/approve", authMiddleware, requirePermission("astrologers.approve"), astroController.approveAstrologer);
router.put("/reject/:id", authMiddleware, requirePermission("astrologers.approve"), astroController.rejectAstrologer);
router.post("/reject", authMiddleware, requirePermission("astrologers.approve"), astroController.rejectAstrologer);
router.put("/reject", authMiddleware, requirePermission("astrologers.approve"), astroController.rejectAstrologer);

// Online/Offline Status Toggle
router.put("/toggle-online", authMiddleware, requireSelfAstrologer, astroController.toggleOnlineStatus);
router.put("/toggle-online/:id", authMiddleware, requireSelfAstrologer, astroController.toggleOnlineStatus);

// Details by ID
router.get("/reviews/:id", astroController.getAstrologerReviews);
router.get("/:id", optionalAuth, astroController.getAstrologerById);

// Update & Delete
router.put("/update/:id", authMiddleware, requireSelfAstrologer, astroController.updateAstrologer);
router.delete("/delete/:id", authMiddleware, requirePermission("astrologers.delete"), astroController.deleteAstrologer);

module.exports = router;