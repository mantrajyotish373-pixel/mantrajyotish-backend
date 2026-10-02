const mongoose = require("mongoose");

const PayoutSchema = new mongoose.Schema(
    {
        astrologer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Astrologer",
            required: true
        },
        amount: {
            type: Number,
            required: true,
            min: [100, "Minimum withdrawal amount is ₹100"]
        },
        payoutMethod: {
            type: String,
            enum: ["upi", "bank"],
            required: true
        },
        upiId: {
            type: String,
            default: null
        },
        accountNumber: {
            type: String,
            default: null
        },
        ifscCode: {
            type: String,
            default: null
        },
        accountHolder: {
            type: String,
            default: null
        },
        status: {
            type: String,
            enum: ["Pending", "Completed", "Rejected"],
            default: "Pending"
        },
        processedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
        processedAt: { type: Date, default: null }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Payout", PayoutSchema);
