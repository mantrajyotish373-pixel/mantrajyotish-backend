/**
 * The Session Engine's clock. ONE loop (not one timer per session) evaluates deadlines that are
 * stored on the sessions themselves, so it needs no in-memory state: a restart, a crash or a
 * second backend instance changes nothing. Each pass runs a handful of indexed queries:
 *
 *   PENDING  past expiresAt        -> MISSED
 *   CONNECTING past connectDeadline-> CANCELLED (no charge)
 *   ACTIVE   past maxEndAt         -> ended (wallet exhausted, existing rule)
 *   ENDING   not settled yet       -> settlement retried (crash recovery)
 *   ACTIVE   tick due              -> clock resync + existing low-balance warning
 *
 * With several instances only the holder of the Redis lock runs a pass; without Redis a single
 * instance simply runs it. Every transition is an atomic engine operation, so even an overlap
 * could not double-apply anything.
 */
const crypto = require("crypto");
const Session = require("../../models/session.model");
const engine = require("./engine");
const realtime = require("./realtime");
const handlers = require("./handlers");
const connection = require("./connection");
const rules = require("./rules");
const { STATUS } = require("./states");

const LOCK_KEY = "session-engine:scheduler";

const getRedis = () => {
    try {
        const client = require("../../config/redis").getRedisClient();
        return client && client.isOpen ? client : null;
    } catch (_) {
        return null;
    }
};

/** Lock so only one instance runs a pass. No Redis => single instance => always acquired. */
const tryAcquire = async (ttlMs) => {
    const client = getRedis();
    if (!client) return { ok: true, release: async () => {} };
    const token = crypto.randomBytes(8).toString("hex");
    const res = await client.set(LOCK_KEY, token, { NX: true, PX: ttlMs });
    if (res !== "OK") return { ok: false, release: async () => {} };
    return {
        ok: true,
        release: async () => {
            try {
                await client.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", {
                    keys: [LOCK_KEY],
                    arguments: [token]
                });
            } catch (_) {
                // lock expires by itself
            }
        }
    };
};

const safely = async (label, fn) => {
    try {
        return await fn();
    } catch (err) {
        console.error(`Session scheduler (${label}) error:`, err.message);
        return null;
    }
};

// ---------------------------------------------------------------------------------------
// passes
// ---------------------------------------------------------------------------------------

const expireRequests = async ({ io, now }) => {
    const missed = await engine.expirePending({ now });
    for (const s of missed) realtime.emitRequestClosed(io, s, { kind: "missed", message: "Request timed out." });
    const failed = await engine.expireConnecting({ now });
    for (const s of failed) realtime.emitRequestClosed(io, s, { kind: "cancelled", message: "Could not establish the call in time." });
    return missed.length + failed.length;
};

/** Wallet can no longer pay: end exactly at maxEndAt, even if this pass runs late. */
const endExhausted = async ({ io, now }) => {
    const due = await Session.find({ status: STATUS.ACTIVE, maxEndAt: { $lte: now }, billingPausedAt: null })
        .select("_id maxEndAt")
        .limit(100)
        .lean();
    for (const d of due) {
        await safely("end exhausted", () =>
            handlers.endSession({ sessionId: d._id, system: true, reason: "INSUFFICIENT_BALANCE", endAt: d.maxEndAt, insufficientFunds: true })
        );
    }
    return due.length;
};

/** Recharge pause lasted longer than the 2 minute limit (existing rule): end the session. */
const endExpiredPauses = async ({ io, now }) => {
    const due = await Session.find({ status: STATUS.ACTIVE, billingPausedAt: { $ne: null }, pauseDeadline: { $lte: now } })
        .select("_id pauseDeadline")
        .limit(100)
        .lean();
    for (const d of due) {
        await safely("end expired pause", () =>
            handlers.endSession({ sessionId: d._id, system: true, reason: "Recharge timeout exceeded", endAt: d.pauseDeadline, insufficientFunds: true })
        );
    }
    return due.length;
};

/** A session left in ENDING (process died mid-settlement) is settled again. */
const retrySettlements = async ({ io, now }) => {
    const cutoff = new Date(now.getTime() - rules.CONFIG.SETTLEMENT_RETRY_AFTER_SECONDS * 1000);
    const stuck = await Session.find({ status: STATUS.ENDING, endedAt: { $lte: cutoff } }).select("_id").limit(50).lean();
    for (const s of stuck) {
        await safely("settlement retry", async () => {
            const settled = await engine.settleSession(s._id, now);
            if (settled && settled.status === STATUS.COMPLETED) realtime.emitEnded(io, settled, { message: "Consultation session ended." });
        });
    }
    return stuck.length;
};

