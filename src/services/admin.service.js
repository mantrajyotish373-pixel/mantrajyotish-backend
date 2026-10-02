const Admin = require("../models/admin.model");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { generateToken } = require("../utils/jwt");

const ACCESS_TOKEN_TTL = process.env.ADMIN_ACCESS_TOKEN_TTL || "2h";
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 5;

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
const adminPayload = (admin) => ({ userId: admin._id, role: admin.role });

/**
 * Register / Create new Admin
 */
const createAdmin = async (data) => {
    const { name, email, password, role } = data;

    if (!name || !email || !password) {
        throw new Error("Name, email and password are required for admin creation");
    }
    if (String(password).length < 8) {
        throw new Error("Password must be at least 8 characters");
    }

    const existingAdmin = await Admin.findOne({ email: email.toLowerCase() });
    if (existingAdmin) {
        throw new Error("Admin with this email already exists");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const admin = await Admin.create({
        name,
        email: email.toLowerCase(),
        password: hashedPassword,
        role: role || "admin"
    });

    const token = generateToken(adminPayload(admin), ACCESS_TOKEN_TTL);

    return {
        admin: {
            _id: admin._id,
            name: admin.name,
            email: admin.email,
            role: admin.role,
            createdAt: admin.createdAt
        },
        token
    };
};

/**
 * Login Admin with Email and Password
 */
const loginAdmin = async (email, password, userAgent = "") => {
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

    const refreshToken = crypto.randomBytes(48).toString("hex");
    const now = Date.now();
    admin.refreshSessions = (admin.refreshSessions || [])
        .filter((r) => r.expiresAt.getTime() > now)
        .slice(-(MAX_SESSIONS - 1));
    admin.refreshSessions.push({
        hash: hashToken(refreshToken),
        expiresAt: new Date(now + REFRESH_TTL_MS),
        userAgent: String(userAgent).slice(0, 200)
    });
    admin.lastLoginAt = new Date();
    await admin.save();

    return {
        admin: {
            _id: admin._id,
            name: admin.name,
            email: admin.email,
            role: admin.role,
            lastLoginAt: admin.lastLoginAt
        },
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
    if (!session || session.expiresAt.getTime() <= Date.now()) {
        throw new Error("Session expired. Please log in again.");
    }

    session.expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await admin.save();

    return {
        admin: { _id: admin._id, name: admin.name, email: admin.email, role: admin.role },
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
    return admin;
};

module.exports = {
    createAdmin,
    loginAdmin,
    refreshAdminSession,
    logoutAdmin,
    getAdminById
};
