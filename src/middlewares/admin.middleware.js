const Admin = require("../models/admin.model");
const { logAudit, redact } = require("../utils/audit");

const isStaff = (role) => role === "admin" || role === "superadmin";

// Re-reads the admin from the DB on every request so that disabling an account, deleting it,
// or editing its permissions takes effect immediately (no waiting for a token to expire).
const resolveAdmin = async (req, res) => {
    if (!req.user) {
        res.status(401).json({ success: false, message: "Unauthorized - Access denied" });
        return null;
    }
    if (!isStaff(req.user.role)) {
        res.status(403).json({ success: false, message: "Forbidden - Admin access required" });
        return null;
    }
    let admin = null;
    try {
        admin = await Admin.findById(req.user.userId).select("name email role permissions status").lean();
    } catch (e) { /* fall through */ }
    if (!admin || admin.status === "disabled") {
        res.status(401).json({ success: false, message: "Unauthorized - Admin account unavailable" });
        return null;
    }
    req.admin = admin;
    req.user.role = admin.role; // trust the DB over the (possibly stale) token claim
    return admin;
};

const hasPermission = (admin, perm) =>
    admin.role === "superadmin" || (Array.isArray(admin.permissions) && admin.permissions.includes(perm));

const auditMutation = (req, res, admin, perm) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    res.on("finish", () => {
        if (req.skipAutoAudit) return; // handler wrote a richer audit entry itself
        logAudit(req, admin, {
            action: perm || "admin.action",
            module: perm ? perm.split(".")[0] : "",
            statusCode: res.statusCode,
            summary: `${req.method} ${(req.originalUrl || "").split("?")[0]}`,
            details: { params: req.params, body: redact(req.body) }
        });
    });
};

// Any active admin (used where no specific permission applies).
const adminMiddleware = async (req, res, next) => {
    const admin = await resolveAdmin(req, res);
    if (!admin) return;
    auditMutation(req, res, admin, null);
    next();
};

adminMiddleware.requirePermission = (perm) => async (req, res, next) => {
    const admin = await resolveAdmin(req, res);
    if (!admin) return;
    if (!hasPermission(admin, perm)) {
        logAudit(req, admin, {
            action: "permission.denied",
            module: perm.split(".")[0],
            statusCode: 403,
            summary: `Denied ${perm}: ${req.method} ${(req.originalUrl || "").split("?")[0]}`
        });
        return res.status(403).json({ success: false, message: `Forbidden - you do not have the "${perm}" permission` });
    }
    auditMutation(req, res, admin, perm);
    next();
};

adminMiddleware.requireSuperadmin = async (req, res, next) => {
    const admin = await resolveAdmin(req, res);
    if (!admin) return;
    if (admin.role !== "superadmin") {
        logAudit(req, admin, {
            action: "permission.denied",
            module: "team",
            statusCode: 403,
            summary: `Denied superadmin area: ${req.method} ${(req.originalUrl || "").split("?")[0]}`
        });
        return res.status(403).json({ success: false, message: "Forbidden - Only the super admin can do this" });
    }
    auditMutation(req, res, admin, "team.manage");
    next();
};

adminMiddleware.hasPermission = hasPermission;

module.exports = adminMiddleware;
