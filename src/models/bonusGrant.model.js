const mongoose = require("mongoose");

// Ledger of every bonus credited to a user. `remaining` tracks what is still unspent so that an expiry
// can only ever remove bonus that is really left (never cash).
const BonusGrantSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        promotion: { type: mongoose.Schema.Types.ObjectId, ref: "Promotion", default: null, index: true },
        source: { type: String, enum: ["signup", "coupon", "admin", "migration"], required: true },
        amount: { type: Number, required: true, min: 0 },
        remaining: { type: Number, required: true, min: 0 },
        status: { type: String, enum: ["active", "exhausted", "expired"], default: "active", index: true },
        expiresAt: { type: Date, default: null },
        reason: { type: String, default: "", maxlength: 200 },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null }
    },
    { timestamps: true }
);

BonusGrantSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model("BonusGrant", BonusGrantSchema);
