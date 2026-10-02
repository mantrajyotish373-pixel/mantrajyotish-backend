/**
 * Compatibility facade. The session lifecycle now lives in services/session/* (one engine for
 * Chat, Audio and Video, MongoDB as the source of truth, no per-session timers). This module only
 * keeps the old import surface for callers that have not been migrated yet.
 */
const engine = require("./session/engine");
const { findUserByIdOrRef, findAstrologerByIdOrRef } = require("./session/lookup");

/** System-initiated end (e.g. orphan cleanup). Returns the session, like the legacy function did. */
const endSession = async ({ sessionId, reason = "Consultation completed" }) => {
    const result = await engine.endSession({ sessionId, actor: { system: true }, reason });
    return result.session;
};

// Billing time is derived from stored timestamps and evaluated by the scheduler, so there is no
// timer to start or stop. Kept as no-ops for old call sites.
const noop = () => {};

module.exports = {
    endSession,
    findUserByIdOrRef,
    findAstrologerByIdOrRef,
    startSessionBillingTimer: noop,
    stopSessionBillingTimer: noop,
    stopAllSessionBillingTimers: noop,
    // participant connection tracking moved to the engine's connection policy (connection.js)
    handleParticipantDisconnect: async () => {},
    handleParticipantReconnect: async () => {}
};
