const buckets = new Map();

// Last X-Forwarded-For entry is the one appended by our own nginx, so it cannot be spoofed by the client.
const clientIp = (req) => {
    const xff = req.headers["x-forwarded-for"];
    if (xff) return String(xff).split(",").pop().trim();
    return req.ip || req.socket.remoteAddress || "unknown";
};

const rateLimit = ({ windowMs, max, keyPrefix, message }) => (req, res, next) => {
    const key = `${keyPrefix}:${clientIp(req)}`;
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        buckets.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
        res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
        return res.status(429).json({
            success: false,
            message: message || "Too many attempts. Please try again later."
        });
    }
    return next();
};

setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) if (entry.resetAt <= now) buckets.delete(key);
}, 10 * 60 * 1000).unref();

module.exports = { rateLimit };
