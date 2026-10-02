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
        // Hashed, revocable refresh sessions (max 5 devices). Never returned by queries by default.
        refreshSessions: {
            type: [
                {
                    hash: { type: String, required: true },
                    expiresAt: { type: Date, required: true },
                    createdAt: { type: Date, default: Date.now },
                    userAgent: { type: String, default: "" },
                    sid: { type: String, default: "" },
                    ip: { type: String, default: "" },
                    lastUsedAt: { type: Date, default: Date.now },
                    _id: false
                }
            ],
            default: [],
            select: false
        },

        phone: { type: String, default: "", trim: true },
        passwordChangedAt: { type: Date, default: null },

        lastLoginAt: {
            type: Date,
            default: null
        },
        // Sub-admin access control. Superadmin ignores `permissions` (implicitly has everything).
        permissions: { type: [String], default: [] },
        roleId: { type: mongoose.Schema.Types.ObjectId, ref: "Role", default: null },
        roleName: { type: String, default: "" },
        status: { type: String, enum: ["active", "disabled"], default: "active" },
        createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },

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
