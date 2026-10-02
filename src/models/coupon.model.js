const mongoose = require("mongoose");

// Payment-page coupons: they only reduce what the user pays for a wallet top-up.
// The wallet is still credited with the full amount. (Promo codes, which add bonus money, live in Promotion.)
const CouponSchema = new mongoose.Schema(
    {
        code: { type: String, required: true, trim: true, uppercase: true, maxlength: 30 },
        name: { type: String, required: true, trim: true, maxlength: 80 },
        description: { type: String, default: "", maxlength: 200 }, // shown to users, e.g. "Get 10% off on UPI"

        discountType: { type: String, enum: ["percent", "flat"], required: true },
        discountValue: { type: Number, required: true, min: 0 },   // percent (1-100) or rupees
        maxDiscount: { type: Number, default: null, min: 1 },       // cap for percent coupons (rupees)
        minAmount: { type: Number, default: 0, min: 0 },            // minimum recharge amount

        // Restrictions (empty / false = no restriction)
        allowedMethods: { type: [{ type: String, enum: ["upi", "card", "netbanking", "wallet"] }], default: [] },
        firstPaymentOnly: { type: Boolean, default: false },

        startsAt: { type: Date, default: null },
        endsAt: { type: Date, default: null },
        maxRedemptions: { type: Number, default: null, min: 1 },
        perUserLimit: { type: Number, default: 1, min: 1 },
        redemptionCount: { type: Number, default: 0, min: 0 },

        status: { type: String, enum: ["active", "paused"], default: "active", index: true },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null }
    },
    { timestamps: true }
);

CouponSchema.index({ code: 1 }, { unique: true });

module.exports = mongoose.model("Coupon", CouponSchema);
