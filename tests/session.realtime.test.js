/**
 * Phase 3: the Session Engine over real Socket.IO and REST, against a real MongoDB.
 * Covers the new session:* protocol, the legacy event names (unchanged clients), the
 * scheduler's stored deadlines, and isolation between users.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/harness");

let mongo;
let rt;
let scheduler;
let Session;
let User;
let Astrologer;
let Admin;
let WalletTransaction;
let background;

const V2 = { sessionProtocol: 2 };
const now = () => new Date();
const plus = (seconds) => new Date(Date.now() + seconds * 1000);

before(async () => {
    mongo = await h.startMongo();
    rt = await h.startRealtime();
    scheduler = require("../src/services/session/scheduler");
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
    await rt.stop();
    await mongo.stop();
});

beforeEach(async () => {
    await background.flushBackground();
    await h.resetData();
});

/** user + astrologer, each connected with a socket of the given protocol */
const world = async ({ balance = 500, fee = 12, userAuth = V2, astroAuth = V2, astroOverrides = {} } = {}) => {
    const user = await h.createUser({ walletBalance: balance });
    const astro = await h.createAstrologer({ consultationFee: fee, ...astroOverrides });
    const admin = await h.createAdmin();
    const userSock = await rt.connect(h.tokenFor(user, "user"), userAuth);
    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"), astroAuth);
    await h.sleep(100); // let the server finish joining personal rooms
    return { user, astro, admin, userSock, astroSock };
};

const requestV2 = (w, type = "CHAT") => w.userSock.emitAck("session:request", { astrologerId: String(w.astro._id), type });

// ---------------------------------------------------------------- new protocol: chat

test("v2 CHAT: request -> incoming -> accept -> both get the same startedAt -> end -> same final result", async () => {
    const w = await world({ balance: 500 });

    const req = await requestV2(w, "CHAT");
    assert.equal(req.ok, true);
    assert.equal(req.session.status, "PENDING");
    const sessionId = req.session.sessionId;

    const incoming = await w.astroSock.waitFor("session:incoming");
    assert.equal(String(incoming.sessionId), sessionId);
    assert.ok(incoming.expiresAt, "the request carries the server deadline");
    assert.equal(new Date(incoming.expiresAt) - new Date(req.session.requestedAt), 30000, "exactly 30 seconds");

    const acc = await w.astroSock.emitAck("session:accept", { sessionId });
    assert.equal(acc.ok, true);
    assert.equal(acc.session.status, "ACTIVE");

    const userStarted = await w.userSock.waitFor("session:started");
    const astroStarted = await w.astroSock.waitFor("session:started");
    assert.equal(userStarted.startedAt, astroStarted.startedAt, "both participants get the SAME server startedAt");
    assert.equal(userStarted.startedAt, acc.session.startedAt);
    assert.ok(userStarted.serverNow, "serverNow lets each client derive its clock offset");
    assert.equal(w.userSock.has("session:accepted"), true);
    assert.equal(w.astroSock.has("session:accepted"), true);

    // wind the start time back so the End bills a known duration (server-owned timestamps)
    const back = new Date(Date.now() - 90000);
    await Session.updateOne({ _id: sessionId }, { $set: { startedAt: back, startTime: back, originalStartedAt: back } });

    const end = await w.userSock.emitAck("session:end", { sessionId });
    assert.equal(end.ok, true);
    const userEnded = await w.userSock.waitFor("session:ended");
    const astroEnded = await w.astroSock.waitFor("session:ended");

    assert.equal(userEnded.status, "COMPLETED");
    assert.equal(userEnded.totalCost, astroEnded.totalCost, "both see the same price");
    assert.equal(userEnded.durationSeconds, astroEnded.durationSeconds);
    assert.ok(userEnded.durationSeconds >= 90 && userEnded.durationSeconds <= 92);
    assert.ok(userEnded.totalCost > 0);
    assert.equal(userEnded.endedBy, "USER");
    assert.equal(userEnded.walletBalanceAfter, Number((500 - userEnded.totalCost).toFixed(2)));
    assert.equal(astroEnded.earnings, Number((userEnded.totalCost * 0.6).toFixed(2)));
    assert.equal(astroEnded.walletBalanceAfter, undefined, "the astrologer is not told the user's balance");

    assert.equal(await WalletTransaction.countDocuments({}), 1);
    assert.ok(Math.abs((await User.findById(w.user._id)).walletBalance - (500 - userEnded.totalCost)) < 1e-6);
});

