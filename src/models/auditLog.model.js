const mongoose = require("mongoose");

const AuditLogSchema = new mongoose.Schema(
    {
        actorId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", index: true },
        actorName: { type: String, default: "" },
        actorEmail: { type: String, default: "" },
        actorRole: { type: String, default: "" },
        action: { type: String, required: true, index: true },
        module: { type: String, default: "", index: true },
        method: { type: String, default: "" },
        path: { type: String, default: "" },
        statusCode: { type: Number, default: 0 },
        summary: { type: String, default: "" },
        details: { type: mongoose.Schema.Types.Mixed, default: null },
        ip: { type: String, default: "" },
        userAgent: { type: String, default: "" }
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

AuditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AuditLog", AuditLogSchema);