/** Periodic clock resync + low-balance warning. Each tick is claimed atomically (one emitter). */
const emitTicks = async ({ io, now }) => {
    const dueBefore = new Date(now.getTime() - rules.CONFIG.TICK_INTERVAL_SECONDS * 1000);
    const due = await Session.find({
        status: STATUS.ACTIVE,
        billingPausedAt: null,
        $or: [{ lastTickAt: null }, { lastTickAt: { $lte: dueBefore } }]
    })
        .limit(500)
        .lean();

    let sent = 0;
    for (const s of due) {
        const claimed = await Session.findOneAndUpdate(
            { _id: s._id, status: STATUS.ACTIVE, lastTickAt: s.lastTickAt || null },
            { $set: { lastTickAt: now } },
            { returnDocument: "after" }
        ).lean();
        if (!claimed) continue; // another instance took this tick
        realtime.emitTick(io, claimed, now);
        sent += 1;
    }
    return sent;
};

/** One pass of everything that is time-driven. Exposed for tests and for startup recovery. */
const runTick = async ({ io = null, now = new Date() } = {}) => {
    const out = {};
    out.requests = await safely("expire requests", () => expireRequests({ io, now }));
    out.exhausted = await safely("end exhausted", () => endExhausted({ io, now }));
    out.pauses = await safely("end expired pause", () => endExpiredPauses({ io, now }));
    for (const task of extraTasks) {
        out[task.name] = await safely(task.name, () => task.run({ io, now }));
    }
    out.settlements = await safely("settlement retry", () => retrySettlements({ io, now }));
    out.ticks = await safely("ticks", () => emitTicks({ io, now }));
    return out;
};

const extraTasks = [];
const registerTask = (name, run) => extraTasks.push({ name, run });

/** Grace window ran out: end the session at the deadline (astrologer-absent seconds stay unbilled). */
const endExpiredGrace = async ({ now }) => {
    const due = await connection.findExpiredGrace({ now });
    for (const d of due) {
        await safely("end after grace", () =>
            handlers.endSession({ sessionId: d.sessionId, system: true, reason: d.reason, endAt: d.endAt, message: d.message })
        );
    }
    return due.length;
};

/**
 * Self-healing for the public availability flag: an online astrologer with no live session is
 * available. Heals a flag left false by a crash between a session ending and its follow-up write.
 */
let lastAvailabilityReconcile = 0;
const reconcileAvailability = async ({ now }) => {
    if (now.getTime() - lastAvailabilityReconcile < 30000) return 0;
    lastAvailabilityReconcile = now.getTime();
    const Astrologer = require("../../models/astro.model");
    const busy = await Session.distinct("astrologer", { liveLock: true });
    const res = await Astrologer.updateMany(
        { isOnline: true, manualOffline: { $ne: true }, isAvailable: false, _id: { $nin: busy } },
        { $set: { isAvailable: true } }
    );
    return res.modifiedCount;
};

registerTask("disconnects", ({ io, now }) => connection.detectDisconnects({ io, now }));
registerTask("grace", endExpiredGrace);
registerTask("availability", reconcileAvailability);

// ---------------------------------------------------------------------------------------
// loop
// ---------------------------------------------------------------------------------------

let timer = null;
let running = false;

const start = ({ getIo = handlers.getIo, intervalMs = 1000, recover = true } = {}) => {
    if (timer) return;
    if (recover) {
        // in-memory state is gone after a restart; participants of ACTIVE sessions get their grace window
        connection.recoverOnStart({ io: getIo() })
            .then((n) => n && console.log(`♻️ Session recovery: ${n} participant(s) of live sessions entered their grace window`))
            .catch((err) => console.error("Session recovery failed:", err.message));
    }
    timer = setInterval(async () => {
        if (running) return; // never overlap passes in one process
        running = true;
        let lock = null;
        try {
            lock = await tryAcquire(Math.max(5000, intervalMs * 5));
            if (lock.ok) await runTick({ io: getIo() });
        } catch (err) {
            console.error("Session scheduler pass failed:", err.message);
        } finally {
            if (lock) await lock.release();
            running = false;
        }
    }, intervalMs);
    if (timer.unref) timer.unref();
    console.log(`⏱️ Session scheduler started (every ${intervalMs}ms)`);
};

const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
};

module.exports = { start, stop, runTick, registerTask, tryAcquire };
