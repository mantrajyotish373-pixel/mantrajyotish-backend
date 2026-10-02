const mongoose = require("mongoose");

// Astro Store items shown on the user app home page / store.
const StoreProductSchema = new mongoose.Schema(
    {
        title: { type: String, required: true, trim: true, maxlength: 120 },
        category: { type: String, required: true, trim: true, maxlength: 60 },
        description: { type: String, default: "", maxlength: 1000 },
        price: { type: Number, required: true, min: 0 },
        oldPrice: { type: Number, default: 0, min: 0 },
        image: { type: String, default: "" },
        rating: { type: Number, default: 4.5, min: 0, max: 5 },
        popular: { type: Boolean, default: false },
        status: { type: String, enum: ["active", "hidden"], default: "active", index: true },
        sortOrder: { type: Number, default: 0, index: true },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null }
    },
    { timestamps: true }
);

module.exports = mongoose.model("StoreProduct", StoreProductSchema);
