const { test } = require("node:test");
const assert = require("node:assert/strict");
const { STATUS, ACTOR, TRANSITIONS, canTransition, isLive, isTerminal, LIVE_STATUSES } = require("../src/services/session/states");
const rules = require("../src/services/session/rules");

test("legal transitions and who may trigger them", () => {
    // request is answered by the astrologer only
    assert.ok(canTransition(STATUS.PENDING, STATUS.ACTIVE, ACTOR.ASTROLOGER));
    assert.ok(canTransition(STATUS.PENDING, STATUS.CONNECTING, ACTOR.ASTROLOGER));
    assert.ok(canTransition(STATUS.PENDING, STATUS.REJECTED, ACTOR.ASTROLOGER));
    assert.ok(!canTransition(STATUS.PENDING, STATUS.ACTIVE, ACTOR.USER));
    assert.ok(!canTransition(STATUS.PENDING, STATUS.REJECTED, ACTOR.USER));
    // user cancels, system expires
    assert.ok(canTransition(STATUS.PENDING, STATUS.CANCELLED, ACTOR.USER));
    assert.ok(canTransition(STATUS.PENDING, STATUS.MISSED, ACTOR.SYSTEM));
    assert.ok(!canTransition(STATUS.PENDING, STATUS.MISSED, ACTOR.USER));
    // call connection
    assert.ok(canTransition(STATUS.CONNECTING, STATUS.ACTIVE, ACTOR.SYSTEM));
    assert.ok(!canTransition(STATUS.CONNECTING, STATUS.ACTIVE, ACTOR.USER));
    assert.ok(canTransition(STATUS.CONNECTING, STATUS.CANCELLED, ACTOR.USER));
    assert.ok(canTransition(STATUS.CONNECTING, STATUS.CANCELLED, ACTOR.ASTROLOGER));
    // either side ends; only the system completes
    assert.ok(canTransition(STATUS.ACTIVE, STATUS.ENDING, ACTOR.USER));
    assert.ok(canTransition(STATUS.ACTIVE, STATUS.ENDING, ACTOR.ASTROLOGER));
    assert.ok(canTransition(STATUS.ACTIVE, STATUS.ENDING, ACTOR.SYSTEM));
    assert.ok(canTransition(STATUS.ENDING, STATUS.COMPLETED, ACTOR.SYSTEM));
    assert.ok(!canTransition(STATUS.ENDING, STATUS.COMPLETED, ACTOR.USER));
});

test("illegal transitions are rejected", () => {
    assert.ok(!canTransition(STATUS.PENDING, STATUS.ENDING, ACTOR.SYSTEM), "cannot end what never started");
    assert.ok(!canTransition(STATUS.PENDING, STATUS.COMPLETED, ACTOR.SYSTEM));
    assert.ok(!canTransition(STATUS.ACTIVE, STATUS.COMPLETED, ACTOR.SYSTEM), "must pass through ENDING");
    assert.ok(!canTransition(STATUS.ACTIVE, STATUS.CANCELLED, ACTOR.USER), "an active session is ended, not cancelled");
    assert.ok(!canTransition(STATUS.ACTIVE, STATUS.PENDING, ACTOR.SYSTEM));
    assert.ok(!canTransition(STATUS.CONNECTING, STATUS.COMPLETED, ACTOR.SYSTEM), "a call that never connected is never billed");
});

test("terminal states have no outgoing transitions", () => {
    for (const s of [STATUS.COMPLETED, STATUS.REJECTED, STATUS.CANCELLED, STATUS.MISSED]) {
        assert.ok(isTerminal(s));
        assert.ok(!isLive(s));
        assert.equal(TRANSITIONS[s], undefined, `${s} must be terminal`);
    }
});

test("exactly PENDING, CONNECTING, ACTIVE, ENDING hold the live lock", () => {
    assert.deepEqual([...LIVE_STATUSES].sort(), [STATUS.ACTIVE, STATUS.CONNECTING, STATUS.ENDING, STATUS.PENDING].sort());
});

test("existing wallet rules are reproduced exactly", () => {
    // rate: chat is flat 9; calls use consultationFee or 9
    assert.equal(rules.resolveRate({ consultationFee: 40 }, "CHAT"), 9);
    assert.equal(rules.resolveRate({ consultationFee: 40 }, "AUDIO"), 40);
    assert.equal(rules.resolveRate({ consultationFee: 40 }, "VIDEO"), 40);
    assert.equal(rules.resolveRate({ consultationFee: 0 }, "VIDEO"), 9);
    assert.equal(rules.resolveRate({}, "AUDIO"), 9);
    // minimum balance: two minutes
    assert.equal(rules.minimumStartBalance(9), 18);
    assert.equal(rules.minimumStartBalance(25), 50);
    // max duration: floor(balance / ratePerSec), at least 1 second
    assert.equal(rules.maxBillableSeconds(500, 9), 3333);
    assert.equal(rules.maxBillableSeconds(10, 9), 66);
    assert.equal(rules.maxBillableSeconds(0, 9), 1);
    // low balance: less than one minute left
    assert.equal(rules.isLowBalance(8.99, 9), true);
    assert.equal(rules.isLowBalance(9, 9), false);
    // type normalisation as in the legacy engine
    assert.equal(rules.normalizeType("video"), "VIDEO");
    assert.equal(rules.normalizeType("VOICE"), "AUDIO");
    assert.equal(rules.normalizeType("CALL"), "AUDIO");
    assert.equal(rules.normalizeType(undefined), "CHAT");
});

test("the request timeout is the single server-owned 30 second value", () => {
    assert.equal(rules.CONFIG.REQUEST_TIMEOUT_SECONDS, 30);
    assert.equal(rules.CONFIG.CONNECT_TIMEOUT_SECONDS, 20);
});