test("an unrelated connected user receives none of a session's events", async () => {
    const w = await world();
    const outsider = await h.createUser({ walletBalance: 900 });
    const otherAstro = await h.createAstrologer();
    const outsiderSock = await rt.connect(h.tokenFor(outsider, "user"), V2);
    const otherAstroSock = await rt.connect(h.tokenFor(otherAstro, "astrologer"), V2);
    await h.sleep(100);

    const { session } = await requestV2(w, "VIDEO");
    await w.astroSock.emitAck("session:accept", { sessionId: session.sessionId });
    await w.userSock.emitAck("session:media_ready", { sessionId: session.sessionId });
    await w.astroSock.emitAck("session:media_ready", { sessionId: session.sessionId });
    await w.userSock.emitAck("session:end", { sessionId: session.sessionId });
    await h.sleep(300);

    for (const s of [outsiderSock, otherAstroSock]) {
        const sessionEvents = s.inbox.map((m) => m.event).filter((e) => e.startsWith("session:") || /call|chat/.test(e));
        assert.deepEqual(sessionEvents, [], `an uninvolved client received: ${sessionEvents.join(", ")}`);
    }
});

test("v2 VIDEO: each side gets its own Agora credentials; billing starts only after BOTH are media-ready", async () => {
    const w = await world({ balance: 500, fee: 25 });
    const { session } = await requestV2(w, "VIDEO");
    assert.equal(session.type, "VIDEO");
    assert.equal(session.perMinuteRate, 25);

    await w.astroSock.emitAck("session:accept", { sessionId: session.sessionId });
    const userAcc = await w.userSock.waitFor("session:accepted");
    const astroAcc = await w.astroSock.waitFor("session:accepted");

    assert.equal(userAcc.status, "CONNECTING");
    assert.equal(userAcc.agora.channelName, astroAcc.agora.channelName);
    assert.equal(userAcc.agora.uid, 1);
    assert.equal(astroAcc.agora.uid, 2);
    assert.notEqual(userAcc.agora.token, astroAcc.agora.token, "tokens are per participant, never shared");
    assert.ok(userAcc.connectDeadline);
    assert.equal(w.userSock.has("session:started"), false, "no billing clock before media is ready");

    const first = await w.userSock.emitAck("session:media_ready", { sessionId: session.sessionId });
    assert.equal(first.ok, true);
    assert.equal(first.started, false);
    await h.sleep(150);
    assert.equal(w.astroSock.has("session:started"), false, "one participant ready is not enough");

    const second = await w.astroSock.emitAck("session:media_ready", { sessionId: session.sessionId });
    assert.equal(second.started, true);
    const us = await w.userSock.waitFor("session:started");
    const as = await w.astroSock.waitFor("session:started");
    assert.equal(us.startedAt, as.startedAt);
    assert.equal((await Session.findById(session.sessionId).lean()).status, "ACTIVE");
});

test("a call that never connects is cancelled by the scheduler at the deadline, both sides told, nothing charged", async () => {
    const w = await world({ balance: 500 });
    const { session } = await requestV2(w, "AUDIO");
    await w.astroSock.emitAck("session:accept", { sessionId: session.sessionId });
    await w.astroSock.emitAck("session:media_ready", { sessionId: session.sessionId }); // user never joins

    await scheduler.runTick({ io: rt.io, now: plus(10) });
    assert.equal(w.userSock.has("session:cancelled"), false, "still inside the 20s window");

    await scheduler.runTick({ io: rt.io, now: plus(25) });
    await w.userSock.waitFor("session:cancelled");
    await w.astroSock.waitFor("session:cancelled");
    const s = await Session.findById(session.sessionId).lean();
    assert.equal(s.status, "CANCELLED");
    assert.equal(s.endReason, "MEDIA_CONNECT_FAILED");
    assert.equal((await User.findById(w.user._id)).walletBalance, 500);
});

