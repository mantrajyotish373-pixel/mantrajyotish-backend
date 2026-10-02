const AuditLog = require("../models/auditLog.model");

const clientIp = (req) => {
    const xff = req.headers["x-forwarded-for"];
    return xff ? String(xff).split(",").pop().trim() : (req.ip || "");
};

const SECRET_KEY = /pass|token|secret|otp|authorization/i;
const redact = (value, depth = 0) => {
    if (value == null || depth > 3) return value == null ? value : "[nested]";
    if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
    if (typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value).slice(0, 40)) {
            out[k] = SECRET_KEY.test(k) ? "[hidden]" : redact(v, depth + 1);
        }
        return out;
    }
    if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "…" : value;
    return value;
};

// Fire-and-forget: audit failures must never break the admin's request.
const logAudit = (req, admin, entry) => {
    AuditLog.create({
        actorId: admin?._id,
        actorName: admin?.name || "",
        actorEmail: admin?.email || "",
        actorRole: admin?.role || "",
        method: req?.method || "",
        path: req ? (req.originalUrl || "").split("?")[0] : "",
        ip: req ? clientIp(req) : "",
        userAgent: req ? String(req.headers["user-agent"] || "").slice(0, 200) : "",
        ...entry
    }).catch((e) => console.error("audit log write failed:", e.message));
};

module.exports = { logAudit, redact };
