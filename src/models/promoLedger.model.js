const mongoose = require("mongoose");

// One row per session that was (partly) paid from bonus money: the free-session seconds credited to the astrologer.
const PromoLedgerSchema = new mongoose.Schema(
    {
        session: { type: mongoose.Schema.Types.ObjectId, ref: "Session", required: true, unique: true },
        sessionType: { type: String, default: "" },
        astrologer: { type: mongoose.Schema.Types.ObjectId, ref: "Astrologer", required: true, index: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        seconds: { type: Number, required: true, min: 0 },
        bonusAmount: { type: Number, default: 0 }
    },
    { timestamps: true }
);

module.exports = mongoose.model("PromoLedger", PromoLedgerSchema);
