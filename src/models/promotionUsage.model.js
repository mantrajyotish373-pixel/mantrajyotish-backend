const mongoose = require("mongoose");

// How many times one user redeemed one promotion. The unique index makes the per-user limit race-proof.
const PromotionUsageSchema = new mongoose.Schema(
    {
        promotion: { type: mongoose.Schema.Types.ObjectId, ref: "Promotion", required: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        count: { type: Number, default: 0 }
    },
    { timestamps: true }
);

PromotionUsageSchema.index({ promotion: 1, user: 1 }, { unique: true });

module.exports = mongoose.model("PromotionUsage", PromotionUsageSchema);
