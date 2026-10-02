const mongoose = require("mongoose");

// Append-only trail of everything that happens to a payment: order created, checkout result reported by the
// app, signature checks, webhooks from Razorpay, reconciliation runs, wallet credits, amount mismatches.
// Rows are never edited or deleted by the application, so a payment can always be traced end to end.
const PaymentEventSchema = new mongoose.Schema(
    {
        payment: { type: mongoose.Schema.Types.ObjectId, ref: "Payment", default: null, index: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
        orderId: { type: String, default: null, index: true },
        paymentId: { type: String, default: null, index: true }, // Razorpay pay_... id when known
        type: { type: String, required: true, index: true },     // e.g. order.created, verify.signature_invalid, webhook.payment.captured
        source: { type: String, enum: ["client", "verify", "webhook", "reconcile", "admin", "system"], default: "system" },
        level: { type: String, enum: ["info", "warn", "error"], default: "info", index: true },
        message: { type: String, default: "", maxlength: 300 },
        details: { type: mongoose.Schema.Types.Mixed, default: null },
        ip: { type: String, default: "" },
        webhookEventId: { type: String, default: null }
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

PaymentEventSchema.index({ createdAt: -1 });
// A Razorpay webhook event id is processed once; retries of the same event are recognised and skipped.
PaymentEventSchema.index({ webhookEventId: 1 }, { unique: true, partialFilterExpression: { webhookEventId: { $type: "string" } } });

module.exports = mongoose.model("PaymentEvent", PaymentEventSchema);
