/**
 * Keeps the astrologer's public availability flag in step with the session lock.
 *
 * The database lock (Session.liveLock, partial unique index) is what actually protects an
 * astrologer from a second request. `isAvailable` is only the display value derived from it, so
 * it is always RECOMPUTED from the truth (online, not manually offline, no live session) rather
 * than set blindly. That makes overlapping background writes converge instead of racing.
 */
const Astrologer = require("../../models/astro.model");
const Session = require("../../models/session.model");

const broadcast = (astroId, isOnline, isAvailable) => {
    try {
        const { getIO } = require("../../config/socket");
        const io = getIO();
        io.emit("astrologer_status_changed", {
            astrologerId: String(astroId),
            isOnline: Boolean(isOnline),
            isAvailable: Boolean(isAvailable)
        });
    } catch (_) {
        // realtime not initialised (e.g. unit tests); nothing to broadcast
    }
};

const refreshOnlineCache = () => {
    try {
        const astroService = require("../astro.service");
        Promise.resolve(astroService.rebuildOnlineAstrologersCache()).catch(() => null);
    } catch (_) {
        // the cache is an optimisation only
    }
};

/** Recompute and store isAvailable from the truth. Returns the final value, or null if unknown. */
const syncAvailability = async (astroId) => {
    let last = null;
    let changed = false;
    let online = false;
    for (let i = 0; i < 3; i += 1) {
        const [astro, live] = await Promise.all([
            Astrologer.findById(astroId).select("isOnline manualOffline isAvailable").lean(),
            Session.exists({ astrologer: astroId, liveLock: true })
        ]);
        if (!astro) return null;
        online = Boolean(astro.isOnline);
        const shouldBeAvailable = online && !astro.manualOffline && !live;
        if (astro.isAvailable !== shouldBeAvailable) {
            await Astrologer.updateOne({ _id: astroId }, { $set: { isAvailable: shouldBeAvailable } });
            changed = true;
        }
        // re-read once more if a lock appeared/disappeared while writing
        if (last === shouldBeAvailable) break;
        last = shouldBeAvailable;
        if (!changed) break;
    }
    if (changed) {
        broadcast(astroId, online, last);
        refreshOnlineCache();
    }
    return last;
};

/** A request / accepted session now occupies this astrologer. */
const markBusy = async (astroId, { presence = false, sessionId = null } = {}) => {
    if (presence) {
        try {
            const { transitionStatus } = require("../presence.service");
            await transitionStatus(astroId, "BUSY", sessionId);
        } catch (_) {
            // presence (Redis) is best-effort; Mongo + the lock remain authoritative
        }
    }
    await syncAvailability(astroId);
};

/** The astrologer's lock was released; they become available again if nothing else holds them. */
const markFree = async (astroId) => {
    if (!(await Session.exists({ astrologer: astroId, liveLock: true }))) {
        try {
            const astro = await Astrologer.findById(astroId).select("manualOffline").lean();
            if (astro && !astro.manualOffline) {
                const { transitionStatus } = require("../presence.service");
                await transitionStatus(astroId, "ONLINE");
            }
        } catch (_) {
            // best-effort
        }
    }
    await syncAvailability(astroId);
};

module.exports = { markBusy, markFree, syncAvailability };
