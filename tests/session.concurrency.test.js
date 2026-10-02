/**
 * Phase 2: atomicity, idempotency and concurrency, against a real MongoDB.
 * These tests fire many operations at the same instant and assert the database invariants:
 * one live session per astrologer/user, one transition winner, one settlement, money conserved.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./helpers/harness");

let mongo;
let engine;
let settlement;
let Session;
let User;
let Astrologer;
let Admin;
let WalletTransaction;
let mirror;

const T0 = new Date("2026-10-02T10:00:00.000Z");
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);

before(async () => {
    mongo = await h.startMongo();
    engine = require("../src/services/session/engine");
    settlement = require("../src/services/session/settlement");
    mirror = require("../src/services/session/legacyMirror");
    Session = require("../src/models/session.model");
    User = require("../src/models/user.model");
    Astrologer = require("../src/models/astro.model");
    Admin = require("../src/models/admin.model");
    WalletTransaction = require("../src/models/walletTransaction.model");
    await h.syncAllIndexes();
});

after(async () => {
    await mirror.flushMirrors();
    await mongo.stop();
});

beforeEach(async () => {
    await mirror.flushMirrors();
    await h.resetData();
});

const request = (user, astro, type = "CHAT", extra = {}) =>
    engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type, now: T0, ...extra });

const settled = async (promises) => Promise.allSettled(promises);
const ok = (results) => results.filter((r) => r.status === "fulfilled");
const failed = (results) => results.filter((r) => r.status === "rejected");

/** An ACTIVE chat session, ready to be ended. */
const activeSession = async ({ balance = 500, astro: astroOverride } = {}) => {
    const user = await h.createUser({ walletBalance: balance });
    const astro = astroOverride || (await h.createAstrologer());
    const { session } = await request(user, astro, "CHAT");
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(0) });
    return { user, astro, sessionId: session._id };
};

test("the database itself refuses a second live session for an astrologer or a user", async () => {
    const user = await h.createUser();
    const user2 = await h.createUser();
    const astro = await h.createAstrologer();
    const astro2 = await h.createAstrologer();
    const base = { type: "CHAT", callType: "CHAT", status: "PENDING", liveLock: true, perMinuteRate: 9 };

    await Session.create({ ...base, user: user._id, astrologer: astro._id });
    await assert.rejects(Session.create({ ...base, user: user2._id, astrologer: astro._id }), (e) => e.code === 11000);
    await assert.rejects(Session.create({ ...base, user: user._id, astrologer: astro2._id }), (e) => e.code === 11000);

    // finished sessions do not hold the lock, however many there are
    await Session.create({ ...base, status: "COMPLETED", liveLock: false, user: user._id, astrologer: astro2._id });
    await Session.create({ ...base, status: "COMPLETED", liveLock: false, user: user._id, astrologer: astro2._id });
});

test("20 users requesting the same astrologer at the same instant: exactly one wins", async () => {
    const astro = await h.createAstrologer();
    const users = await Promise.all(Array.from({ length: 20 }, () => h.createUser({ walletBalance: 500 })));

    const results = await settled(users.map((u) => request(u, astro)));
    assert.equal(ok(results).length, 1, "exactly one request may succeed");
    for (const r of failed(results)) assert.equal(r.reason.code, "ASTROLOGER_BUSY");
    assert.equal(await Session.countDocuments({ astrologer: astro._id, liveLock: true }), 1);
    assert.equal(await Session.countDocuments({}), 1, "no orphan sessions from the losers");
});

test("one user firing requests at several astrologers at once ends with a single live session", async () => {
    const user = await h.createUser({ walletBalance: 500 });
    const astros = await Promise.all(Array.from({ length: 8 }, () => h.createAstrologer()));

    const results = await settled(astros.map((a) => request(user, a)));
    assert.ok(ok(results).length >= 1);
    for (const r of failed(results)) assert.equal(r.reason.code, "USER_HAS_LIVE_SESSION");
    assert.equal(await Session.countDocuments({ user: user._id, liveLock: true }), 1);
});

