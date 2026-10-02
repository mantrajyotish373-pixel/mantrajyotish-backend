const express = require("express");

const router = express.Router();

const paymentController = require("../controllers/payment.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");

// Payment records are admin-only; clients pay through /api/razorpay.
const { requirePermission } = adminMiddleware;
router.use(authMiddleware);

router.post(
    "/create",
    requirePermission("payments.manage"),
    paymentController.createPayment
);

router.get(
    "/all",
    requirePermission("payments.view"),
    paymentController.getAllPayments
);

router.get(
    "/:id",
    requirePermission("payments.view"),
    paymentController.getPaymentById
);

router.put(
    "/update/:id",
    requirePermission("payments.manage"),
    paymentController.updatePayment
);

router.delete(
    "/delete/:id",
    requirePermission("payments.manage"),
    paymentController.deletePayment
);

// Lookup payment by transaction id (pay_... or order_...)
router.get("/transaction/:id", requirePermission("payments.view"), paymentController.getPaymentByTransactionId);

module.exports = router;