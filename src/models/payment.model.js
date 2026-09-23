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

    paidAt: {
        type: Date,
        default: null
    }

},
{
    timestamps: true
});

module.exports = mongoose.model("Payment", PaymentSchema);