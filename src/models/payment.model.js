const mongoose = require("mongoose");

const PaymentSchema = new mongoose.Schema(
{
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

    appointment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Appointment",
        required: false
    },

    amount: {
        type: Number,
        required: true,
        min: 0
    },

    // `amount` is what was actually charged. For a discounted top-up the wallet receives
    // `walletCredit` (the full amount the user chose) and `discountAmount` is the difference.
    walletCredit: { type: Number, default: null, min: 0 },
    gstAmount: { type: Number, default: 0, min: 0 }, // GST included in `amount` (charged on top of the wallet credit)
    gstPercent: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0, min: 0 },
    coupon: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", default: null },
    couponCode: { type: String, default: null },
    // Extra bonus promised for this top-up (from the Add Money settings); granted once when the payment succeeds
    bonusAmount: { type: Number, default: 0, min: 0 },
    bonusGranted: { type: Boolean, default: false },
    couponCounted: { type: Boolean, default: false },
    paymentMethod: { type: String, default: null },

    currency: {
        type: String,
        default: "INR"
    },

    paymentGateway: {
        type: String,
        enum: ["Razorpay", "Stripe", "Cashfree", "Admin"],
        default: "Razorpay"
    },

    transactionId: {
        type: String,
        default: null,
        unique: true,
        sparse: true
    },

    orderId: {
        type: String,
        default: null,
        unique: true,
        sparse: true
    },

    paymentStatus: {
        type: String,
        enum: [
            "pending",
            "success",
            "failed",
            "refunded"
        ],
        default: "pending"
    },

    // Why a payment failed, and a flag for payments that need a human to look at them (e.g. amount mismatch)
    failureReason: { type: String, default: null, maxlength: 300 },
    // true from the moment a payment is confirmed until the wallet has actually been credited (lets a crash be repaired)
    creditPending: { type: Boolean, default: false, index: true },
    needsReview: { type: Boolean, default: false, index: true },
    reviewReason: { type: String, default: null, maxlength: 300 },

    paidAt: {
        type: Date,
        default: null
    }

},
{
    timestamps: true
});

module.exports = mongoose.model("Payment", PaymentSchema);