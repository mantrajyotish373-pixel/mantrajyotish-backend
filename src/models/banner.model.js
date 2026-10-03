const mongoose = require("mongoose");

// Home-screen banners shown in the user app. Images are always stored as WebP (see banner.service).
const BannerSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 80 },
        imageUrl: { type: String, required: true },
        imagePublicId: { type: String, default: "" },
        imageBytes: { type: Number, default: 0 },
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
        route: { type: String, default: "", trim: true, maxlength: 40 }, // app screen to open on tap, e.g. "Wallet"
        order: { type: Number, default: 0, index: true },
        status: { type: String, enum: ["active", "paused"], default: "active", index: true },
        startsAt: { type: Date, default: null },
        endsAt: { type: Date, default: null },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Banner", BannerSchema);
