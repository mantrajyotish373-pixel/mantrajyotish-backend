const { isAdminRole } = require("./sessionAuth.middleware");

/**
 * Identity-binding middlewares. Require authMiddleware first.
 *
 * Several legacy controllers read the acting user / astrologer from the request
 * body or query string. These middlewares overwrite those fields with the identity
 * from the verified JWT so a caller can only act as themselves. Admins are left
 * untouched so admin tooling can still target any account.
 */

// Express 5 exposes req.query as a getter that re-parses on each access,
// so shadow it with an own property to make overrides stick.
const setQuery = (req, overrides, removeKeys = []) => {
    const query = { ...req.query, ...overrides };
    for (const key of removeKeys) delete query[key];
    Object.defineProperty(req, "query", { value: query, writable: true, configurable: true, enumerable: true });
};

const USER_KEYS = ["userId", "user_id", "user"];
const ASTRO_KEYS = ["astrologerId", "astrologer_id", "astrologer", "astroId"];

const callerId = (req) => String(req.user.userId || req.user.id || req.user._id);

// Drops identifier fields from the body. Object values (e.g. `user: { name }` profile
// payloads) are not identifiers and are kept.
const stripIds = (body, keys) => {
    for (const key of keys) {
        if (body[key] === undefined || body[key] === null || typeof body[key] !== "object") delete body[key];
    }
};

/** Forces body/query user identifiers to the caller (for user-initiated actions). */
const bindUserIdentity = (req, res, next) => {
    if (isAdminRole(req.user.role)) return next();

    const id = callerId(req);
    req.body = req.body || {};
    stripIds(req.body, USER_KEYS);
    req.body.userId = id;

    setQuery(req, { userId: id }, ["user_id", "user"]);
    next();
};

/** Restricts the route to astrologers and forces astrologer identifiers to the caller. */
const bindAstrologerIdentity = (req, res, next) => {
    if (isAdminRole(req.user.role)) return next();

    if (req.user.role !== "astrologer") {
        return res.status(403).json({ success: false, message: "Forbidden - Astrologer access required" });
    }

    const id = callerId(req);
    req.body = req.body || {};
    stripIds(req.body, ASTRO_KEYS);
    req.body.astrologerId = id;

    setQuery(req, { astrologerId: id, astroId: id }, ["userId"]);
    if (req.params && req.params.id) req.params.id = id;
    next();
};

/**
 * Scopes listing endpoints to the caller's own records: astrologers see their
 * sessions, users see theirs.
 */
const scopeToCaller = (req, res, next) => {
    if (isAdminRole(req.user.role)) return next();

    const id = callerId(req);
    req.body = req.body || {};
    stripIds(req.body, [...USER_KEYS, ...ASTRO_KEYS]);

    if (req.user.role === "astrologer") {
        req.body.astrologerId = id;
        setQuery(req, { astrologerId: id, astroId: id, role: "astrologer" }, USER_KEYS);
    } else {
        req.body.userId = id;
        setQuery(req, { userId: id, role: "user" }, ["user", "user_id", ...ASTRO_KEYS]);
    }
    next();
};

/**
 * For astrologer self-service routes: admins pass through; astrologers may only
 * act on their own profile (any :id must be theirs). Body identifiers are
 * replaced with the caller's Astrologer id.
 */
const requireSelfAstrologer = async (req, res, next) => {
    if (isAdminRole(req.user.role)) return next();

    const Astrologer = require("../models/astro.model");
    const id = callerId(req);
    const astro = await Astrologer.findOne({
        $or: [{ _id: id }, { astrologerLogin: id }]
    }).select("_id astrologerLogin").lean().catch(() => null);

    if (!astro) {
        return res.status(403).json({ success: false, message: "Forbidden - Astrologer access required" });
    }

    const ownIds = [String(astro._id), String(astro.astrologerLogin || "")];
    if (req.params && req.params.id && !ownIds.includes(String(req.params.id))) {
        return res.status(403).json({ success: false, message: "Forbidden - You can only modify your own profile" });
    }

    req.body = req.body || {};
    // Never let a non-admin re-link their profile to another login record
    for (const key of ["astrologerLogin", "astrologerLoginId", "user", "userId"]) delete req.body[key];

    if (req.params && req.params.id) {
        req.params.id = String(astro._id);
    } else {
        // No :id — controllers fall back to body identifiers, so pin them to the caller
        for (const key of ["id", "email", ...ASTRO_KEYS]) delete req.body[key];
        req.body.astrologerId = String(astro._id);
    }
    next();
};

module.exports = {
    bindUserIdentity,
    bindAstrologerIdentity,
    scopeToCaller,
    requireSelfAstrologer
};
