const mongoose = require("mongoose");

// One document per (user, astrologer) pair a user follows.
const FollowSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        astro: { type: mongoose.Schema.Types.ObjectId, ref: "Astrologer", required: true }
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

FollowSchema.index({ user: 1, astro: 1 }, { unique: true });
FollowSchema.index({ astro: 1, createdAt: -1 });
FollowSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("Follow", FollowSchema);
