const mongoose = require("mongoose");

const WalletTransactionSchema = new mongoose.Schema(
    {
        transactionId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true
        },
        astrologer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Astrologer",
            required: true,
            index: true
        },
        sessionType: {
            type: String,
            enum: ["CHAT", "AUDIO", "VIDEO"],
            required: true
        },
        sessionId: {
            type: mongoose.Schema.Types.ObjectId,
            required: true,
            unique: true // exactly one settlement ledger row per session
        },
        sessionCode: {
            type: String,
            default: null
        },
        ratePerMinute: {
            type: Number,
            required: true,
            min: 0
        },
        durationSeconds: {
            type: Number,
            required: true,
            min: 0
        },
        totalDurationMinutes: {
            type: Number,
            required: true,
            min: 0
        },
        amountDeducted: {
            type: Number,
            required: true,
            min: 0
        },
        astrologerEarnings: {
            type: Number,
            required: true,
            min: 0
        },
        platformFee: {
            type: Number,
            required: true,
            min: 0
        },
        userBalanceBefore: {
            type: Number,
            default: 0
        },
        userBalanceAfter: {
            type: Number,
            default: 0
        },
        status: {
            type: String,
            enum: ["SUCCESS", "PARTIAL", "FAILED"],
            default: "SUCCESS"
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("WalletTransaction", WalletTransactionSchema);