test("10 simultaneous accepts of one request produce one transition and one startedAt", async () => {
    const user = await h.createUser({ walletBalance: 500 });
    const astro = await h.createAstrologer();
    const { session } = await request(user, astro);

    const results = await settled(
        Array.from({ length: 10 }, (_, i) =>
            engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(5 + (i % 3)) })
        )
    );
    assert.equal(failed(results).length, 0, "a duplicate accept is answered, not an error");
    const fresh = ok(results).filter((r) => r.value.idempotent === false);
    assert.equal(fresh.length, 1, "exactly one call performed the transition");

    const stored = await Session.findById(session._id).lean();
    assert.equal(stored.status, "ACTIVE");
    for (const r of ok(results)) {
        assert.equal(r.value.session.startedAt.getTime(), stored.startedAt.getTime(), "everyone sees the same startedAt");
    }
    assert.equal(await Session.countDocuments({}), 1);
});

test("accept racing cancel (60 rounds): never both, state and lock always agree", async () => {
    let accepted = 0;
    let cancelled = 0;
    for (let i = 0; i < 60; i += 1) {
        const user = await h.createUser({ walletBalance: 500 });
        const astro = await h.createAstrologer();
        const { session } = await request(user, astro);

        // stagger the cancel by 0-14 ms so both orderings (accept first / cancel first) occur
        const [acc, can] = await Promise.allSettled([
            engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(3) }),
            h.sleep(i % 15).then(() => engine.cancelSession({ sessionId: session._id, actor: h.asUser(user), now: at(3) }))
        ]);
        const s = await Session.findById(session._id).lean();

        if (s.status === "ACTIVE") {
            accepted += 1;
            assert.equal(acc.status, "fulfilled");
            assert.equal(s.liveLock, true);
            assert.ok(can.status === "fulfilled" && can.value.ignored === true, "cancel must not touch an accepted session");
        } else {
            cancelled += 1;
            assert.equal(s.status, "CANCELLED");
            assert.equal(s.liveLock, false);
            assert.equal(acc.status, "rejected", "an accept that lost must not report success");
        }
        assert.equal((await User.findById(user._id)).walletBalance, 500, "nothing was charged");
    }
    console.log(`   accept/cancel race outcomes: ${accepted} accepted, ${cancelled} cancelled`);
    assert.ok(accepted > 0 && cancelled > 0, "the race must exercise both orderings, otherwise it proves nothing");
});

test("an End that races the accept never leaves the session stuck", async () => {
    let endedAfterAccept = 0;
    let cancelledBeforeAccept = 0;
    for (let i = 0; i < 60; i += 1) {
        const user = await h.createUser({ walletBalance: 500 });
        const astro = await h.createAstrologer();
        const { session } = await request(user, astro);

        await Promise.allSettled([
            engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(3) }),
            h.sleep(i % 15).then(() => engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(3) }))
        ]);
        const s = await Session.findById(session._id).lean();
        assert.ok(["CANCELLED", "COMPLETED"].includes(s.status), `stuck in ${s.status}`);
        assert.equal(s.liveLock, false);
        if (s.status === "COMPLETED") endedAfterAccept += 1; else cancelledBeforeAccept += 1;
        assert.equal(s.totalAmountDeducted || 0, 0, "ended within the same instant: nothing to charge");
    }
    console.log(`   end/accept race outcomes: ${endedAfterAccept} ended after accept, ${cancelledBeforeAccept} cancelled before accept`);
});

test("accept racing the scheduler's expiry: exactly one outcome", async () => {
    for (let i = 0; i < 25; i += 1) {
        const user = await h.createUser({ walletBalance: 500 });
        const astro = await h.createAstrologer();
        const { session } = await request(user, astro);

        const [acc] = await Promise.allSettled([
            engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(29) }),
            engine.expirePending({ now: at(31) })
        ]);
        const s = await Session.findById(session._id).lean();
        if (s.status === "ACTIVE") {
            assert.equal(acc.status, "fulfilled");
            assert.equal(s.liveLock, true);
        } else {
            assert.equal(s.status, "MISSED");
            assert.equal(s.liveLock, false);
        }
    }
});

