const mongoose = require("mongoose");

// A manual payment the company made to an astrologer for free-session time. Created when an admin marks it paid.
const PromoPayoutSchema = new mongoose.Schema(
    {
        astrologer: { type: mongoose.Schema.Types.ObjectId, ref: "Astrologer", required: true, index: true },
        seconds: { type: Number, required: true, min: 1 },
        ratePerMinute: { type: Number, required: true, min: 0 },
        amount: { type: Number, required: true, min: 0 },
        reference: { type: String, default: "", maxlength: 120 },
        note: { type: String, default: "", maxlength: 300 },
        paidBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", required: true },
        paidByName: { type: String, default: "" }
    },
    { timestamps: true }
);

module.exports = mongoose.model("PromoPayout", PromoPayoutSchema);
