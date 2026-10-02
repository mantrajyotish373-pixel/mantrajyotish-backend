const Admin = require("../models/admin.model");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { generateToken } = require("../utils/jwt");
const { ALL_PERMISSIONS } = require("../config/permissions");

const ACCESS_TOKEN_TTL = process.env.ADMIN_ACCESS_TOKEN_TTL || "2h";
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5;

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
const adminPayload = (admin) => ({ userId: admin._id, role: admin.role });

const publicAdmin = (admin) => ({
    _id: admin._id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    roleName: admin.role === "superadmin" ? "Super Admin" : (admin.roleName || "Sub Admin"),
    permissions: admin.role === "superadmin" ? ALL_PERMISSIONS : (admin.permissions || []),
    status: admin.status || "active",
    lastLoginAt: admin.lastLoginAt || null,
    phone: admin.phone || "",
    passwordChangedAt: admin.passwordChangedAt || null,
    createdAt: admin.createdAt || null
});

/**
 * Login Admin with Email and Password
 */
const loginAdmin = async (email, password, userAgent = "", ip = "") => {
    if (!email || !password) {
        throw new Error("Email and password are required");
    }

    const admin = await Admin.findOne({ email: String(email).toLowerCase() }).select("+refreshSessions");
    if (!admin) {
        throw new Error("Invalid admin email or password");
    }

    const isPasswordValid = await bcrypt.compare(password, admin.password);
    if (!isPasswordValid) {
        throw new Error("Invalid admin email or password");
    }
    if (admin.status === "disabled") {
        throw new Error("This account has been disabled. Contact the super admin.");
    }

    const refreshToken = crypto.randomBytes(48).toString("hex");
    const now = Date.now();
    admin.refreshSessions = (admin.refreshSessions || [])
        .filter((r) => r.expiresAt.getTime() > now)
        .slice(-(MAX_SESSIONS - 1));
    admin.refreshSessions.push({
        hash: hashToken(refreshToken),
        expiresAt: new Date(now + REFRESH_TTL_MS),
        userAgent: String(userAgent).slice(0, 200),
        sid: crypto.randomBytes(8).toString("hex"),
        ip: String(ip).slice(0, 64),
        lastUsedAt: new Date()
    });
    admin.lastLoginAt = new Date();
    await admin.save();

    return {
        admin: publicAdmin(admin),
        token: generateToken(adminPayload(admin), ACCESS_TOKEN_TTL),
        refreshToken
    };
};

/**
 * Exchange a valid refresh token for a new access token. Sliding 30-day window:
 * every successful refresh extends the session, so an active admin stays logged in.
 */
const refreshAdminSession = async (refreshToken) => {
    if (!refreshToken || typeof refreshToken !== "string") {
        throw new Error("Refresh token required");
    }
    const hash = hashToken(refreshToken);
    const admin = await Admin.findOne({ "refreshSessions.hash": hash }).select("+refreshSessions");
    const session = admin && admin.refreshSessions.find((r) => r.hash === hash);
    if (!session || session.expiresAt.getTime() <= Date.now() || admin.status === "disabled") {
        throw new Error("Session expired. Please log in again.");
    }

    session.expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    session.lastUsedAt = new Date();
    if (!session.sid) session.sid = crypto.randomBytes(8).toString("hex");
    await admin.save();

    return {
        admin: publicAdmin(admin),
        token: generateToken(adminPayload(admin), ACCESS_TOKEN_TTL)
    };
};

const logoutAdmin = async (refreshToken) => {
    if (!refreshToken || typeof refreshToken !== "string") return;
    await Admin.updateOne(
        { "refreshSessions.hash": hashToken(refreshToken) },
        { $pull: { refreshSessions: { hash: hashToken(refreshToken) } } }
    );
};

/**
 * Get Admin Details by ID
 */
const getAdminById = async (id) => {
    const admin = await Admin.findById(id).select("-password");
    if (!admin) {
        throw new Error("Admin account not found");
    }
    return publicAdmin(admin);
};

// ---------- Own profile, password and sessions ----------
const updateOwnProfile = async (id, { name, phone }) => {
    const admin = await Admin.findById(id);
    if (!admin) throw new Error("Admin account not found");
    if (name !== undefined) {
        const n = String(name).trim();
        if (n.length < 2 || n.length > 80) throw new Error("Name must be 2 to 80 characters");
        admin.name = n;
    }
    if (phone !== undefined) {
        const ph = String(phone).trim();
        if (ph && !/^\+?[0-9 ()-]{7,20}$/.test(ph)) throw new Error("Enter a valid phone number");
        admin.phone = ph;
    }
    await admin.save();
    return publicAdmin(admin);
};

// Changing the password signs the account out everywhere except the device making the change.
const changeOwnPassword = async (id, currentPassword, newPassword, keepRefreshToken) => {
    if (!currentPassword || !newPassword) throw new Error("Current and new password are required");
    if (String(newPassword).length < 8) throw new Error("New password must be at least 8 characters");
    if (currentPassword === newPassword) throw new Error("New password must be different from the current one");
    const admin = await Admin.findById(id).select("+refreshSessions");
    if (!admin) throw new Error("Admin account not found");
    if (!(await bcrypt.compare(currentPassword, admin.password))) throw new Error("Current password is incorrect");
    admin.password = await bcrypt.hash(String(newPassword), 10);
    admin.passwordChangedAt = new Date();
    const keep = keepRefreshToken ? hashToken(keepRefreshToken) : null;
    admin.refreshSessions = (admin.refreshSessions || []).filter((r) => keep && r.hash === keep);
    await admin.save();
};

const listOwnSessions = async (id, currentRefreshToken) => {
    const admin = await Admin.findById(id).select("+refreshSessions");
    const cur = currentRefreshToken ? hashToken(currentRefreshToken) : null;
    const now = Date.now();
    return (admin?.refreshSessions || [])
        .filter((r) => r.expiresAt.getTime() > now)
        .map((r) => ({
            sid: r.sid || r.hash.slice(0, 16),
            userAgent: r.userAgent || "",
            ip: r.ip || "",
            createdAt: r.createdAt,
            lastUsedAt: r.lastUsedAt || r.createdAt,
            current: !!cur && r.hash === cur
        }))
        .sort((a, b) => new Date(b.lastUsedAt) - new Date(a.lastUsedAt));
};

const revokeOwnSession = async (id, sid) => {
    const admin = await Admin.findById(id).select("+refreshSessions");
    if (!admin) return 0;
    const before = admin.refreshSessions.length;
    admin.refreshSessions = admin.refreshSessions.filter((r) => (r.sid || r.hash.slice(0, 16)) !== sid);
    await admin.save();
    return before - admin.refreshSessions.length;
};

const revokeOtherSessions = async (id, currentRefreshToken) => {
    const admin = await Admin.findById(id).select("+refreshSessions");
    if (!admin) return 0;
    const keep = currentRefreshToken ? hashToken(currentRefreshToken) : null;
    const before = admin.refreshSessions.length;
    admin.refreshSessions = admin.refreshSessions.filter((r) => keep && r.hash === keep);
    await admin.save();
    return before - admin.refreshSessions.length;
};

module.exports = {
    updateOwnProfile,
    changeOwnPassword,
    listOwnSessions,
    revokeOwnSession,
    revokeOtherSessions,
    publicAdmin,
    hashToken,
    loginAdmin,
    refreshAdminSession,
    logoutAdmin,
    getAdminById
};
