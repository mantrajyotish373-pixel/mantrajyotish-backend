const mongoose = require("mongoose");

// In-app notification inbox for users (shown on the Notifications screen).
const NotificationSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        type: { type: String, enum: ["astro_live", "astro_online", "general"], default: "general" },
        title: { type: String, required: true, maxlength: 120 },
        body: { type: String, default: "", maxlength: 300 },
        // Where the app goes when the notification is tapped, e.g. { astroId }
        data: { type: mongoose.Schema.Types.Mixed, default: {} },
        readAt: { type: Date, default: null }
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

NotificationSchema.index({ user: 1, createdAt: -1 });
NotificationSchema.index({ user: 1, readAt: 1 });
// Old notifications clean themselves up after 60 days
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 24 * 60 * 60 });

module.exports = mongoose.model("Notification", NotificationSchema);
