const express = require("express");
const router = express.Router();
const videoSessionController = require("../controllers/videoSession.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");
const { requirePermission } = adminMiddleware;
const sessionAuthMiddleware = require("../middlewares/sessionAuth.middleware");
const { bindUserIdentity, bindAstrologerIdentity, scopeToCaller } = require("../middlewares/callerScope.middleware");

// Every call API requires a logged-in caller
router.use(authMiddleware);

// Agora Token Generation (caller must belong to the session that owns the channel)
router.post("/generate-token", videoSessionController.generateAgoraToken);

// Real-Time Audio & Video Call Lifecycle
router.get("/active", scopeToCaller, require("../controllers/session.controller").getActiveSession);
router.post("/request", bindUserIdentity, videoSessionController.requestCall);
router.get("/pending", bindAstrologerIdentity, videoSessionController.getPendingCallRequests);
router.get("/requests", bindAstrologerIdentity, videoSessionController.getPendingCallRequests);
router.get("/astrologer/:id", bindAstrologerIdentity, videoSessionController.getPendingCallRequests);
router.post("/accept", sessionAuthMiddleware, videoSessionController.acceptCall);
router.post("/accept/:id", sessionAuthMiddleware, videoSessionController.acceptCall);
router.post("/reject", sessionAuthMiddleware, videoSessionController.rejectCall);
router.post("/reject/:id", sessionAuthMiddleware, videoSessionController.rejectCall);
router.post("/end", sessionAuthMiddleware, videoSessionController.endCall);
router.post("/end/:id", sessionAuthMiddleware, videoSessionController.endCall);
router.post("/rate", sessionAuthMiddleware, videoSessionController.rateVideoSession);
router.post("/rate/:id", sessionAuthMiddleware, videoSessionController.rateVideoSession);
router.get("/history", scopeToCaller, videoSessionController.getCallHistory);

// Legacy Scheduled Video Session Endpoints (admin tooling)
router.post("/create", requirePermission("bookings.manage"), videoSessionController.createVideoSession);
router.post("/start", sessionAuthMiddleware, videoSessionController.startVideoSession);
router.post("/start/:id", sessionAuthMiddleware, videoSessionController.startVideoSession);
router.get("/all", requirePermission("calls.view"), videoSessionController.getAllVideoSessions);
router.get("/:id", sessionAuthMiddleware, videoSessionController.getVideoSessionById);
router.put("/update/:id", requirePermission("bookings.manage"), videoSessionController.updateVideoSession);
router.delete("/delete/:id", requirePermission("bookings.manage"), videoSessionController.deleteVideoSession);

module.exports = router;