test("both participants media_ready at the same instant: exactly one start (30 rounds)", async () => {
    for (let i = 0; i < 30; i += 1) {
        const user = await h.createUser({ walletBalance: 500 });
        const astro = await h.createAstrologer();
        const { session } = await request(user, astro, "VIDEO", { protocol: 2 });
        await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), protocol: 2, now: at(1) });

        const results = await settled([
            engine.markMediaReady({ sessionId: session._id, actor: h.asUser(user), now: at(4) }),
            engine.markMediaReady({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(4) })
        ]);
        assert.equal(failed(results).length, 0);
        assert.equal(ok(results).filter((r) => r.value.started === true).length, 1, "only one caller reports the start");
        const s = await Session.findById(session._id).lean();
        assert.equal(s.status, "ACTIVE");
        assert.equal(s.startedAt.getTime(), at(4).getTime());
    }
});

test("simultaneous End from user, astrologer and system settles exactly once", async () => {
    const admin = await h.createAdmin();
    const { user, astro, sessionId } = await activeSession({ balance: 500 });

    const results = await settled([
        ...Array.from({ length: 4 }, () => engine.endSession({ sessionId, actor: h.asUser(user), now: at(120) })),
        ...Array.from({ length: 4 }, () => engine.endSession({ sessionId, actor: h.asAstrologer(astro), now: at(120) })),
        ...Array.from({ length: 4 }, () => engine.endSession({ sessionId, actor: h.SYSTEM, reason: "x", now: at(120) }))
    ]);

    assert.equal(failed(results).length, 0);
    assert.equal(ok(results).filter((r) => r.value.idempotent === false).length, 1, "one caller performed the End");
    for (const r of ok(results)) {
        assert.equal(r.value.session.status, "COMPLETED", "every caller receives the finished result");
        assert.equal(r.value.session.totalAmountDeducted, 18, "120s at ₹9/min");
    }

    // ₹18 total: user -18, astrologer +10.80 (60%), platform +7.20 (40%), one ledger row
    assert.equal((await User.findById(user._id)).walletBalance, 482);
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 10.8);
    assert.equal((await Admin.findById(admin._id)).walletBalance, 7.2);
    assert.equal(await WalletTransaction.countDocuments({ sessionId }), 1);
    const ledger = await WalletTransaction.findOne({ sessionId }).lean();
    assert.equal(ledger.userBalanceBefore, 500, "ledger audit values are exact even under a race");
    assert.equal(ledger.userBalanceAfter, 482);
});

test("settlement run 12 times concurrently moves money once", async () => {
    const admin = await h.createAdmin();
    const { user, astro, sessionId } = await activeSession({ balance: 500 });
    // put the session in ENDING without settling, as if the process died right after the transition
    await Session.updateOne(
        { _id: sessionId },
        { $set: { status: "ENDING", endedAt: at(60), endTime: at(60), endedBy: "USER", "settlement.state": "IN_PROGRESS" } }
    );

    const results = await settled(Array.from({ length: 12 }, () => settlement.settleSession(sessionId, { now: at(61) })));
    assert.equal(failed(results).length, 0);
    for (const r of ok(results)) assert.equal(r.value.status, "COMPLETED");

    assert.equal((await User.findById(user._id)).walletBalance, 491);
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 5.4);
    assert.equal((await Admin.findById(admin._id)).walletBalance, 3.6);
    assert.equal(await WalletTransaction.countDocuments({ sessionId }), 1);
    assert.equal((await Session.findById(sessionId).lean()).status, "COMPLETED");
});

test("a crash in the middle of settlement is repaired by running settlement again, with no double movement", async () => {
    const admin = await h.createAdmin();
    const { user, astro, sessionId } = await activeSession({ balance: 500 });

    // The astrologer credit fails once (e.g. the process dies right after debiting the user)
    const realUpdateOne = Astrologer.updateOne;
    let armed = true;
    Astrologer.updateOne = function (...args) {
        if (armed) {
            armed = false;
            return Promise.reject(new Error("simulated crash during settlement"));
        }
        return realUpdateOne.apply(this, args);
    };

    let first;
    try {
        first = await engine.endSession({ sessionId, actor: h.asUser(user), now: at(60) });
    } finally {
        Astrologer.updateOne = realUpdateOne;
    }

    assert.equal(first.session.status, "ENDING", "the session stays ENDING until every leg is applied");
    assert.equal((await User.findById(user._id)).walletBalance, 491, "user leg was applied before the crash");
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 0);
    assert.equal(await WalletTransaction.countDocuments({ sessionId }), 0);

    // recovery: settle again (as the scheduler does)
    const repaired = await settlement.settleSession(sessionId, { now: at(90) });
    assert.equal(repaired.status, "COMPLETED");
    assert.equal((await User.findById(user._id)).walletBalance, 491, "the user is NOT debited a second time");
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 5.4);
    assert.equal((await Admin.findById(admin._id)).walletBalance, 3.6);
    assert.equal(await WalletTransaction.countDocuments({ sessionId }), 1);

    // and again: still nothing moves
    await settlement.settleSession(sessionId, { now: at(120) });
    assert.equal((await User.findById(user._id)).walletBalance, 491);
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 5.4);
});

