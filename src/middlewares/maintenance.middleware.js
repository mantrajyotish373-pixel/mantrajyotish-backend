const { getSettings } = require("../services/settings.service");
const { verifyToken } = require("../utils/jwt");

// When maintenance mode is on, public API traffic gets a clear 503. Admins keep working, and the
// payment webhook keeps flowing so no money event is lost.
const EXEMPT = [/^\/api\/admin(\/|$)/, /^\/api\/settings\/public$/, /^\/api\/razorpay\/webhook$/];

module.exports = async (req, res, next) => {
    if (!req.path.startsWith("/api") || EXEMPT.some((r) => r.test(req.path))) return next();
    const s = await getSettings();
    if (!s.maintenanceMode) return next();
    try {
        const h = req.headers.authorization;
        if (h && h.startsWith("Bearer ")) {
            const d = verifyToken(h.split(" ")[1]);
            if (d.role === "admin" || d.role === "superadmin") return next();
        }
    } catch (e) { /* not an admin */ }
    return res.status(503).json({ success: false, maintenance: true, message: s.maintenanceMessage });
};
