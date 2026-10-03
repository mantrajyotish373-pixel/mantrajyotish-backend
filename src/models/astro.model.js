const mongoose = require("mongoose");

const AstroSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: false,
            default: null
        },

        astrologerLogin: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "AstrologerLogin",
            required: false,
            default: null
        },

        name: {
            type: String,
            default: null,
            trim: true
        },

        email: {
            type: String,
            default: null,
            trim: true,
            lowercase: true,
            unique: true,
            sparse: true
        },

        phone: {
            type: String,
            default: null,
            trim: true,
            unique: true,
            sparse: true
        },

        password: {
            type: String,
            default: null
        },

        gender: {
            type: String,
            enum: ["male", "female", "other"],
            default: null,
            lowercase: true
        },

        profileImage: {
            type: String,
            default: null
        },

        introduction: {
            type: String,
            trim: true,
            default: null
        },

        about: {
            type: String,
            trim: true,
            default: null
        },

        experience: {
            type: String,
            default: "0"
        },

        strengths: {
            type: [String],
            default: []
        },

        approach: {
            type: String,
            trim: true,
            default: null
        },

        motivation: {
            type: String,
            trim: true,
            default: null
        },

        languages: {
            type: [String],
            default: []
        },

        specialization: {
            type: [String],
            default: []
        },

        toolsTechniques: {
            type: String,
            trim: true,
            default: null
        },

        certificateFile: {
            type: String,
            default: null
        },

        certificateName: {
            type: String,
            default: null
        },

        achievements: {
            type: String,
            trim: true,
            default: null
        },

        consultationFee: {
            type: Number,
            default: 0,
            min: 0
        },

        chatPrice: {
            type: Number,
            default: 20,
            min: 0
        },

        audioCallPrice: {
            type: Number,
            default: 25,
            min: 0
        },

        videoCallPrice: {
            type: Number,
            default: 40,
            min: 0
        },

        consultationMode: {
            type: [String],
            enum: ["chat", "call", "video"],
            default: ["chat"]
        },

        rating: {
            type: Number,
            default: 0,
            min: 0,
            max: 5
        },

        totalReviews: {
            type: Number,
            default: 0,
            min: 0
        },

        totalConsultations: {
            type: Number,
            default: 0,
            min: 0
        },

        averageResponseTime: {
            type: Number,
            default: 0,
            min: 0
        },

        walletBalance: {
            type: Number,
            default: 0,
            min: 0
        },

        // Free-session time earned from sessions the user paid with bonus money. Shown to the astrologer
        // as time only (never as rupees); the company pays it out manually and an admin resets it to 0.
        promoSecondsPending: { type: Number, default: 0, min: 0 },
        promoSecondsEarnedTotal: { type: Number, default: 0, min: 0 },

        // Session ids whose settlement has already been applied to this wallet (idempotency marker;
        // bounded to the most recent entries by the settlement code)
        settledSessions: {
            type: [mongoose.Schema.Types.ObjectId],
            default: undefined,
            select: false
        },

        isVerified: {
            type: Boolean,
            default: false
        },

        // Denormalised count of users following this astrologer (kept in step by follow.service)
        followersCount: {
            type: Number,
            default: 0,
            min: 0
        },

        isOnline: {
            type: Boolean,
            default: false
        },

        manualOffline: {
            type: Boolean,
            default: true
        },

        isAvailable: {
            type: Boolean,
            default: true
        },

        location: {
            type: String,
            default: null,
            trim: true
        },

        city: {
            type: String,
            default: null,
            trim: true
        },

        state: {
            type: String,
            default: null,
            trim: true
        },

        address: {
            type: String,
            default: null,
            trim: true
        },

        district: {
            type: String,
            default: null,
            trim: true
        },

        age: {
            type: String,
            default: null,
            trim: true
        },

        status: {
            type: String,
            enum: ["pending", "approved", "rejected"],
            default: "pending"
        }
    },
    {
        timestamps: true,
        toJSON: { virtuals: true },
        toObject: { virtuals: true }
    }
);

AstroSchema.virtual("avatar").get(function () {
    return this.profileImage;
});

AstroSchema.pre("save", async function () {
    if (this.isNew && !this.profileImage) {
        const { getDefaultProfilePic } = require("../services/cloudinary.service");
        this.profileImage = getDefaultProfilePic(this._id, "astrologer", this.gender);
    }
});

module.exports = mongoose.model("Astrologer", AstroSchema);