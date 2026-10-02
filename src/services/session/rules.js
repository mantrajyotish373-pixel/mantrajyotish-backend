/**
 * The application's EXISTING wallet / pricing / low-balance rules, gathered in one place.
 * Every function reproduces the formula the legacy code already used (the original location
 * is noted). The Session Engine calls these; it does not define new business rules.
 * The pricing project later replaces resolveRate() only.
 */
const intFromEnv = (name, fallback) => {
    const n = parseInt(process.env[name], 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Operational timings (not wallet rules)
const CONFIG = Object.freeze({
    REQUEST_TIMEOUT_SECONDS: intFromEnv("SESSION_REQUEST_TIMEOUT_SECONDS", 30), // server-authoritative PENDING timeout
    CONNECT_TIMEOUT_SECONDS: intFromEnv("SESSION_CONNECT_TIMEOUT_SECONDS", 20), // audio/video media connection deadline
    DISCONNECT_GRACE_SECONDS: Object.freeze({
        CHAT: intFromEnv("SESSION_GRACE_CHAT_SECONDS", 60), // legacy: GRACE_PERIOD_MS = 60000
        AUDIO: intFromEnv("SESSION_GRACE_AUDIO_SECONDS", 60),
        VIDEO: intFromEnv("SESSION_GRACE_VIDEO_SECONDS", 60)
    }),
    TICK_INTERVAL_SECONDS: intFromEnv("SESSION_TICK_SECONDS", 10), // legacy: timer_tick every 10s
    HEARTBEAT_STALE_SECONDS: intFromEnv("SESSION_HEARTBEAT_STALE_SECONDS", 45), // legacy worst-case Socket.IO detection
    PAUSE_LIMIT_SECONDS: intFromEnv("SESSION_PAUSE_LIMIT_SECONDS", 120), // legacy: recharge pause safety (120000 ms)
    SETTLEMENT_RETRY_AFTER_SECONDS: intFromEnv("SESSION_SETTLEMENT_RETRY_SECONDS", 15)
});

const normalizeType = (raw) => {
    const t = String(raw || "CHAT").toUpperCase();
    if (t.includes("VIDEO") || t === "VID") return "VIDEO";
    if (t.includes("AUDIO") || t === "CALL" || t === "VOICE" || t === "PHONE") return "AUDIO";
    return "CHAT";
};

/**
 * Per-minute rate. Today's behaviour:
 *   chat  -> flat 9 (chat.controller.js: `const perMinuteRate = 9`)
 *   calls -> astrologer.consultationFee || 9 (sessionEngine.service.js createSessionRequest)
 */
const resolveRate = (astrologer, type) => {
    if (type === "CHAT") return 9;
    return Number(astrologer && astrologer.consultationFee) || 9;
};

/** Minimum wallet balance to start: two minutes (legacy `rate * 2`, three copies). */
const minimumStartBalance = (rate) => Number(rate) * 2;

/** Seconds the wallet can pay for (legacy `Math.max(1, Math.floor(balance / ratePerSec))`). */
const maxBillableSeconds = (balance, rate) => {
    const ratePerSec = Number(rate) / 60;
    return Math.max(1, Math.floor((Number(balance) || 0) / ratePerSec));
};

/** Low-balance warning: under one minute of balance left (legacy `remainingBalance < rate`). */
const isLowBalance = (remainingBalance, rate) => Number(remainingBalance) < Number(rate);

module.exports = {
    CONFIG,
    normalizeType,
    resolveRate,
    minimumStartBalance,
    maxBillableSeconds,
    isLowBalance
};
