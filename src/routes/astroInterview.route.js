const express = require("express");

const router = express.Router();

const astroInterviewController = require("../controllers/astroInterview.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");

const { requirePermission } = adminMiddleware;
const viewAdmin = [authMiddleware, requirePermission("interviews.view")];
const adminOnly = [authMiddleware, requirePermission("interviews.manage")];

// 1. Astrologer Requests Interview
router.post("/request", authMiddleware, astroInterviewController.requestInterview);

// 2. Admin Schedules Interview (Date, Time, Google Meet Link)
router.put("/schedule/:id", adminOnly, astroInterviewController.scheduleInterview);
router.put("/schedule", adminOnly, astroInterviewController.scheduleInterview);
router.post("/schedule", adminOnly, astroInterviewController.scheduleInterview);

// 3. Admin Evaluates Interview Result (Pass / Fail)
router.put("/result/:id", adminOnly, astroInterviewController.evaluateInterview);
router.put("/result", adminOnly, astroInterviewController.evaluateInterview);
router.post("/result", adminOnly, astroInterviewController.evaluateInterview);

// 3a. Direct Dedicated PASS Button APIs
router.put("/pass/:id", adminOnly, astroInterviewController.passInterview);
router.put("/pass", adminOnly, astroInterviewController.passInterview);
router.post("/pass", adminOnly, astroInterviewController.passInterview);

// 3b. Direct Dedicated FAIL Button APIs
router.put("/fail/:id", adminOnly, astroInterviewController.failInterview);
router.put("/fail", adminOnly, astroInterviewController.failInterview);
router.post("/fail", adminOnly, astroInterviewController.failInterview);

// 3c. Mark Interview Completed APIs
router.put("/complete/:id", adminOnly, astroInterviewController.completeInterview);
router.put("/complete", adminOnly, astroInterviewController.completeInterview);
router.post("/complete", adminOnly, astroInterviewController.completeInterview);

// 3d. Update Interview Notes APIs
router.put("/notes/:id", adminOnly, astroInterviewController.updateNotes);
router.put("/notes", adminOnly, astroInterviewController.updateNotes);
router.post("/notes", adminOnly, astroInterviewController.updateNotes);

// 4. Listing & Filtering (Admin)
router.get("/all", viewAdmin, astroInterviewController.getAllInterviews);
router.get("/pending", viewAdmin, astroInterviewController.getPendingInterviews);

// 5. Astrologer Fetch Interview Details (Date, Time, Meeting Link, Notes)
router.get("/details", authMiddleware, astroInterviewController.getMyInterview);
router.get("/my-interview", authMiddleware, astroInterviewController.getMyInterview);
router.get("/astrologer/:id", authMiddleware, astroInterviewController.getMyInterview);

// 6. Token refresh/generation on-demand (admin, or the astrologer being interviewed)
router.get("/token/:id", authMiddleware, astroInterviewController.getInterviewToken);

module.exports = router;
