/**
 * Compatibility wrapper. Chat billing is no longer driven by per-session timers: the start time,
 * balance limit and settlement are owned by the Session Engine (services/session).
 */
const engine = require("./session/engine");

const noop = () => {};

const endChatSession = async (sessionId) => {
    const result = await engine.endSession({ sessionId, actor: { system: true }, reason: "Chat consultation completed" });
    return result.session;
};

module.exports = {
    startBillingTimer: noop,
    stopBillingTimer: noop,
    endChatSession,
    pauseChatBilling: async () => {},
    resumeChatBilling: async () => {}
};
