const mongoose = require("mongoose");

/**
 * Universal Session Model Schema for Mantra Jyotish
 * Represents unified session lifecycle across CHAT, AUDIO, and VIDEO consultations.
 */
const SessionSchema = new mongoose.Schema(
    {
        sessionCode: {
            type: String,
            unique: true,
            sparse: true,
            trim: true
        },

        type: {
            type: String,
            enum: ["CHAT", "AUDIO", "VIDEO"],
            required: true,
            index: true
        },

        callType: {
            type: String,
            enum: ["CHAT", "AUDIO", "VIDEO"],
            default: "CHAT",
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

        status: {
            type: String,
            enum: ["PENDING", "ACCEPTED", "CONNECTING", "ACTIVE", "ENDING", "COMPLETED", "REJECTED", "MISSED", "CANCELLED"],
            default: "PENDING",
            index: true
        },

        // True while the session is PENDING / CONNECTING / ACTIVE / ENDING. Partial unique indexes
        // below make "one live session per astrologer" and "per user" a database guarantee.
        liveLock: {
            type: Boolean,
            default: false
        },

        // Which session protocol each participant's client speaks (1 = legacy, 2 = media_ready aware)
        protocol: {
            user: { type: Number, default: 1 },
            astrologer: { type: Number, default: 1 }
        },

        // Request / connection deadlines (server-authoritative, stored so no timer is needed)
        requestedAt: { type: Date, default: null },
        expiresAt: { type: Date, default: null },
        acceptedAt: { type: Date, default: null },
        connectDeadline: { type: Date, default: null },

        // Audio/video: each participant reports once they have joined the Agora channel
        mediaReady: {
            user: { type: Date, default: null },
            astrologer: { type: Date, default: null }
        },

        // Balance snapshot when billing starts and the moment it can no longer pay (maxEndAt)
        balanceAtStart: { type: Number, default: null },
        maxEndAt: { type: Date, default: null },
        originalStartedAt: { type: Date, default: null },

        endedBy: { type: String, enum: ["USER", "ASTROLOGER", "SYSTEM", null], default: null },
        endReason: { type: String, default: null },

        // Per-participant connection state (disconnect grace policy)
        connection: {
            user: {
                state: { type: String, enum: ["CONNECTED", "RECONNECTING"], default: "CONNECTED" },
                since: { type: Date, default: null },
                deadline: { type: Date, default: null }
            },
            astrologer: {
                state: { type: String, enum: ["CONNECTED", "RECONNECTING"], default: "CONNECTED" },
                since: { type: Date, default: null },
                deadline: { type: Date, default: null }
            }
        },
        lastSeen: {
            user: { type: Date, default: null },
            astrologer: { type: Date, default: null }
        },

        // Recharge pause (existing rule: billing pauses while the user recharges, 2 minute limit)
        billingPausedAt: { type: Date, default: null },
        pauseDeadline: { type: Date, default: null },

        lastTickAt: { type: Date, default: null },

        // Each participant confirms they have seen the final result; until then it is returned by
        // the recovery endpoint, so an end event missed while offline is never lost.
        finalAck: {
            user: { type: Date, default: null },
            astrologer: { type: Date, default: null }
        },

        // Settlement bookkeeping: numbers are computed once, then each wallet leg is applied
        // idempotently (per-wallet marker), then the session becomes COMPLETED.
        settlement: {
            state: { type: String, enum: ["NONE", "IN_PROGRESS", "DONE"], default: "NONE" },
            computed: { type: Boolean, default: false },
            billing: {
                rawSeconds: { type: Number, default: 0 },
                unbilledSeconds: { type: Number, default: 0 },
                billableSeconds: { type: Number, default: 0 },
                perMinuteRate: { type: Number, default: 0 },
                totalCost: { type: Number, default: 0 },
                astrologerEarnings: { type: Number, default: 0 },
                platformFee: { type: Number, default: 0 },
                // Split of totalCost: bonusAmount was paid from the user's bonus balance (no cash, no commission),
                // cashAmount from real money (60/40). bonusSeconds becomes the astrologer's free-session time.
                bonusAmount: { type: Number, default: 0 },
                cashAmount: { type: Number, default: 0 },
                bonusSeconds: { type: Number, default: 0 }
            },
            legs: {
                user: { type: Boolean, default: false },
                astrologer: { type: Boolean, default: false },
                admin: { type: Boolean, default: false },
                grants: { type: Boolean, default: false },
                ledger: { type: Boolean, default: false }
            },
            userBalanceBefore: { type: Number, default: null },
            userBalanceAfter: { type: Number, default: null },
            attempts: { type: Number, default: 0 },
            lastAttemptAt: { type: Date, default: null }
        },

        // Snapshot of rate at session start time (supports dynamic rates)
        perMinuteRate: {
            type: Number,
            required: true,
            min: 0,
            default: 9
        },

        // Authoritative Server Timestamps
        startedAt: {
            type: Date,
            default: null
        },

        endedAt: {
            type: Date,
            default: null
        },

        // Legacy field aliases for seamless backward compatibility
        startTime: {
            type: Date,
            default: null
        },

        endTime: {
            type: Date,
            default: null
        },

        totalDurationSeconds: {
            type: Number,
            default: 0,
            min: 0
        },

        totalDurationMinutes: {
            type: Number,
            default: 0,
            min: 0
        },

        duration: {
            type: Number,
            default: 0
        },

        // Server-Calculated Billing & Wallet Reconciliations
        totalAmountDeducted: {
            type: Number,
            default: 0,
            min: 0
        },

        totalAmount: {
            type: Number,
            default: 0,
            min: 0
        },

        astrologerEarnings: {
            type: Number,
            default: 0,
            min: 0
        },

        // Seconds at the start of billing that the user pays from bonus money (astrologer app shows these as a free session)
        promoCoverSeconds: { type: Number, default: 0 },
        bonusAmountUsed: { type: Number, default: 0 },
        promoSeconds: { type: Number, default: 0 },
        platformFee: {
            type: Number,
            default: 0,
            min: 0
        },

        // Settlement tracking & crash recovery guarantees
        billingSettled: {
            type: Boolean,
            default: false,
            index: true
        },

        billingSettlementStatus: {
            type: String,
            enum: ["UNSETTLED", "SETTLED", "ZERO_AMOUNT"],
            default: "UNSETTLED",
            index: true
        },

        // RTC / Room Details for Audio & Video
        provider: {
            type: String,
            enum: ["Agora", "ZegoCloud", "100ms", "Google Meet", "None"],
            default: "None"
        },

        roomId: {
            type: String,
            default: null,
            trim: true
        },

        channelName: {
            type: String,
            default: null,
            trim: true
        },

        // Disconnect State Tracking & Grace Period Bookkeeping
        disconnectState: {
            userDisconnectedAt: { type: Date, default: null },
            astrologerDisconnectedAt: { type: Date, default: null },
            unbilledGraceSeconds: { type: Number, default: 0 } // Seconds astrologer was disconnected and user not charged
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

// One live session per astrologer and per user, enforced by the database.
// (compound keys so they never collide with the single-field indexes above)
SessionSchema.index(
    { astrologer: 1, liveLock: 1 },
    { unique: true, partialFilterExpression: { liveLock: true }, name: "uniq_live_session_per_astrologer" }
);
SessionSchema.index(
    { user: 1, liveLock: 1 },
    { unique: true, partialFilterExpression: { liveLock: true }, name: "uniq_live_session_per_user" }
);
// Scheduler / recovery queries
// Speeds up an astrologer's public stats (completed sessions by type)
SessionSchema.index({ astrologer: 1, status: 1, type: 1 });
SessionSchema.index({ status: 1, expiresAt: 1 });
SessionSchema.index({ status: 1, connectDeadline: 1 });
SessionSchema.index({ status: 1, maxEndAt: 1 });
SessionSchema.index({ status: 1, endedAt: 1 });

// Auto-generate human-readable sessionCode
SessionSchema.pre("save", function () {
    if (!this.sessionCode) {
        const ts = Date.now().toString(36).toUpperCase();
        const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
        let prefix = "CHAT";
        if (this.type === "AUDIO") prefix = "CALL";
        if (this.type === "VIDEO") prefix = "VID";
        this.sessionCode = `${prefix}-${ts}-${rand}`;
    }
    // Synchronize legacy timestamp fields
    if (this.startedAt && !this.startTime) this.startTime = this.startedAt;
    if (this.startTime && !this.startedAt) this.startedAt = this.startTime;
    if (this.endedAt && !this.endTime) this.endTime = this.endedAt;
    if (this.endTime && !this.endedAt) this.endedAt = this.endTime;
    if (this.totalAmountDeducted && !this.totalAmount) this.totalAmount = this.totalAmountDeducted;
    if (this.totalAmount && !this.totalAmountDeducted) this.totalAmountDeducted = this.totalAmount;
});

module.exports = mongoose.model("Session", SessionSchema);
