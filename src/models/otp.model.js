const mongoose = require("mongoose");

const OtpSchema = new mongoose.Schema(
    {
        phone: {
            type: String,
            required: true,
            trim: true,
            index: true
        },
        // HMAC of the code (never the plain code), see auth.service
        otp: {
            type: String,
            required: true
        },
        // wrong guesses against the current code
        attempts: {
            type: Number,
            default: 0
        },
        // how many times a code was sent while this record has been alive
        sendCount: {
            type: Number,
            default: 1
        },
        lastSentAt: {
            type: Date,
            default: Date.now
        },
        expiresAt: {
            type: Date,
            required: true,
            default: () => new Date(Date.now() + 5 * 60 * 1000), // 5 minutes TTL
            index: { expires: 0 } // Automatic removal after expiration
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Otp", OtpSchema);
