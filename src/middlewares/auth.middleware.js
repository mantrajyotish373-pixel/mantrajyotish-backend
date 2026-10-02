const { verifyToken } = require("../utils/jwt");

const authMiddleware = (req, res, next) => {

    try {

        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith("Bearer ")) {

            return res.status(401).json({
                success: false,
                message: "Unauthorized"
            });

        }

        const token = authHeader.split(" ")[1];

        const decoded = verifyToken(token);

        // Tokens carry `userId`; controllers historically read `id` / `_id`, so expose all three.
        const callerId = decoded.userId || decoded.id || decoded._id;
        req.user = { ...decoded, userId: callerId, id: callerId, _id: callerId };

        next();

    } catch (error) {

        return res.status(401).json({
            success: false,
            message: "Invalid Token"
        });

    }

};

module.exports = authMiddleware;
