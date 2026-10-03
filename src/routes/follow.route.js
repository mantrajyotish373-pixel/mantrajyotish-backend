const express = require("express");
const router = express.Router();
const followController = require("../controllers/follow.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const { rateLimit } = require("../utils/rateLimit");

// Follow / unfollow are cheap but easy to spam
// Counted per signed-in user (not per IP). The app merges rapid taps into one request, so real use stays far below this.
const followLimiter = rateLimit({ keyPrefix: "follow", windowMs: 5 * 60 * 1000, max: 60, keyFn: (req) => req.user.userId, message: "Too many follow actions. Please try again shortly." });

router.get("/", authMiddleware, followController.mine);
router.get("/ids", authMiddleware, followController.ids);
router.get("/followers", authMiddleware, followController.myFollowers); // astrologer's own followers
router.post("/:astroId", authMiddleware, followLimiter, followController.follow);
router.delete("/:astroId", authMiddleware, followLimiter, followController.unfollow);

module.exports = router;
