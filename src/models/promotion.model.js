const mongoose = require("mongoose");

// One document per offer. kind "signup" is granted automatically to every new user (only one active at a time);
// kind "coupon" is redeemed by the user with a code. Future kinds can be added without changing consumers.
const PromotionSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 80 },
        kind: { type: String, enum: ["signup", "coupon"], required: true, index: true },
        code: { type: String, trim: true, uppercase: true, default: null, maxlength: 30 }, // coupons only
        amount: { type: Number, required: true, min: 0 },                                  // bonus rupees granted
        status: { type: String, enum: ["active", "paused"], default: "active", index: true },

        // When the offer itself can be claimed (null = no limit)
        startsAt: { type: Date, default: null },
        endsAt: { type: Date, default: null },

        // How long the granted bonus stays usable. null = unlimited (current setting).
        bonusValidityDays: { type: Number, default: null, min: 1 },

        // Usage limits (null = unlimited)
        maxRedemptions: { type: Number, default: null, min: 1 },
        // Private codes: when not empty, only these users can redeem the code (empty = anyone)
        allowedUsers: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }], default: [] },
        perUserLimit: { type: Number, default: 1, min: 1 },
        redemptionCount: { type: Number, default: 0, min: 0 },

        description: { type: String, default: "", maxlength: 300 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null }
    },
    { timestamps: true }
);

PromotionSchema.index({ code: 1 }, { unique: true, partialFilterExpression: { code: { $type: "string" } } });

module.exports = mongoose.model("Promotion", PromotionSchema);
