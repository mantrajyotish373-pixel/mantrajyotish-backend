/**
 * Phase 5: billing and settlement reuse the application's EXISTING rules.
 * These tests pin the engine to the legacy formulas (sessionBilling.service.calculateSessionBilling)
 * and the legacy wallet semantics, so the pricing project can later change only rules.resolveRate().
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/harness");

let mongo;
let engine;
let legacyBilling;
let Session;
let User;
let Astrologer;
let Admin;
let WalletTransaction;
let background;

const T0 = new Date(Date.now() - 3600000);
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);

before(async () => {
    mongo = await h.startMongo();
    engine = require("../src/services/session/engine");
    legacyBilling = require("../src/services/sessionBilling.service");
    background = require("../src/services/session/background");
    Session = require("../src/models/session.model");
    User = require("../src/models/user.model");
    Astrologer = require("../src/models/astro.model");
    Admin = require("../src/models/admin.model");
    WalletTransaction = require("../src/models/walletTransaction.model");
    await h.syncAllIndexes();
});

after(async () => {
    await background.flushBackground();
    await mongo.stop();
});

beforeEach(async () => {
    await background.flushBackground();
    await h.resetData();
});

const run = async ({ balance = 100000, fee = 12, type = "CHAT", seconds, createAdmin = true, userId, astro: existingAstro }) => {
    const user = userId ? await User.findById(userId) : await h.createUser({ walletBalance: balance });
    const astro = existingAstro || (await h.createAstrologer({ consultationFee: fee }));
    if (createAdmin && !(await Admin.findOne())) await h.createAdmin();
    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type, now: T0 });
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: T0 });
    const end = await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(seconds) });
    return { user, astro, session: end.session };
};

test("engine billing equals the legacy calculateSessionBilling for a spread of rates and durations", async () => {
    const cases = [];
    for (const [type, fee] of [["CHAT", 12], ["AUDIO", 12], ["VIDEO", 25], ["AUDIO", 40], ["VIDEO", 7]]) {
        for (const seconds of [0, 1, 7, 59, 60, 61, 125, 599, 3599]) cases.push({ type, fee, seconds });
    }
    for (const c of cases) {
        await h.resetData();
        const { session } = await run({ ...c });
        const expected = legacyBilling.calculateSessionBilling(c.seconds, session.perMinuteRate, 0);
        const label = `${c.type} ₹${session.perMinuteRate}/min for ${c.seconds}s`;
        assert.equal(session.status, "COMPLETED", label);
        assert.equal(session.totalDurationSeconds, expected.billableSeconds, label);
        assert.equal(session.totalDurationMinutes, expected.totalDurationMinutes, label);
        assert.equal(session.totalAmountDeducted, expected.totalCost, label);
        assert.equal(session.astrologerEarnings, expected.astrologerEarnings, label);
        assert.equal(session.platformFee, expected.platformFee, label);
        assert.ok(Math.abs(session.astrologerEarnings + session.platformFee - session.totalAmountDeducted) < 1e-9, `${label}: the 60/40 split adds up to the price`);
    }
});

test("rates come from today's rules: chat flat ₹9, calls the astrologer's consultationFee", async () => {
    const chat = await run({ type: "CHAT", fee: 40, seconds: 60 });
    assert.equal(chat.session.perMinuteRate, 9);
    assert.equal(chat.session.totalAmountDeducted, 9);
    await h.resetData();
    const video = await run({ type: "VIDEO", fee: 40, seconds: 60 });
    assert.equal(video.session.perMinuteRate, 40);
    assert.equal(video.session.totalAmountDeducted, 40);
});

test("legacy wallet semantics: the user is debited down to zero, the astrologer and platform still get their full share", async () => {
    // ended late, past what the wallet could pay (maxEndAt cleared), exactly as a late legacy timer could
    const user = await h.createUser({ walletBalance: 500 });
    const astro = await h.createAstrologer();
    await h.createAdmin();
    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "CHAT", now: T0 });
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: T0 });
    // the wallet was spent elsewhere during the session
    await User.updateOne({ _id: user._id }, { $set: { walletBalance: 5 } });
    await Session.updateOne({ _id: session._id }, { $set: { maxEndAt: null } });

    const end = await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(125) }); // cost 18.75
    assert.equal(end.session.totalAmountDeducted, 18.75);
    assert.equal((await User.findById(user._id)).walletBalance, 0, "never negative");
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 11.25);
    assert.equal((await Admin.findOne()).walletBalance, 7.5);
    const ledger = await WalletTransaction.findOne({ sessionId: session._id }).lean();
    assert.equal(ledger.amountDeducted, 18.75, "the ledger records the price, as before");
    assert.equal(ledger.userBalanceBefore, 5);
    assert.equal(ledger.userBalanceAfter, 0);
});

test("with no admin account the platform fee is still collected, once, in a single account", async () => {
    await run({ seconds: 120, createAdmin: false });
    assert.equal(await Admin.countDocuments({}), 1);
    assert.equal((await Admin.findOne()).walletBalance, 7.2);

    // a second settlement adds to the same account instead of creating another
    await run({ seconds: 60, createAdmin: false });
    assert.equal(await Admin.countDocuments({}), 1);
    assert.ok(Math.abs((await Admin.findOne()).walletBalance - (7.2 + 3.6)) < 1e-9);
});

test("billing pause excludes the paused time (existing recharge rule)", async () => {
    const user = await h.createUser({ walletBalance: 5000 });
    const astro = await h.createAstrologer();
    await h.createAdmin();
    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "CHAT", now: T0 });
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: T0 });

    await engine.pauseBilling({ sessionId: session._id, actor: h.asUser(user), now: at(60) });
    const paused = await Session.findById(session._id).lean();
    assert.equal(paused.pauseDeadline.getTime(), at(60 + 120).getTime(), "2 minute limit, stored as a deadline");

    await User.updateOne({ _id: user._id }, { $set: { walletBalance: 8000 } }); // recharged while paused
    const resumed = await engine.resumeBilling({ sessionId: session._id, actor: h.asUser(user), now: at(90) });
    assert.equal(resumed.session.startedAt.getTime(), at(30).getTime(), "startedAt shifted by the 30s pause");
    assert.equal(resumed.session.originalStartedAt.getTime(), T0.getTime(), "true start kept for history");
    assert.equal(resumed.session.balanceAtStart, 8000, "the limit is recomputed from the recharged balance");
    // floor(8000 / (9/60)) seconds after the shifted start
    assert.equal(resumed.session.maxEndAt.getTime(), at(30 + 53333).getTime());

    const end = await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(120) });
    assert.equal(end.session.settlement.billing.rawSeconds, 90, "120s on the wall clock minus the 30s paused");
    assert.equal(end.session.totalAmountDeducted, 13.5);
});

test("the final result a client shows equals what was stored and settled", async () => {
    const realtime = require("../src/services/session/realtime");
    const { user, astro, session } = await run({ type: "VIDEO", fee: 25, seconds: 185 });
    const u = realtime.finalResult(session, "USER");
    const a = realtime.finalResult(session, "ASTROLOGER");

    const stored = await Session.findById(session._id).lean();
    assert.equal(u.totalCost, stored.totalAmountDeducted);
    assert.equal(a.totalCost, stored.totalAmountDeducted);
    assert.equal(u.durationSeconds, 185);
    assert.equal(a.durationSeconds, 185);
    assert.equal(u.perMinuteRate, 25);
    assert.equal(a.earnings, stored.astrologerEarnings);
    assert.equal(a.platformFee, stored.platformFee);
    assert.equal(u.walletBalanceAfter, (await User.findById(user._id)).walletBalance);
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, a.earnings);
    assert.equal(u.status, "COMPLETED");
    assert.equal(u.endedBy, "USER");
});

test("wallet idempotency markers stay bounded however many sessions a wallet has settled", async () => {
    const user = await h.createUser({ walletBalance: 1000000 });
    const astro = await h.createAstrologer();
    await h.createAdmin();
    for (let i = 0; i < 205; i += 1) {
        await run({ userId: user._id, astro, seconds: 6, createAdmin: false });
    }
    const u = await User.findById(user._id).select("+settledSessions walletBalance").lean();
    const a = await Astrologer.findById(astro._id).select("+settledSessions walletBalance").lean();
    assert.equal(u.settledSessions.length, 200, "capped at the most recent 200");
    assert.equal(a.settledSessions.length, 200);
    assert.equal(await WalletTransaction.countDocuments({}), 205, "the ledger keeps every settlement");
    // 205 sessions x ₹0.90 (6s at ₹9/min)
    assert.ok(Math.abs(1000000 - u.walletBalance - 205 * 0.9) < 1e-6);
});