test("an unanswered request is MISSED by the scheduler at exactly the server deadline", async () => {
    const w = await world();
    const { session } = await requestV2(w, "CHAT");
    await w.astroSock.waitFor("session:incoming");

    await scheduler.runTick({ io: rt.io, now: plus(29) });
    assert.equal(w.userSock.has("session:missed"), false);
    await scheduler.runTick({ io: rt.io, now: plus(31) });
    await w.userSock.waitFor("session:missed");
    await w.astroSock.waitFor("session:missed");
    assert.equal((await Session.findById(session.sessionId).lean()).status, "MISSED");

    // the astrologer can be requested again right away
    const again = await h.createUser({ walletBalance: 500 });
    const againSock = await rt.connect(h.tokenFor(again, "user"), V2);
    const r = await againSock.emitAck("session:request", { astrologerId: String(w.astro._id), type: "CHAT" });
    assert.equal(r.ok, true);
});

test("a busy astrologer never receives a second request", async () => {
    const w = await world();
    const second = await h.createUser({ walletBalance: 500 });
    const secondSock = await rt.connect(h.tokenFor(second, "user"), V2);
    await h.sleep(80);

    await requestV2(w, "CHAT");
    await w.astroSock.waitFor("session:incoming");
    const r2 = await secondSock.emitAck("session:request", { astrologerId: String(w.astro._id), type: "CHAT" });
    assert.equal(r2.ok, false);
    assert.equal(r2.code, "ASTROLOGER_BUSY");
    await h.sleep(200);
    assert.equal(w.astroSock.count("session:incoming"), 1, "the astrologer saw exactly one request");
});

test("an offline astrologer cannot be requested", async () => {
    const w = await world({ astroOverrides: { isOnline: false } });
    const r = await requestV2(w, "CHAT");
    assert.equal(r.ok, false);
    assert.equal(r.code, "ASTROLOGER_OFFLINE");
    assert.equal(w.astroSock.has("session:incoming"), false);
});

test("accept is refused (and the astrologer freed) when the user has gone away", async () => {
    const w = await world();
    const { session } = await requestV2(w, "CHAT");
    await w.astroSock.waitFor("session:incoming");
    w.userSock.close(); // user leaves while the request is ringing
    await h.sleep(250);

    const acc = await w.astroSock.emitAck("session:accept", { sessionId: session.sessionId });
    assert.equal(acc.ok, false);
    assert.equal(acc.code, "USER_UNAVAILABLE");
    const s = await Session.findById(session.sessionId).lean();
    assert.equal(s.status, "CANCELLED");
    assert.equal(s.liveLock, false);
});

test("duplicate accepts and simultaneous Ends each reach the participants exactly once", async () => {
    const w = await world({ balance: 500 });
    const { session } = await requestV2(w, "CHAT");
    const id = session.sessionId;

    const accepts = await Promise.all([1, 2, 3].map(() => w.astroSock.emitAck("session:accept", { sessionId: id })));
    assert.ok(accepts.every((a) => a.ok));
    assert.equal(accepts.filter((a) => a.idempotent === false).length, 1);
    await h.sleep(250);
    assert.equal(w.userSock.count("session:accepted"), 1, "the user was told once");
    assert.equal(w.astroSock.count("session:accepted"), 1);
    assert.equal(w.userSock.count("session:started"), 1);

    const ends = await Promise.all([
        w.userSock.emitAck("session:end", { sessionId: id }),
        w.astroSock.emitAck("session:end", { sessionId: id }),
        w.userSock.emitAck("session:end", { sessionId: id })
    ]);
    assert.ok(ends.every((e) => e.ok));
    await h.sleep(300);
    assert.equal(w.userSock.count("session:ended"), 1, "one final result per participant, never duplicates");
    assert.equal(w.astroSock.count("session:ended"), 1);
    assert.equal(await WalletTransaction.countDocuments({}), 0, "a zero-second session moves no money");
});

test("a participant who is not part of the session is refused by the guard, with an acknowledgement", async () => {
    const w = await world();
    const stranger = await h.createUser();
    const strangerSock = await rt.connect(h.tokenFor(stranger, "user"), V2);
    const { session } = await requestV2(w, "CHAT");
    const r = await strangerSock.emitAck("session:end", { sessionId: session.sessionId });
    assert.equal(r.ok, false);
    assert.equal(r.code, "FORBIDDEN");
    assert.equal((await Session.findById(session.sessionId).lean()).status, "PENDING");
});

// ---------------------------------------------------------------- scheduler: ticks, balance, pause