test("a crash after a leg is applied but before it is recorded cannot double-credit", async () => {
    const admin = await h.createAdmin();
    const { user, astro, sessionId } = await activeSession({ balance: 500 });

    // Fail the bookkeeping write that follows the astrologer credit, once.
    const realUpdateOne = Session.updateOne;
    let armed = true;
    Session.updateOne = function (filter, update, ...rest) {
        if (armed && update && update.$set && update.$set["settlement.legs.astrologer"] === true) {
            armed = false;
            return Promise.reject(new Error("simulated crash after crediting the astrologer"));
        }
        return realUpdateOne.call(this, filter, update, ...rest);
    };
    try {
        await engine.endSession({ sessionId, actor: h.asUser(user), now: at(60) });
    } finally {
        Session.updateOne = realUpdateOne;
    }
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 5.4, "credit was applied");
    assert.equal((await Session.findById(sessionId).lean()).status, "ENDING");

    await settlement.settleSession(sessionId, { now: at(90) }); // leg flag was never recorded; re-applies are no-ops
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 5.4, "not credited twice");
    assert.equal((await User.findById(user._id)).walletBalance, 491);
    assert.equal((await Admin.findById(admin._id)).walletBalance, 3.6);
    assert.equal(await WalletTransaction.countDocuments({ sessionId }), 1);
    assert.equal((await Session.findById(sessionId).lean()).status, "COMPLETED");
});

test("many sessions completing in parallel conserve money exactly", async () => {
    const admin = await h.createAdmin();
    const N = 30;
    const startBalance = 1000;

    const sessions = [];
    for (let i = 0; i < N; i += 1) {
        const user = await h.createUser({ walletBalance: startBalance });
        const astro = await h.createAstrologer({ consultationFee: 12 });
        const { session } = await request(user, astro, i % 2 ? "VIDEO" : "AUDIO", { protocol: 2 });
        await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), protocol: 2, now: at(0) });
        await engine.markMediaReady({ sessionId: session._id, actor: h.asUser(user), now: at(1) });
        await engine.markMediaReady({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(2) });
        sessions.push({ user, astro, id: session._id, seconds: 30 + i * 5 });
    }

    // each session is ended by BOTH sides at once, all sessions in parallel
    const ends = [];
    for (const s of sessions) {
        ends.push(engine.endSession({ sessionId: s.id, actor: h.asUser(s.user), now: at(2 + s.seconds) }));
        ends.push(engine.endSession({ sessionId: s.id, actor: h.asAstrologer(s.astro), now: at(2 + s.seconds) }));
    }
    const results = await settled(ends);
    assert.equal(failed(results).length, 0);

    assert.equal(await Session.countDocuments({ status: "COMPLETED" }), N);
    assert.equal(await Session.countDocuments({ liveLock: true }), 0, "every lock released");
    assert.equal(await WalletTransaction.countDocuments({}), N, "one ledger row per session");

    let userDebits = 0;
    for (const s of sessions) {
        userDebits += startBalance - (await User.findById(s.user._id)).walletBalance;
        const stored = await Session.findById(s.id).lean();
        assert.equal(stored.totalDurationSeconds, s.seconds, "duration is endedAt - startedAt from the server");
    }
    let credits = (await Admin.findById(admin._id)).walletBalance;
    for (const s of sessions) credits += (await Astrologer.findById(s.astro._id)).walletBalance;
    assert.ok(Math.abs(userDebits - credits) < 1e-6, `money must be conserved: debited ${userDebits}, credited ${credits}`);
    assert.ok(userDebits > 0);
});
