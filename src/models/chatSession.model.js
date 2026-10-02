const mongoose = require("mongoose");

const ChatSessionSchema = new mongoose.Schema(
    {
        sessionCode: {
            type: String,
            unique: true,
            sparse: true,
            trim: true
        },

        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true
        },

        astrologer: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Astrologer",
            required: true
        },

        status: {
            type: String,
            enum: ["PENDING", "ACCEPTED", "REJECTED", "ACTIVE", "COMPLETED", "CANCELLED"],
            default: "PENDING"
        },

        perMinuteRate: {
            type: Number,
            required: true,
            min: 0
        },

        startTime: {
            type: Date,
            default: null
        },

        endTime: {
            type: Date,
            default: null
        },

        totalDurationMinutes: {
            type: Number,
            default: 0,
            min: 0
        },

        totalDurationSeconds: {
            type: Number,
            default: 0,
            min: 0
        },

        totalAmountDeducted: {
            type: Number,
            default: 0,
            min: 0
        },

        astrologerEarnings: {
            type: Number,
            default: 0,
            min: 0
        },

        promoSeconds: { type: Number, default: 0 },
        platformFee: {
            type: Number,
            default: 0,
            min: 0
        },

        rejectionReason: {
            type: String,
            default: null
        },

        rating: {
            type: Number,
            min: 1,
            max: 5,
            default: null
        },

        review: {
            type: String,
            default: null
        }
    },
    {
        timestamps: true
    }
);

// Auto-generate a readable session code on first save (e.g. CHAT-M0XYZ123-AB3F)
ChatSessionSchema.pre("save", function () {
    if (!this.sessionCode) {
        const ts = Date.now().toString(36).toUpperCase();
        const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        this.sessionCode = `CHAT-${ts}-${rand}`;
    }
});

module.exports = mongoose.model("ChatSession", ChatSessionSchema);
