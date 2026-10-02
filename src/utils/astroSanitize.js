const { verifyToken } = require("./jwt");

const isAdminRole = (role) => role === "admin" || role === "superadmin";

// Attaches req.authUser when a valid Bearer token is present; never rejects the request.
const optionalAuth = async (req, res, next) => {
    try {
        const h = req.headers.authorization;
        if (h && h.startsWith("Bearer ")) {
            const d = verifyToken(h.split(" ")[1]);
            req.authUser = { ...d, userId: d.userId || d.id || d._id };
            if (isAdminRole(d.role)) {
                // Full astrologer details only for an active admin who may see astrologer data.
                const Admin = require("../models/admin.model");
                const a = await Admin.findById(req.authUser.userId).select("role permissions status").lean();
                const ok = a && a.status !== "disabled" && (a.role === "superadmin" ||
                    ["astrologers.view", "kyc.view", "interviews.view"].some((p) => (a.permissions || []).includes(p)));
                if (!ok) req.authUser.role = "none";
            }
        }
    } catch (e) {}
    next();
};

const PUBLIC_HIDDEN = [
    "email", "phone", "walletBalance", "totalEarnings", "chatEarnings", "callEarnings",
    "interview", "user", "astrologerLogin", "certificateFile", "certificateName"
];

const stripSecrets = (obj) => {
    if (!obj || typeof obj !== "object") return;
    delete obj.password;
    delete obj.__v;
    if (obj.astrologerLogin && typeof obj.astrologerLogin === "object") delete obj.astrologerLogin.password;
    if (obj.user && typeof obj.user === "object") delete obj.user.password;
};

const sanitizeOne = (astro, req) => {
    if (!astro) return astro;
    const a = typeof astro.toObject === "function" ? astro.toObject() : { ...astro };
    const caller = req.authUser;
    const admin = caller && isAdminRole(caller.role);
    const ownIds = [String(a._id), String((a.astrologerLogin && a.astrologerLogin._id) || a.astrologerLogin || "")];
    const self = caller && ownIds.includes(String(caller.userId));

    stripSecrets(a);
    if (!admin && !self) {
        for (const k of PUBLIC_HIDDEN) delete a[k];
    }
    return a;
};

const sanitizeAstrologers = (data, req) =>
    Array.isArray(data) ? data.map((a) => sanitizeOne(a, req)) : sanitizeOne(data, req);

module.exports = { optionalAuth, sanitizeAstrologers, isAdminRole };
