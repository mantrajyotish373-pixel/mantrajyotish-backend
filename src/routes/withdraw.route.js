const express = require("express");
const router = express.Router();
const authMiddleware = require("../middlewares/auth.middleware");
const { requirePermission } = require("../middlewares/admin.middleware");
const c = require("../controllers/withdraw.controller");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get("/all", authMiddleware, requirePermission("withdrawals.view"), wrap(c.getAllWithdrawals));
router.post("/:id/approve", authMiddleware, requirePermission("withdrawals.manage"), wrap(c.approveWithdrawal));
router.post("/:id/reject", authMiddleware, requirePermission("withdrawals.manage"), wrap(c.rejectWithdrawal));

module.exports = router;
