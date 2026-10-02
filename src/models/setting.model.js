const mongoose = require("mongoose");

// Single document (key "platform") holding platform-wide settings edited by the super admin.
const SettingSchema = new mongoose.Schema(
    {
        key: { type: String, required: true, unique: true, default: "platform" },
        maintenanceMode: { type: Boolean, default: false },
        maintenanceMessage: { type: String, default: "We are upgrading the app. Please try again shortly.", maxlength: 200 },
        supportEmail: { type: String, default: "", trim: true, maxlength: 120 },
        supportPhone: { type: String, default: "", trim: true, maxlength: 30 },
        minWithdrawal: { type: Number, default: 100, min: 100, max: 100000 },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Setting", SettingSchema);