test("ticks carry the server clock to both sides once per interval and warn when balance is low", async () => {
    const w = await world({ balance: 25 }); // 25 at ₹9/min -> under a minute left almost immediately
    const { session } = await requestV2(w, "CHAT");
    await w.astroSock.emitAck("session:accept", { sessionId: session.sessionId });

    await scheduler.runTick({ io: rt.io, now: plus(5) });
    const t1 = await w.userSock.waitFor("session:tick");
    const t2 = await w.astroSock.waitFor("session:tick");
    assert.equal(t1.startedAt, t2.startedAt);
    assert.ok(t1.serverNow);
    assert.equal(t1.remainingBalance, Number((25 - 5 * 0.15).toFixed(2)));

    // inside the same interval nothing is re-sent
    await scheduler.runTick({ io: rt.io, now: plus(6) });
    await h.sleep(100);
    assert.equal(w.userSock.count("session:tick"), 1);

    // balance 25 -> under 9 (one minute) after ~107s: low-balance warning
    await scheduler.runTick({ io: rt.io, now: plus(110) });
    await w.userSock.waitFor("session:low_balance");
});

test("the wallet limit ends the session exactly at maxEndAt even when the scheduler is late", async () => {
    const w = await world({ balance: 20 }); // floor(20 / 0.15) = 133 seconds
    const { session } = await requestV2(w, "CHAT");
    await w.astroSock.emitAck("session:accept", { sessionId: session.sessionId });
    const started = await Session.findById(session.sessionId).lean();

    await scheduler.runTick({ io: rt.io, now: new Date(started.startedAt.getTime() + 600000) }); // 10 minutes late
    const ended = await w.userSock.waitFor("session:ended");
    await w.astroSock.waitFor("session:ended");

    assert.equal(ended.durationSeconds, 133, "billed to the wallet limit, not to when the scheduler noticed");
    assert.equal(ended.endedBy, "SYSTEM");
    assert.equal(ended.endReason, "INSUFFICIENT_BALANCE");
    assert.equal(ended.totalCost, 19.95);
});

test("recharge pause: billing pauses, resumes with the paused time excluded, and the 2 minute limit ends it", async () => {
    const w = await world({ balance: 500 });
    const { session } = await requestV2(w, "CHAT");
    const id = session.sessionId;
    await w.astroSock.emitAck("session:accept", { sessionId: id });
    const before = (await Session.findById(id).lean()).startedAt;

    const p = await w.userSock.emitAck("session:pause_billing", { sessionId: id });
    assert.equal(p.ok, true);
    await w.astroSock.waitFor("session:billing_paused");
    assert.ok((await Session.findById(id).lean()).pauseDeadline);

    await h.sleep(400);
    const r = await w.userSock.emitAck("session:resume_billing", { sessionId: id });
    assert.equal(r.ok, true);
    await w.astroSock.waitFor("session:billing_resumed");
    const after = await Session.findById(id).lean();
    assert.ok(after.startedAt.getTime() > before.getTime() + 300, "startedAt moved forward by the paused time");
    assert.equal(after.billingPausedAt, null);
    assert.ok(after.originalStartedAt.getTime() <= before.getTime(), "the true start is kept for history");

    // the astrologer cannot pause the user's billing
    const denied = await w.astroSock.emitAck("session:pause_billing", { sessionId: id });
    assert.equal(denied.ok, false);

    // paused for longer than 2 minutes -> ended by the scheduler
    await w.userSock.emitAck("session:pause_billing", { sessionId: id });
    await scheduler.runTick({ io: rt.io, now: plus(125) });
    const ended = await w.userSock.waitFor("session:ended");
    assert.equal(ended.endReason, "Recharge timeout exceeded");
});

test("a session left ENDING by a crash is settled by the scheduler and both sides get the result", async () => {
    const w = await world({ balance: 500 });
    const { session } = await requestV2(w, "CHAT");
    await w.astroSock.emitAck("session:accept", { sessionId: session.sessionId });
    const s = await Session.findById(session.sessionId).lean();
    const endedAt = new Date(s.startedAt.getTime() + 60000);
    // as if the process died right after the ACTIVE -> ENDING transition
    await Session.updateOne({ _id: s._id }, { $set: { status: "ENDING", endedAt, endTime: endedAt, endedBy: "USER", "settlement.state": "IN_PROGRESS" } });

    await scheduler.runTick({ io: rt.io, now: new Date(endedAt.getTime() + 20000) });
    const ended = await w.userSock.waitFor("session:ended");
    await w.astroSock.waitFor("session:ended");
    assert.equal(ended.status, "COMPLETED");
    assert.equal(ended.totalCost, 9);
    assert.equal((await User.findById(w.user._id)).walletBalance, 491);
});

