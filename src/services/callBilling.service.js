/**
 * Compatibility wrapper. Call billing is no longer driven by per-session timers: the start time,
 * balance limit and settlement are owned by the Session Engine (services/session).
 */
const noop = () => {};

module.exports = {
    startCallBillingTimer: noop,
    stopCallBillingTimer: noop,
    pauseCallBilling: async () => {},
    resumeCallBilling: async () => {}
};
