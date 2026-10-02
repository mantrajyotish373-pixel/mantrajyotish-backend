const express = require("express");
const router = express.Router();
const sessionController = require("../controllers/session.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const sessionAuthMiddleware = require("../middlewares/sessionAuth.middleware");
const { scopeToCaller } = require("../middlewares/callerScope.middleware");

router.use(authMiddleware);

router.get("/active", scopeToCaller, sessionController.getActiveSession);
router.get("/details/:sessionId", sessionAuthMiddleware, sessionController.getSessionDetails);
router.post("/end", sessionAuthMiddleware, sessionController.endSession);

module.exports = router;