// ---------------------------------------------------------------- legacy clients (unchanged apps)

test("legacy CHAT over sockets: the old event names and payloads still work", async () => {
    const w = await world({ userAuth: {}, astroAuth: {} });

    w.userSock.emit("request_chat", { astrologerId: String(w.astro._id), name: "Asha", dob: "14/08/2001", tob: "10:30", pob: "Pune" });
    const created = await w.userSock.waitFor("chat_request_created");
    const incoming = await w.astroSock.waitFor("incoming_chat_request");
    assert.equal(String(incoming.sessionId), String(created.session.sessionId));
    assert.equal(incoming.user.name, "Asha");
    assert.equal(incoming.user.dob, "14 Aug 2001");
    assert.equal(incoming.user.pob, "Pune");
    assert.equal(incoming.ringtoneDuration, 30);

    w.astroSock.emit("accept_chat_request", { sessionId: String(incoming.sessionId) });
    const accepted = await w.userSock.waitFor("chat_accepted");
    const active = await w.userSock.waitFor("session_active");
    assert.ok(accepted.startTime, "legacy clients still get startTime");
    assert.equal(accepted.startTime, active.startTime);
    assert.ok(accepted.serverNow);

    w.userSock.emit("end_chat_session", { sessionId: String(incoming.sessionId) });
    const ended = await w.astroSock.waitFor("chat_ended");
    await w.astroSock.waitFor("session_ended");
    await w.userSock.waitFor("chat_ended");
    assert.equal(ended.session.status, "COMPLETED");
    assert.ok("totalAmountDeducted" in ended.session);
});

test("legacy CALL over sockets: call_accepted carries the Agora token and a start time", async () => {
    const w = await world({ userAuth: {}, astroAuth: {}, fee: 20 });

    w.userSock.emit("request_call", { astrologerId: String(w.astro._id), callType: "VIDEO" });
    const sent = await w.userSock.waitFor("call_request_sent");
    const incoming = await w.astroSock.waitFor("incoming_call_request");
    assert.equal(incoming.callType, "VIDEO");
    assert.equal(incoming.perMinuteRate, 20);
    assert.equal(String(incoming.sessionId), String(sent.session.sessionId));

    w.astroSock.emit("accept_call_request", { sessionId: String(incoming.sessionId) });
    const accepted = await w.userSock.waitFor("call_accepted");
    assert.ok(accepted.token && accepted.appId && accepted.channelName);
    assert.equal(accepted.agora.uid, 0, "legacy clients keep the uid-0 token they were built for");
    assert.ok(accepted.startTime, "both legacy: ACTIVE at accept, as before");

    w.astroSock.emit("end_call_session", { sessionId: String(incoming.sessionId) });
    await w.userSock.waitFor("call_ended");
    await w.astroSock.waitFor("call_ended");
});

test("a v2 astrologer with a legacy user: the user starts at accept, the call starts when the astrologer is ready", async () => {
    const w = await world({ userAuth: {}, astroAuth: V2 });
    w.userSock.emit("request_call", { astrologerId: String(w.astro._id), callType: "AUDIO" });
    const incoming = await w.astroSock.waitFor("session:incoming"); // v2 astrologer hears the new event
    assert.equal(incoming.type, "AUDIO");

    await w.astroSock.emitAck("session:accept", { sessionId: String(incoming.sessionId) });
    await w.userSock.waitFor("call_accepted");
    assert.equal((await Session.findById(incoming.sessionId).lean()).status, "CONNECTING");

    await w.astroSock.emitAck("session:media_ready", { sessionId: String(incoming.sessionId) });
    await w.userSock.waitFor("timer_tick"); // legacy clocks sync from a tick-shaped event
    await w.astroSock.waitFor("session:started");
    assert.equal((await Session.findById(incoming.sessionId).lean()).status, "ACTIVE");
});

