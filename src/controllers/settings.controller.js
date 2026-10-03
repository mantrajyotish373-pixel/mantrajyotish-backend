const mongoose = require("mongoose");
const adminService = require("../services/admin.service");
const settingsService = require("../services/settings.service");
const { logAudit } = require("../utils/audit");
const { getRedisClient } = require("../config/redis");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const audit = (req, entry) => { req.skipAutoAudit = true; logAudit(req, req.admin, entry); };

// ---------- Own profile / password / sessions (any active admin) ----------
const updateProfile = async (req, res) => {
    try {
        const data = await adminService.updateOwnProfile(req.admin._id, req.body || {});
        audit(req, { action: "profile.update", module: "profile", statusCode: 200, summary: "Updated own profile" });
        res.json({ success: true, data });
    } catch (e) { fail(res, 400, e.message); }
};

const changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword, refreshToken } = req.body || {};
        await adminService.changeOwnPassword(req.admin._id, currentPassword, newPassword, refreshToken);
        audit(req, { action: "auth.password_change", module: "auth", statusCode: 200, summary: "Changed own password; other devices signed out" });
        res.json({ success: true, message: "Password changed. Other devices have been signed out." });
    } catch (e) { fail(res, 400, e.message); }
};

const listSessions = async (req, res) => {
    const data = await adminService.listOwnSessions(req.admin._id, (req.body || {}).refreshToken);
    res.json({ success: true, data });
};

const revokeSession = async (req, res) => {
    const n = await adminService.revokeOwnSession(req.admin._id, String(req.params.sid));
    audit(req, { action: "auth.session_revoke", module: "auth", statusCode: 200, summary: "Signed out a device" });
    res.json({ success: true, removed: n });
};

const revokeOthers = async (req, res) => {
    const n = await adminService.revokeOtherSessions(req.admin._id, (req.body || {}).refreshToken);
    audit(req, { action: "auth.session_revoke_others", module: "auth", statusCode: 200, summary: `Signed out ${n} other device(s)` });
    res.json({ success: true, removed: n });
};

// ---------- Platform settings (superadmin) ----------
const getPlatformSettings = async (req, res) => {
    const s = await settingsService.getSettings();
    res.json({ success: true, data: s });
};

const updatePlatformSettings = async (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (b.maintenanceMode !== undefined) patch.maintenanceMode = !!b.maintenanceMode;
    if (b.maintenanceMessage !== undefined) {
        const m = String(b.maintenanceMessage).trim();
        if (!m || m.length > 200) return fail(res, 400, "Maintenance message must be 1 to 200 characters");
        patch.maintenanceMessage = m;
    }
    if (b.supportEmail !== undefined) {
        const e = String(b.supportEmail).trim();
        if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return fail(res, 400, "Enter a valid support email");
        patch.supportEmail = e;
    }
    if (b.supportPhone !== undefined) {
        const p = String(b.supportPhone).trim();
        if (p && !/^\+?[0-9 ()-]{7,20}$/.test(p)) return fail(res, 400, "Enter a valid support phone number");
        patch.supportPhone = p;
    }
    for (const key of ["termsUrl", "privacyPolicyUrl"]) {
        if (b[key] === undefined) continue;
        const u = String(b[key]).trim();
        if (u && !/^https:\/\/[^\s]+$/i.test(u)) return fail(res, 400, "Links must start with https://");
        patch[key] = u;
    }
    if (b.aboutText !== undefined) {
        const t = String(b.aboutText).trim();
        if (t.length > 500) return fail(res, 400, "About text can be at most 500 characters");
        patch.aboutText = t;
    }
    if (b.minWithdrawal !== undefined) {
        const n = Number(b.minWithdrawal);
        if (!Number.isFinite(n) || n < 100 || n > 100000) return fail(res, 400, "Minimum withdrawal must be between ₹100 and ₹1,00,000");
        patch.minWithdrawal = n;
    }
    const before = await settingsService.getSettings();
    const after = await settingsService.updateSettings(patch, req.admin._id);
    const changed = Object.keys(patch).filter((k) => String(before[k]) !== String(after[k]));
    audit(req, {
        action: patch.maintenanceMode !== undefined && before.maintenanceMode !== after.maintenanceMode
            ? (after.maintenanceMode ? "settings.maintenance_on" : "settings.maintenance_off") : "settings.update",
        module: "settings", statusCode: 200,
        summary: `Changed platform settings: ${changed.join(", ") || "no changes"}`,
        details: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }]))
    });
    res.json({ success: true, data: after });
};

const getPublicSettings = async (req, res) => {
    const s = await settingsService.getSettings();
    res.json({
        success: true,
        data: { maintenanceMode: s.maintenanceMode, maintenanceMessage: s.maintenanceMessage, supportEmail: s.supportEmail, supportPhone: s.supportPhone, minWithdrawal: s.minWithdrawal, termsUrl: s.termsUrl, privacyPolicyUrl: s.privacyPolicyUrl, aboutText: s.aboutText }
    });
};

// ---------- Read-only system + payment gateway status (superadmin) ----------
const mask = (v) => (v ? `${String(v).slice(0, 9)}••••${String(v).slice(-4)}` : null);

const getSystemInfo = async (req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID || "";
    const dbStates = ["disconnected", "connected", "connecting", "disconnecting"];
    let users = null, astrologers = null;
    try {
        [users, astrologers] = await Promise.all([
            mongoose.model("User").estimatedDocumentCount(),
            mongoose.model("Astrologer").estimatedDocumentCount()
        ]);
    } catch (e) { /* models not loaded */ }
    const redis = getRedisClient();
    const mem = process.memoryUsage();
    res.json({
        success: true,
        data: {
            server: {
                environment: process.env.NODE_ENV || "development",
                nodeVersion: process.version,
                uptimeSeconds: Math.round(process.uptime()),
                memoryMB: Math.round(mem.rss / 1048576),
                serverTime: new Date().toISOString()
            },
            database: { status: dbStates[mongoose.connection.readyState] || "unknown", users, astrologers },
            redis: { status: redis && redis.isOpen ? "connected" : "not connected" },
            payments: {
                gateway: "Razorpay",
                mode: keyId.startsWith("rzp_live") ? "live" : keyId.startsWith("rzp_test") ? "test" : keyId ? "unknown" : "not configured",
                keyId: mask(keyId),
                webhookSecretConfigured: !!process.env.RAZORPAY_WEBHOOK_SECRET
            }
        }
    });
};

module.exports = {
    updateProfile, changePassword, listSessions, revokeSession, revokeOthers,
    getPlatformSettings, updatePlatformSettings, getPublicSettings, getSystemInfo
};
