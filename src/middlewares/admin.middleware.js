const Admin = require("../models/admin.model");

const adminMiddleware = async (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            success: false,
            message: "Unauthorized - Access denied"
        });
    }

    if (req.user.role !== "admin" && req.user.role !== "superadmin") {
        return res.status(403).json({
            success: false,
            message: "Forbidden - Admin access required"
        });
    }

    // A token alone is not enough: the admin account must still exist, so removed admins lose access immediately.
    try {
        const admin = await Admin.exists({ _id: req.user.userId });
        if (!admin) {
            return res.status(401).json({
                success: false,
                message: "Unauthorized - Admin account no longer exists"
            });
        }
    } catch (e) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    next();
};

module.exports = adminMiddleware;
