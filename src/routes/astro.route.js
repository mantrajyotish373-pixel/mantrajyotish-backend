const express = require("express");

const router = express.Router();

const astroController = require("../controllers/astro.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { requireSelfAstrologer } = require("../middlewares/callerScope.middleware");

// Profile & Creation
router.post("/create", astroController.createAstrologer);

// Listing & Filtering
router.get("/all", astroController.getAllAstrologers);
router.get("/online", astroController.getOnlineAstrologers);

// Admin Approval & Pending Requests (Supports both URL param :id and Body JSON { "astrologerId": "..." } / { "email": "..." })
router.get("/pending", authMiddleware, adminMiddleware, astroController.getPendingAstrologers);
router.put("/approve/:id", authMiddleware, adminMiddleware, astroController.approveAstrologer);
router.post("/approve", authMiddleware, adminMiddleware, astroController.approveAstrologer);
router.put("/approve", authMiddleware, adminMiddleware, astroController.approveAstrologer);
router.put("/reject/:id", authMiddleware, adminMiddleware, astroController.rejectAstrologer);
router.post("/reject", authMiddleware, adminMiddleware, astroController.rejectAstrologer);
router.put("/reject", authMiddleware, adminMiddleware, astroController.rejectAstrologer);

// Online/Offline Status Toggle
router.put("/toggle-online", authMiddleware, requireSelfAstrologer, astroController.toggleOnlineStatus);
router.put("/toggle-online/:id", authMiddleware, requireSelfAstrologer, astroController.toggleOnlineStatus);

// Details by ID
router.get("/reviews/:id", astroController.getAstrologerReviews);
router.get("/:id", astroController.getAstrologerById);

// Update & Delete
router.put("/update/:id", authMiddleware, requireSelfAstrologer, astroController.updateAstrologer);
router.delete("/delete/:id", authMiddleware, adminMiddleware, astroController.deleteAstrologer);

module.exports = router;