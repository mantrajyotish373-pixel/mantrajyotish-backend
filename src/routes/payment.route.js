const express = require("express");

const router = express.Router();

const paymentController = require("../controllers/payment.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const adminMiddleware = require("../middlewares/admin.middleware");

// Payment records are admin-only; clients pay through /api/razorpay.
router.use(authMiddleware, adminMiddleware);

router.post(
    "/create",
    paymentController.createPayment
);

router.get(
    "/all",
    paymentController.getAllPayments
);

router.get(
    "/:id",
    paymentController.getPaymentById
);

router.put(
    "/update/:id",
    paymentController.updatePayment
);

router.delete(
    "/delete/:id",
    authMiddleware,
    paymentController.deletePayment
);

// Lookup payment by transaction id (pay_... or order_...)
router.get("/transaction/:id", authMiddleware, paymentController.getPaymentByTransactionId);

module.exports = router;