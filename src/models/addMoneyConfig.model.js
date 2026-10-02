const mongoose = require("mongoose");

// Single document (key "default") controlling the user app's Add Money screen.
const PresetSchema = new mongoose.Schema(
    {
        amount: { type: Number, required: true, min: 1 },
        extraAmount: { type: Number, default: 0, min: 0 }, // bonus rupees given on top when the user adds exactly this amount
        label: { type: String, default: "", trim: true, maxlength: 20 } // optional tag, e.g. "Popular"
    },
    { _id: false }
);

const AddMoneyConfigSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, default: "default" },
        presets: { type: [PresetSchema], default: [] },
        minAmount: { type: Number, default: 10, min: 1 },
        maxAmount: { type: Number, default: 100000, min: 1 },
        // GST charged on top of the amount the user adds (0 = no GST). Wallet still gets the full amount.
        gstPercent: { type: Number, default: 18, min: 0, max: 100 },
        // How long the extra bonus stays usable. null = never expires.
        extraValidityDays: { type: Number, default: null, min: 1 },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null }
    },
    { timestamps: true }
);

module.exports = mongoose.model("AddMoneyConfig", AddMoneyConfigSchema);