test("legacy reject by the astrologer and cancel by the user dismiss the request on both screens", async () => {
    const w = await world({ userAuth: {}, astroAuth: {} });
    w.userSock.emit("request_chat", { astrologerId: String(w.astro._id) });
    const incoming = await w.astroSock.waitFor("incoming_chat_request");

    w.astroSock.emit("reject_chat_request", { sessionId: String(incoming.sessionId), reason: "busy" });
    await w.userSock.waitFor("chat_rejected");
    await w.astroSock.waitFor("incoming_request_cancelled");
    assert.equal((await Session.findById(incoming.sessionId).lean()).status, "REJECTED");

    w.userSock.emit("request_chat", { astrologerId: String(w.astro._id) });
    await h.sleep(150);
    const second = await Session.findOne({ status: "PENDING" }).lean();
    w.userSock.emit("cancel_chat_request", { sessionId: String(second._id) });
    await w.astroSock.waitFor("request_cancelled", 3000, (p) => String(p.sessionId) === String(second._id));
    assert.equal((await Session.findById(second._id).lean()).status, "CANCELLED");
});

// ---------------------------------------------------------------- REST (unchanged URLs and shapes)

test("REST: the existing chat endpoints still work end to end", async () => {
    const app = require("../src/app");
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const w = await world({ userAuth: {}, astroAuth: {} });
    const call = (path, token, body) =>
        fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const userTok = h.tokenFor(w.user, "user");
    const astroTok = h.tokenFor(w.astro, "astrologer");

    try {
        const init = await call("/api/chat/initiate", userTok, { astrologerId: String(w.astro._id), userId: "someone-else", name: "Meera" });
        assert.equal(init.status, 201);
        assert.equal(String(init.body.data.user._id), String(w.user._id), "identity comes from the token, not the body");
        assert.equal(init.body.data.user.name, "Meera");
        const id = init.body.data.sessionId;
        const incoming = await w.astroSock.waitFor("incoming_chat_request");
        assert.equal(String(incoming.sessionId), String(id));

        const acc = await call("/api/chat/accept", astroTok, { sessionId: id });
        assert.equal(acc.status, 200);
        assert.equal(acc.body.data.status, "ACTIVE");
        assert.ok(acc.body.data.startTime && acc.body.data.serverNow);
        await w.userSock.waitFor("chat_accepted");

        const end = await call("/api/chat/end", astroTok, { sessionId: id });
        assert.equal(end.status, 200);
        assert.equal(end.body.data.status, "COMPLETED");
        assert.ok(end.body.data.final && "earnings" in end.body.data.final, "the astrologer's result includes earnings");
        const end2 = await call("/api/chat/end", userTok, { sessionId: id });
        assert.equal(end2.status, 200);
        assert.equal(end2.body.data.status, "COMPLETED");
        assert.equal(end2.body.data.final.totalCost, end.body.data.final.totalCost, "the second End gets the same result");
        assert.ok(!("earnings" in end2.body.data.final), "the user's result has no astrologer earnings");
    } finally {
        server.close();
    }
});

test("REST: the existing call endpoints still work (request, accept with Agora data, end)", async () => {
    const app = require("../src/app");
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const w = await world({ userAuth: {}, astroAuth: {}, fee: 30 });
    const call = (path, token, body) =>
        fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const userTok = h.tokenFor(w.user, "user");
    const astroTok = h.tokenFor(w.astro, "astrologer");

    try {
        const reqd = await call("/api/video-session/request", userTok, { astrologerId: String(w.astro._id), callType: "VIDEO" });
        assert.equal(reqd.status, 201);
        assert.equal(reqd.body.data.perMinuteRate, 30);
        const id = reqd.body.data._id;
        await w.astroSock.waitFor("incoming_call_request");

        const acc = await call(`/api/video-session/accept/${id}`, astroTok, {});
        assert.equal(acc.status, 200);
        assert.ok(acc.body.data.agora.token && acc.body.data.agora.appId, "the astrologer gets Agora credentials in the response");
        const accepted = await w.userSock.waitFor("call_accepted");
        assert.equal(accepted.callType, "VIDEO");

        const end = await call(`/api/video-session/end/${id}`, userTok, {});
        assert.equal(end.status, 200);
        assert.equal(end.body.data.status, "COMPLETED");
        await w.astroSock.waitFor("call_ended");

        // errors keep a readable message
        const poor = await h.createUser({ walletBalance: 5 });
        const bad = await call("/api/video-session/request", h.tokenFor(poor, "user"), { astrologerId: String(w.astro._id), callType: "VIDEO" });
        assert.equal(bad.status, 400);
        assert.match(bad.body.message, /Insufficient wallet balance/);
    } finally {
        server.close();
    }
});
