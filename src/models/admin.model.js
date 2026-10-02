const mongoose = require("mongoose");

const AdminSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },
        password: {
            type: String,
            required: true
        },
        role: {
            type: String,
            enum: ["admin", "superadmin"],
            default: "admin"
        },
        lastLoginAt: {
            type: Date,
            default: null
        },
        walletBalance: {
            type: Number,
            default: 0
        },

        // Session ids whose settlement has already been applied to this wallet (idempotency marker;
        // bounded to the most recent entries by the settlement code)
        settledSessions: {
            type: [mongoose.Schema.Types.ObjectId],
            default: undefined,
            select: false
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model("Admin", AdminSchema);
