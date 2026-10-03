const mongoose = require("mongoose");

const VideoSessionSchema = new mongoose.Schema(
{
    sessionCode: {
        type: String,
        unique: true,
        sparse: true,
        trim: true
    },

    appointment: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Appointment",
        required: false,
        default: null,
        index: false   // No unique index — multiple sessions can have appointment=null
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

    callType: {
        type: String,
        enum: ["AUDIO", "VIDEO"],
        default: "VIDEO"
    },

    provider: {
        type: String,
        enum: ["Agora", "ZegoCloud", "100ms", "Google Meet"],
        default: "Agora"
    },

    roomId: {
        type: String,
        required: true,
        trim: true
    },

    channelName: {
        type: String,
        trim: true,
        default: null
    },

    joinUrl: {
        type: String,
        default: null
    },

    meetingId: {
        type: String,
        default: null
    },

    meetingPassword: {
        type: String,
        default: null
    },

    perMinuteRate: {
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

    startTime: {
        type: Date,
        default: null
    },

    endTime: {
        type: Date,
        default: null
    },

    duration: {
        type: Number,
        default: 0
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
    },

    status: {
        type: String,
        enum: [
            "PENDING",
            "ACTIVE",
            "COMPLETED",
            "REJECTED",
            "MISSED",
            "CANCELLED",
            "scheduled",
            "live",
            "completed",
            "cancelled"
        ],
        default: "PENDING"
    }

},
{
    timestamps: true
});

// Auto-generate a readable session code on first save (e.g. CALL-M0XYZ123-AB3F)
VideoSessionSchema.pre("save", function () {
    if (!this.sessionCode) {
        const ts = Date.now().toString(36).toUpperCase();
        const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        const prefix = this.callType === "VIDEO" ? "VID" : "CALL";
        this.sessionCode = `${prefix}-${ts}-${rand}`;
    }
});

// Speeds up an astrologer's paged reviews (rated sessions, newest first)
VideoSessionSchema.index({ astrologer: 1, rating: 1, createdAt: -1 });

module.exports = mongoose.model("VideoSession", VideoSessionSchema);