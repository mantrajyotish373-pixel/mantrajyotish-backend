/**
 * Session lifecycle: one state machine for Chat, Audio and Video.
 *
 *   PENDING --accept(chat)-----------------------------> ACTIVE
 *   PENDING --accept(audio/video)--> CONNECTING --both media_ready--> ACTIVE
 *   PENDING --reject--> REJECTED      PENDING --cancel--> CANCELLED      PENDING --expire--> MISSED
 *   CONNECTING --deadline | either side ends--> CANCELLED (no charge)
 *   ACTIVE --end--> ENDING --all settlement legs applied--> COMPLETED
 */
const STATUS = Object.freeze({
    PENDING: "PENDING",
    CONNECTING: "CONNECTING",
    ACTIVE: "ACTIVE",
    ENDING: "ENDING",
    COMPLETED: "COMPLETED",
    REJECTED: "REJECTED",
    CANCELLED: "CANCELLED",
    MISSED: "MISSED"
});

const ACTOR = Object.freeze({ USER: "USER", ASTROLOGER: "ASTROLOGER", SYSTEM: "SYSTEM" });

// Statuses that occupy the one-live-session-per-astrologer / per-user lock
const LIVE_STATUSES = Object.freeze([STATUS.PENDING, STATUS.CONNECTING, STATUS.ACTIVE, STATUS.ENDING]);
const TERMINAL_STATUSES = Object.freeze([STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED, STATUS.MISSED]);

// from -> to -> actors allowed to trigger it
const TRANSITIONS = Object.freeze({
    [STATUS.PENDING]: {
        [STATUS.ACTIVE]: [ACTOR.ASTROLOGER],
        [STATUS.CONNECTING]: [ACTOR.ASTROLOGER],
        [STATUS.REJECTED]: [ACTOR.ASTROLOGER],
        [STATUS.CANCELLED]: [ACTOR.USER, ACTOR.SYSTEM],
        [STATUS.MISSED]: [ACTOR.SYSTEM]
    },
    [STATUS.CONNECTING]: {
        [STATUS.ACTIVE]: [ACTOR.SYSTEM], // when the second participant reports media_ready
        [STATUS.CANCELLED]: [ACTOR.USER, ACTOR.ASTROLOGER, ACTOR.SYSTEM]
    },
    [STATUS.ACTIVE]: {
        [STATUS.ENDING]: [ACTOR.USER, ACTOR.ASTROLOGER, ACTOR.SYSTEM]
    },
    [STATUS.ENDING]: {
        [STATUS.COMPLETED]: [ACTOR.SYSTEM]
    }
});

const canTransition = (from, to, actor) => {
    const allowed = TRANSITIONS[from] && TRANSITIONS[from][to];
    return Boolean(allowed && allowed.includes(actor));
};

const isLive = (status) => LIVE_STATUSES.includes(status);
const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

module.exports = { STATUS, ACTOR, LIVE_STATUSES, TERMINAL_STATUSES, TRANSITIONS, canTransition, isLive, isTerminal };
