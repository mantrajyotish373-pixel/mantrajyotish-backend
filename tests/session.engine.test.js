/**
 * Phase 1: the Session Engine lifecycle, against a real (standalone) MongoDB.
 * Time is controlled through the engine's `now` option; there are no timers to wait for.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/harness");

let mongo;
let engine;
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

const setup = async ({ balance = 500, fee = 12, astroOverrides = {} } = {}) => {
    const user = await h.createUser({ walletBalance: balance });
    const astro = await h.createAstrologer({ consultationFee: fee, ...astroOverrides });
    await h.createAdmin();
    return { user, astro };
};

const request = (user, astro, type = "CHAT", extra = {}) =>
    engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type, now: T0, ...extra });

const sessionOf = (id) => Session.findById(id).lean();

test("request creates a PENDING session that locks the astrologer, with a 30s server deadline", async () => {
    const { user, astro } = await setup();
    const { session } = await request(user, astro, "CHAT");

    assert.equal(session.status, "PENDING");
    assert.equal(session.liveLock, true);
    assert.equal(session.perMinuteRate, 9, "chat keeps today's flat ₹9/min");
    assert.equal(session.expiresAt.getTime() - session.requestedAt.getTime(), 30000);
    assert.equal(session.startedAt, null, "nothing has started yet");

    await mirror.flushMirrors();
    const a = await Astrologer.findById(astro._id).lean();
    assert.equal(a.isAvailable, false, "a pending request occupies the astrologer");
});

test("calls use the astrologer's existing consultationFee", async () => {
    const { user, astro } = await setup({ fee: 25 });
    const { session } = await request(user, astro, "VIDEO");
    assert.equal(session.perMinuteRate, 25);
    assert.equal(session.type, "VIDEO");
    assert.ok(session.channelName && session.roomId);
});

test("a second user cannot request an astrologer who already has a pending or active session", async () => {
    const { user, astro } = await setup();
    const other = await h.createUser({ walletBalance: 900 });
    await request(user, astro);
    await assert.rejects(request(other, astro), (e) => e.code === "ASTROLOGER_BUSY");
    assert.equal(await Session.countDocuments({ astrologer: astro._id, liveLock: true }), 1);
});

test("request validation: offline, unapproved, unavailable, unknown astrologer, low balance", async () => {
    const user = await h.createUser({ walletBalance: 500 });
    const offline = await h.createAstrologer({ isOnline: false });
    const pending = await h.createAstrologer({ status: "pending" });
    await assert.rejects(request(user, offline), (e) => e.code === "ASTROLOGER_OFFLINE");
    await assert.rejects(request(user, pending), (e) => e.code === "ASTROLOGER_NOT_APPROVED");
    await assert.rejects(
        engine.requestSession({ userId: String(user._id), astrologerId: String(new (require("mongoose").Types.ObjectId)()), type: "CHAT" }),
        (e) => e.code === "ASTROLOGER_NOT_FOUND"
    );

    const poor = await h.createUser({ walletBalance: 17 }); // minimum is 2 minutes = 18
    const ok = await h.createAstrologer();
    await assert.rejects(request(poor, ok), (e) => e.code === "INSUFFICIENT_BALANCE" && /Minimum ₹18 \(2 mins\)/.test(e.message));
    assert.equal(await Session.countDocuments({}), 0, "failed requests create nothing");
});

test("repeating the same request returns the pending session instead of duplicating it", async () => {
    const { user, astro } = await setup();
    const first = await request(user, astro);
    const again = await request(user, astro);
    assert.equal(again.idempotent, true);
    assert.equal(String(again.session._id), String(first.session._id));
    assert.equal(await Session.countDocuments({}), 1);
});

test("a user's earlier PENDING request is superseded by a new one, never an ACTIVE session", async () => {
    const { user, astro } = await setup();
    const astro2 = await h.createAstrologer();
    const first = await request(user, astro);
    const second = await request(user, astro2);
    assert.equal(second.superseded.length, 1);
    assert.equal((await sessionOf(first.session._id)).status, "CANCELLED");
    assert.equal((await sessionOf(first.session._id)).liveLock, false);

    // accept the second, then the user tries yet another request: ACTIVE must be untouched
    await engine.acceptSession({ sessionId: second.session._id, actor: h.asAstrologer(astro2), now: at(5) });
    const astro3 = await h.createAstrologer();
    await assert.rejects(request(user, astro3, "CHAT", { now: at(6) }), (e) => e.code === "USER_HAS_LIVE_SESSION");
    assert.equal((await sessionOf(second.session._id)).status, "ACTIVE");
});

test("CHAT: accept starts the session at the server's atomic accept time", async () => {
    const { user, astro } = await setup({ balance: 500 });
    const { session } = await request(user, astro, "CHAT");
    const res = await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(7) });

    assert.equal(res.started, true);
    assert.equal(res.session.status, "ACTIVE");
    assert.equal(res.session.startedAt.getTime(), at(7).getTime(), "startedAt is the server accept time");
    assert.equal(res.session.startTime.getTime(), at(7).getTime());
    assert.equal(res.session.balanceAtStart, 500);
    // existing max-duration rule: floor(500 / (9/60)) = 3333s of balance
    assert.equal(res.session.maxEndAt.getTime(), at(7 + 3333).getTime());
});

test("accept is restricted to the requested astrologer", async () => {
    const { user, astro } = await setup();
    const stranger = await h.createAstrologer();
    const { session } = await request(user, astro);
    await assert.rejects(engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(stranger), now: at(1) }), (e) => e.code === "FORBIDDEN");
    await assert.rejects(engine.acceptSession({ sessionId: session._id, actor: h.asUser(user), now: at(1) }), (e) => e.code === "FORBIDDEN");
    assert.equal((await sessionOf(session._id)).status, "PENDING");
});

test("accept refuses (and frees the astrologer) when the user is no longer connected", async () => {
    const { user, astro } = await setup();
    const { session } = await request(user, astro);
    await assert.rejects(
        engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), isUserConnected: async () => false, now: at(3) }),
        (e) => e.code === "USER_UNAVAILABLE"
    );
    const s = await sessionOf(session._id);
    assert.equal(s.status, "CANCELLED");
    assert.equal(s.endReason, "USER_UNAVAILABLE");
    assert.equal(s.liveLock, false);
    await mirror.flushMirrors();
    // and the astrologer can be requested again
    const other = await h.createUser({ walletBalance: 500 });
    await request(other, astro, "CHAT", { now: at(4) });
});

test("accept re-verifies the wallet at accept time", async () => {
    const { user, astro } = await setup({ balance: 500 });
    const { session } = await request(user, astro);
    await User.updateOne({ _id: user._id }, { $set: { walletBalance: 5 } }); // spent elsewhere meanwhile
    await assert.rejects(
        engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(2) }),
        (e) => e.code === "INSUFFICIENT_BALANCE"
    );
    const s = await sessionOf(session._id);
    assert.equal(s.status, "CANCELLED");
    assert.equal(s.liveLock, false);
});

test("an accept after the 30s deadline loses to expiry, even before the scheduler runs", async () => {
    const { user, astro } = await setup();
    const { session } = await request(user, astro);
    await assert.rejects(
        engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(30) }),
        (e) => e.code === "REQUEST_EXPIRED"
    );
    const s = await sessionOf(session._id);
    assert.equal(s.status, "MISSED");
    assert.equal(s.liveLock, false);
});

test("expirePending: not expired at +29s, MISSED at +30s, lock released", async () => {
    const { user, astro } = await setup();
    const { session } = await request(user, astro);
    assert.equal((await engine.expirePending({ now: at(29) })).length, 0);
    const expired = await engine.expirePending({ now: at(30) });
    assert.equal(expired.length, 1);
    assert.equal(expired[0].status, "MISSED");
    assert.equal((await sessionOf(session._id)).liveLock, false);
    assert.equal((await engine.expirePending({ now: at(31) })).length, 0, "expiry is not repeated");
});

test("reject releases the astrologer; duplicate reject is idempotent", async () => {
    const { user, astro } = await setup();
    const { session } = await request(user, astro);
    const r1 = await engine.rejectSession({ sessionId: session._id, actor: h.asAstrologer(astro), reason: "busy", now: at(2) });
    const r2 = await engine.rejectSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(3) });
    assert.equal(r1.session.status, "REJECTED");
    assert.equal(r2.idempotent, true);
    assert.equal((await sessionOf(session._id)).liveLock, false);
    await assert.rejects(engine.rejectSession({ sessionId: session._id, actor: h.asUser(user) }), (e) => e.code === "FORBIDDEN");
});

test("cancel: user cancels a pending request; the astrologer cannot; cancelling ACTIVE is ignored", async () => {
    const { user, astro } = await setup();
    const { session } = await request(user, astro);
    await assert.rejects(engine.cancelSession({ sessionId: session._id, actor: h.asAstrologer(astro) }), (e) => e.code === "FORBIDDEN");
    const c = await engine.cancelSession({ sessionId: session._id, actor: h.asUser(user), now: at(2) });
    assert.equal(c.session.status, "CANCELLED");
    assert.equal((await engine.cancelSession({ sessionId: session._id, actor: h.asUser(user) })).idempotent, true);

    const { session: s2 } = await request(user, astro, "CHAT", { now: at(10) });
    await engine.acceptSession({ sessionId: s2._id, actor: h.asAstrologer(astro), now: at(11) });
    const ignored = await engine.cancelSession({ sessionId: s2._id, actor: h.asUser(user), now: at(12) });
    assert.equal(ignored.ignored, true);
    assert.equal((await sessionOf(s2._id)).status, "ACTIVE", "an active session is ended, never cancelled");
});

// ---------------------------------------------------------------- audio / video

test("AUDIO/VIDEO: accept -> CONNECTING; billing starts only when the SECOND participant is ready", async () => {
    const { user, astro } = await setup({ balance: 500, fee: 12 });
    const { session } = await request(user, astro, "VIDEO", { protocol: 2 });
    const acc = await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), protocol: 2, now: at(5) });

    assert.equal(acc.session.status, "CONNECTING");
    assert.equal(acc.started, false);
    assert.equal(acc.session.startedAt, null, "no billing clock yet");
    assert.equal(acc.session.connectDeadline.getTime(), at(25).getTime(), "20 second connection deadline");
    assert.equal(acc.session.liveLock, true);

    const first = await engine.markMediaReady({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(8) });
    assert.equal(first.started, false);
    assert.equal(first.session.status, "CONNECTING");

    const second = await engine.markMediaReady({ sessionId: session._id, actor: h.asUser(user), now: at(11) });
    assert.equal(second.started, true);
    assert.equal(second.session.status, "ACTIVE");
    assert.equal(second.session.startedAt.getTime(), at(11).getTime(), "startedAt = the moment the second participant was ready");
    // existing rule: floor(500 / (12/60)) = 2500s
    assert.equal(second.session.maxEndAt.getTime(), at(11 + 2500).getTime());

    // duplicate media_ready after start changes nothing
    const dup = await engine.markMediaReady({ sessionId: session._id, actor: h.asUser(user), now: at(15) });
    assert.equal(dup.started, false);
    assert.equal((await sessionOf(session._id)).startedAt.getTime(), at(11).getTime());
});

test("a participant whose client predates media_ready counts as ready at accept (legacy compatibility)", async () => {
    const { user, astro } = await setup();
    // legacy user (protocol 1) + new astrologer (protocol 2): waits only for the astrologer
    const { session } = await request(user, astro, "AUDIO", { protocol: 1 });
    const acc = await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), protocol: 2, now: at(5) });
    assert.equal(acc.session.status, "CONNECTING");
    assert.equal(acc.session.mediaReady.user.getTime(), at(5).getTime());
    const r = await engine.markMediaReady({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(9) });
    assert.equal(r.started, true);
    assert.equal(r.session.startedAt.getTime(), at(9).getTime());

    // both legacy: behaves exactly as before, ACTIVE at accept
    await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(20) });
    const { session: s2 } = await request(user, astro, "AUDIO", { protocol: 1, now: at(30) });
    const acc2 = await engine.acceptSession({ sessionId: s2._id, actor: h.asAstrologer(astro), protocol: 1, now: at(31) });
    assert.equal(acc2.session.status, "ACTIVE");
    assert.equal(acc2.session.startedAt.getTime(), at(31).getTime());
});

test("a call that never connects is CANCELLED at the 20s deadline with zero charge", async () => {
    const { user, astro } = await setup({ balance: 500 });
    const { session } = await request(user, astro, "VIDEO", { protocol: 2 });
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), protocol: 2, now: at(5) });
    await engine.markMediaReady({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(8) }); // only one side

    assert.equal((await engine.expireConnecting({ now: at(24) })).length, 0);
    const failed = await engine.expireConnecting({ now: at(25) });
    assert.equal(failed.length, 1);

    const s = await sessionOf(session._id);
    assert.equal(s.status, "CANCELLED");
    assert.equal(s.endReason, "MEDIA_CONNECT_FAILED");
    assert.equal(s.liveLock, false);
    assert.equal(s.totalAmountDeducted, 0);
    assert.equal((await User.findById(user._id)).walletBalance, 500, "user not charged");
    assert.equal(await WalletTransaction.countDocuments({}), 0);

    // a late media_ready cannot resurrect it
    await assert.rejects(engine.markMediaReady({ sessionId: session._id, actor: h.asUser(user), now: at(26) }), (e) => e.code === "INVALID_STATE");
});

test("ending while still CONNECTING cancels without charge", async () => {
    const { user, astro } = await setup({ balance: 500 });
    const { session } = await request(user, astro, "AUDIO", { protocol: 2 });
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), protocol: 2, now: at(5) });
    const r = await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(9) });
    assert.equal(r.session.status, "CANCELLED");
    assert.equal(r.session.endedBy, "USER");
    assert.equal((await User.findById(user._id)).walletBalance, 500);
});

// ---------------------------------------------------------------- end + settlement

test("END settles with the existing per-second 60/40 rules and releases everything", async () => {
    const { user, astro } = await setup({ balance: 500 });
    const admin = await Admin.findOne();
    const { session } = await request(user, astro, "CHAT");
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(0) });

    const end = await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(125) });
    const s = end.session;

    // 125s * ₹9/min = ₹18.75 ; astrologer 60% = 11.25 ; platform 40% = 7.50
    assert.equal(s.status, "COMPLETED");
    assert.equal(s.totalDurationSeconds, 125);
    assert.equal(s.totalAmountDeducted, 18.75);
    assert.equal(s.astrologerEarnings, 11.25);
    assert.equal(s.platformFee, 7.5);
    assert.equal(s.endedBy, "USER");
    assert.equal(s.liveLock, false);
    assert.equal(s.billingSettled, true);
    assert.equal(s.endedAt.getTime(), at(125).getTime());

    assert.equal((await User.findById(user._id)).walletBalance, 481.25);
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 11.25);
    assert.equal((await Admin.findById(admin._id)).walletBalance, 7.5);

    const ledger = await WalletTransaction.find({ sessionId: session._id }).lean();
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amountDeducted, 18.75);
    assert.equal(ledger[0].userBalanceBefore, 500);
    assert.equal(ledger[0].userBalanceAfter, 481.25);

    await mirror.flushMirrors();
    assert.equal((await Astrologer.findById(astro._id)).isAvailable, true, "astrologer is free again");
    // the same astrologer can be requested again immediately
    const next = await h.createUser({ walletBalance: 100 });
    await request(next, astro, "CHAT", { now: at(130) });
});

test("the end is capped at maxEndAt so the user is never billed beyond their wallet (existing rule)", async () => {
    const { user, astro } = await setup({ balance: 20 });
    const { session } = await request(user, astro, "CHAT");
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(0) });
    // wallet 20 at ₹9/min => floor(20 / 0.15) = 133s ; the scheduler is late and ends at +600s
    const end = await engine.endSession({ sessionId: session._id, actor: h.SYSTEM, reason: "INSUFFICIENT_BALANCE", now: at(600) });
    assert.equal(end.session.endedAt.getTime(), at(133).getTime());
    assert.equal(end.session.totalDurationSeconds, 133);
    assert.equal(end.session.totalAmountDeducted, 19.95);
    assert.ok(Math.abs((await User.findById(user._id)).walletBalance - 0.05) < 1e-9, "wallet is debited down to what it held (double-precision arithmetic, as before)");
});

test("duplicate End returns the same final result and settles exactly once", async () => {
    const { user, astro } = await setup({ balance: 500 });
    const { session } = await request(user, astro, "CHAT");
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(0) });

    const a = await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(60) });
    const b = await engine.endSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(61) });
    assert.equal(a.idempotent, false);
    assert.equal(b.idempotent, true);
    assert.equal(a.session.totalAmountDeducted, b.session.totalAmountDeducted);
    assert.equal(b.session.endedAt.getTime(), at(60).getTime(), "the first End decides endedAt");
    assert.equal((await User.findById(user._id)).walletBalance, 491);
    assert.equal(await WalletTransaction.countDocuments({}), 1);
});

test("a stranger cannot end someone else's session", async () => {
    const { user, astro } = await setup();
    const { session } = await request(user, astro);
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(0) });
    const stranger = await h.createUser();
    await assert.rejects(engine.endSession({ sessionId: session._id, actor: h.asUser(stranger), now: at(5) }), (e) => e.code === "FORBIDDEN");
    assert.equal((await sessionOf(session._id)).status, "ACTIVE");
});

test("zero-length session is completed with no wallet movement and no ledger row", async () => {
    const { user, astro } = await setup({ balance: 500 });
    const { session } = await request(user, astro, "CHAT");
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(0) });
    const end = await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(0) });
    assert.equal(end.session.status, "COMPLETED");
    assert.equal(end.session.billingSettlementStatus, "ZERO_AMOUNT");
    assert.equal((await User.findById(user._id)).walletBalance, 500);
    assert.equal(await WalletTransaction.countDocuments({}), 0);
});

test("legacy ChatSession / VideoSession mirrors follow the unified session", async () => {
    const ChatSession = require("../src/models/chatSession.model");
    const VideoSession = require("../src/models/videoSession.model");
    const { user, astro } = await setup({ balance: 500 });

    const chat = await request(user, astro, "CHAT");
    await engine.acceptSession({ sessionId: chat.session._id, actor: h.asAstrologer(astro), now: at(0) });
    await engine.endSession({ sessionId: chat.session._id, actor: h.asUser(user), now: at(60) });
    await mirror.flushMirrors();
    const c = await ChatSession.findById(chat.session._id).lean();
    assert.equal(c.status, "COMPLETED");
    assert.equal(c.totalAmountDeducted, 9);
    assert.equal(c.sessionCode, chat.session.sessionCode);

    const call = await request(user, astro, "AUDIO", { now: at(100) });
    await engine.acceptSession({ sessionId: call.session._id, actor: h.asAstrologer(astro), now: at(101) });
    await mirror.flushMirrors();
    const v = await VideoSession.findById(call.session._id).lean();
    assert.equal(v.status, "ACTIVE");
    assert.equal(v.callType, "AUDIO");
});
