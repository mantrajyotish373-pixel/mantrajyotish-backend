const mongoose = require("mongoose");

// Planetary Insights cards shown on the user app home page.
const PlanetInsightSchema = new mongoose.Schema(
    {
        // Built-in planets keep a key (sun, moon…) so the app can fall back to its bundled picture.
        key: { type: String, trim: true, lowercase: true, default: "", maxlength: 30 },
        title: { type: String, required: true, trim: true, maxlength: 80 },
        description: { type: String, required: true, trim: true, maxlength: 200 },
        details: { type: String, default: "", maxlength: 3000 },
        image: { type: String, default: "" },
        bgColor: { type: String, default: "bg-orange-200", maxlength: 30 },
        status: { type: String, enum: ["active", "hidden"], default: "active", index: true },
        sortOrder: { type: Number, default: 0, index: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null }
    },
    { timestamps: true }
);

module.exports = mongoose.model("PlanetInsight", PlanetInsightSchema);
