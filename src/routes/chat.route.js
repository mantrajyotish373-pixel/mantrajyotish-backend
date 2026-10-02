const express = require("express");
const router = express.Router();

const chatController = require("../controllers/chat.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const sessionAuthMiddleware = require("../middlewares/sessionAuth.middleware");
const { bindUserIdentity, scopeToCaller } = require("../middlewares/callerScope.middleware");

// Every chat API requires a logged-in caller
router.use(authMiddleware);

// Chat Lifecycle APIs
router.get("/active", scopeToCaller, require("../controllers/session.controller").getActiveSession);
router.post("/initiate", bindUserIdentity, chatController.initiateChat);
router.post("/accept", sessionAuthMiddleware, chatController.acceptChat);
router.post("/reject", sessionAuthMiddleware, chatController.rejectChat);
router.post("/end", sessionAuthMiddleware, chatController.endChat);
router.post("/send", sessionAuthMiddleware, chatController.sendMessage);
router.post("/message", sessionAuthMiddleware, chatController.sendMessage);

// Chat History & Listing APIs
router.get("/history/:sessionId", sessionAuthMiddleware, chatController.getChatHistory);
router.get("/sessions", scopeToCaller, chatController.getMySessions);
router.get("/details/:sessionId", sessionAuthMiddleware, chatController.getSessionDetails);

// Rating & Review API
router.post("/rate", sessionAuthMiddleware, chatController.rateChat);

module.exports = router;
