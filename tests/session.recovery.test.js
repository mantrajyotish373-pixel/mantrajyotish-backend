/**
 * Phase 4: disconnect / reconnect policy and recovery.
 *   - 60s grace per participant, the session stays ACTIVE through a temporary network loss
 *   - astrologer absence unbilled, user absence billed, overlap unbilled
 *   - reconnect restores state; expiry ends the session at the deadline
 *   - safety net for a dead instance, and recovery after a server restart
 * Time-sensitive cases use explicit timestamps (no sleeping for real minutes).
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const h = require("./helpers/harness");

let mongo;
let rt;
let engine;
let connection;
let scheduler;
let handlers;
let Session;
let User;
let Astrologer;
let background;

const V2 = { sessionProtocol: 2 };
// relative to now so operations that use the real clock (socket connects) stay consistent
const T0 = new Date(Date.now() - 600000);
const at = (seconds) => new Date(T0.getTime() + seconds * 1000);

before(async () => {
    mongo = await h.startMongo();
    rt = await h.startRealtime();
    engine = require("../src/services/session/engine");
    connection = require("../src/services/session/connection");
    scheduler = require("../src/services/session/scheduler");
    handlers = require("../src/services/session/handlers");
    background = require("../src/services/session/background");
    Session = require("../src/models/session.model");
    User = require("../src/models/user.model");
    Astrologer = require("../src/models/astro.model");
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

/** An ACTIVE chat started at T0 (engine time), with no sockets attached. */
const activeSession = async ({ balance = 5000, type = "CHAT" } = {}) => {
    const user = await h.createUser({ walletBalance: balance });
    const astro = await h.createAstrologer({ consultationFee: 12 });
    await h.createAdmin();
    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type, now: T0 });
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: at(1) });
    return { user, astro, id: session._id };
};

const get = (id) => Session.findById(id).lean();

/** Both participants were seen shortly before `seconds`, so the dead-instance safety net stays out of the way. */
const seenRecently = (id, seconds) =>
    Session.updateOne({ _id: id }, { $set: { "lastSeen.user": at(seconds - 1), "lastSeen.astrologer": at(seconds - 1) } });

// ---------------------------------------------------------------- connection state + billing

test("a user dropping starts a 60s grace window; the session stays ACTIVE and returning clears it", async () => {
    const { id } = await activeSession();
    const marked = await connection.markDisconnected({ sessionId: id, role: "USER", now: at(100) });
    assert.equal(marked.status, "ACTIVE", "a temporary drop never ends the session");
    assert.equal(marked.connection.user.state, "RECONNECTING");
    assert.equal(marked.connection.user.since.getTime(), at(100).getTime());
    assert.equal(marked.connection.user.deadline.getTime(), at(160).getTime(), "60 seconds of grace");

    // duplicate detection does not restart the window
    assert.equal(await connection.markDisconnected({ sessionId: id, role: "USER", now: at(120) }), null);
    assert.equal((await get(id)).connection.user.deadline.getTime(), at(160).getTime());

    const back = await connection.markConnected({ sessionId: id, role: "USER", now: at(130) });
    assert.equal(back.resumed, true);
    const s = await get(id);
    assert.equal(s.connection.user.state, "CONNECTED");
    assert.equal(s.connection.user.deadline, null);
    assert.equal(s.disconnectState.unbilledGraceSeconds, 0, "the user's absence is billed, not waived");
});

test("an astrologer's absence is added to the unbilled seconds exactly, and excluded from the price", async () => {
    const { user, astro, id } = await activeSession({ balance: 5000 });
    await connection.markDisconnected({ sessionId: id, role: "ASTROLOGER", now: at(61) });
    const back = await connection.markConnected({ sessionId: id, role: "ASTROLOGER", now: at(96) });
    assert.equal(back.absenceSeconds, 35);
    assert.equal((await get(id)).disconnectState.unbilledGraceSeconds, 35);

    // 1 -> 241 = 240s on the clock, minus 35s unbilled => 205s billable at ₹9/min = ₹30.75
    const end = await engine.endSession({ sessionId: id, actor: h.asUser(user), now: at(241) });
    assert.equal(end.session.settlement.billing.rawSeconds, 240);
    assert.equal(end.session.settlement.billing.unbilledSeconds, 35);
    assert.equal(end.session.totalDurationSeconds, 205);
    assert.equal(end.session.totalAmountDeducted, 30.75);
});

test("grace expiry: a user who never returns is ended AT the deadline and billed through it", async () => {
    const { id } = await activeSession();
    await connection.markDisconnected({ sessionId: id, role: "USER", now: at(100) });

    await seenRecently(id, 150);
    await scheduler.runTick({ io: rt.io, now: at(150) });
    assert.equal((await get(id)).status, "ACTIVE", "still inside the 60s window");

    await seenRecently(id, 500);
    await scheduler.runTick({ io: rt.io, now: at(500) }); // the scheduler runs late
    const s = await get(id);
    assert.equal(s.status, "COMPLETED");
    assert.equal(s.endReason, "USER_DISCONNECTED");
    assert.equal(s.endedBy, "SYSTEM");
    assert.equal(s.endedAt.getTime(), at(160).getTime(), "ended at the deadline, not when the scheduler noticed");
    assert.equal(s.totalDurationSeconds, 159, "1 -> 160, user absence billed");
});

test("grace expiry: an astrologer who never returns is ended at the deadline; the absence is not billed", async () => {
    const { id } = await activeSession();
    await connection.markDisconnected({ sessionId: id, role: "ASTROLOGER", now: at(101) });
    await seenRecently(id, 400);
    await scheduler.runTick({ io: rt.io, now: at(400) });

    const s = await get(id);
    assert.equal(s.status, "COMPLETED");
    assert.equal(s.endReason, "ASTROLOGER_DISCONNECTED");
    assert.equal(s.endedAt.getTime(), at(161).getTime());
    assert.equal(s.settlement.billing.rawSeconds, 160);
    assert.equal(s.settlement.billing.unbilledSeconds, 60, "the 60s the astrologer was away");
    assert.equal(s.totalDurationSeconds, 100, "billed only up to the moment the astrologer was lost");
});

test("both away: the overlap follows the astrologer rule (unbilled), ended at the first deadline", async () => {
    const { id } = await activeSession();
    await connection.markDisconnected({ sessionId: id, role: "USER", now: at(51) });        // deadline 111
    await connection.markDisconnected({ sessionId: id, role: "ASTROLOGER", now: at(101) }); // deadline 161
    await seenRecently(id, 300);
    await scheduler.runTick({ io: rt.io, now: at(300) });

    const s = await get(id);
    assert.equal(s.endReason, "BOTH_DISCONNECTED");
    assert.equal(s.endedAt.getTime(), at(111).getTime());
    assert.equal(s.settlement.billing.rawSeconds, 110);
    assert.equal(s.settlement.billing.unbilledSeconds, 10, "the astrologer was away 101 -> 111");
    assert.equal(s.totalDurationSeconds, 100);
});

test("the grace window differs by nothing for Chat / Audio / Video: 60 seconds each", async () => {
    for (const type of ["CHAT", "AUDIO", "VIDEO"]) {
        await h.resetData();
        const { id } = await activeSession({ type });
        const m = await connection.markDisconnected({ sessionId: id, role: "USER", now: at(10) });
        assert.equal(m.connection.user.deadline.getTime() - at(10).getTime(), 60000, `${type} grace`);
    }
});

// ---------------------------------------------------------------- real sockets

test("closing one of several sockets keeps the participant connected; closing the last starts the grace window", async () => {
    const user = await h.createUser({ walletBalance: 5000 });
    const astro = await h.createAstrologer();
    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "CHAT" });
    const a = await rt.connect(h.tokenFor(user, "user"), V2);
    const a2 = await rt.connect(h.tokenFor(user, "user"), V2); // e.g. the mobile app's per-screen sockets
    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"), V2);
    await h.sleep(100);
    await handlers.acceptSession({ decoded: { userId: String(astro._id), role: "astrologer" }, sessionId: session._id, protocol: 2 });

    a.close();
    await h.sleep(300);
    assert.equal((await get(session._id)).connection.user.state, "CONNECTED", "another socket of the user is still connected");

    a2.close();
    const peer = await astroSock.waitFor("session:peer_reconnecting");
    assert.equal(peer.role, "USER");
    assert.ok(peer.deadline && peer.serverNow);
    assert.equal((await get(session._id)).connection.user.state, "RECONNECTING");
    assert.equal((await get(session._id)).status, "ACTIVE");

    // network comes back: the participant is resumed automatically on connect, no client call needed
    await rt.connect(h.tokenFor(user, "user"), V2);
    const back = await astroSock.waitFor("session:peer_reconnected");
    assert.equal(back.role, "USER");
    assert.equal((await get(session._id)).connection.user.state, "CONNECTED");
});

test("an astrologer reconnecting mid-session is resumed, and does not appear available to new requests", async () => {
    const user = await h.createUser({ walletBalance: 5000 });
    const astro = await h.createAstrologer();
    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "CHAT", protocol: 2 });
    const userSock = await rt.connect(h.tokenFor(user, "user"), V2);
    let astroSock = await rt.connect(h.tokenFor(astro, "astrologer"), V2);
    await h.sleep(100);
    await handlers.acceptSession({ decoded: { userId: String(astro._id), role: "astrologer" }, sessionId: session._id, protocol: 2 });

    astroSock.close();
    await userSock.waitFor("session:peer_reconnecting");

    astroSock = await rt.connect(h.tokenFor(astro, "astrologer"), V2);
    await userSock.waitFor("session:peer_reconnected");
    astroSock.emit("register_astrologer", { astrologerId: String(astro._id) }); // legacy registration flips presence ONLINE
    await h.sleep(400);
    await background.flushBackground();

    assert.equal((await Astrologer.findById(astro._id)).isAvailable, false, "a live session still occupies the astrologer");
    const other = await h.createUser({ walletBalance: 500 });
    await assert.rejects(
        engine.requestSession({ userId: String(other._id), astrologerId: String(astro._id), type: "CHAT" }),
        (e) => e.code === "ASTROLOGER_BUSY"
    );
    assert.ok((await get(session._id)).disconnectState.unbilledGraceSeconds >= 0);
});

// ---------------------------------------------------------------- dead instance / restart

test("safety net: a participant with no socket and no sign of life is moved into grace; a connected one is left alone", async () => {
    const { user, astro, id } = await activeSession();
    // no sockets are connected for this session and nobody has been seen for a long time
    const stale = at(10); // last sign of life, long before the check below
    await Session.updateOne({ _id: id }, { $set: { "lastSeen.user": stale, "lastSeen.astrologer": stale } });

    const marked = await connection.detectDisconnects({ io: rt.io, now: at(200) });
    assert.equal(marked, 2);
    const s = await get(id);
    assert.equal(s.connection.user.state, "RECONNECTING");
    assert.equal(s.connection.user.since.getTime(), stale.getTime(), "the absence is dated from the last sign of life");

    // a participant who IS connected (e.g. a legacy client that never sends heartbeats) is just re-verified
    await h.resetData();
    const w = await activeSession();
    const sock = await rt.connect(h.tokenFor(w.user, "user"));
    await h.sleep(100);
    await Session.updateOne({ _id: w.id }, { $set: { "lastSeen.user": stale } });
    await connection.detectDisconnects({ io: rt.io, now: at(200) });
    const s2 = await get(w.id);
    assert.equal(s2.connection.user.state, "CONNECTED");
    assert.equal(s2.lastSeen.user.getTime(), at(200).getTime(), "liveness verified and recorded");
    sock.close();
});

test("server restart: participants of live sessions enter a fresh grace window and are resumed when they reconnect", async () => {
    const { user, astro, id } = await activeSession();
    const lastContact = at(30);
    await Session.updateOne({ _id: id }, { $set: { "lastSeen.user": lastContact, "lastSeen.astrologer": lastContact } });

    // the process restarted: no sockets are connected yet
    const restartAt = at(90);
    const marked = await connection.recoverOnStart({ io: rt.io, now: restartAt });
    assert.equal(marked, 2);
    const s = await get(id);
    assert.equal(s.status, "ACTIVE", "a restart never ends a session");
    assert.equal(s.connection.astrologer.since.getTime(), lastContact.getTime(), "absence dated from last contact");
    assert.equal(s.connection.astrologer.deadline.getTime(), restartAt.getTime() + 60000, "a full grace window counted from the restart");

    // clients reconnect on their own
    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"), V2);
    await rt.connect(h.tokenFor(user, "user"), V2);
    await h.sleep(300);
    const resumed = await get(id);
    assert.equal(resumed.connection.user.state, "CONNECTED");
    assert.equal(resumed.connection.astrologer.state, "CONNECTED");
    assert.ok(resumed.disconnectState.unbilledGraceSeconds > 0, "the downtime counts as astrologer absence (unbilled)");
    astroSock.close();
});

test("recovery does not touch a participant who is still reachable (another instance)", async () => {
    const { user, id } = await activeSession();
    const sock = await rt.connect(h.tokenFor(user, "user"));
    await h.sleep(100);
    const marked = await connection.recoverOnStart({ io: rt.io, now: at(50) });
    assert.equal(marked, 1, "only the astrologer, who has no socket");
    assert.equal((await get(id)).connection.user.state, "CONNECTED");
    sock.close();
});

// ---------------------------------------------------------------- recovery API

test("session:resume returns the authoritative snapshot (fresh Agora credentials for calls)", async () => {
    const user = await h.createUser({ walletBalance: 5000 });
    const astro = await h.createAstrologer({ consultationFee: 20 });
    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "VIDEO", protocol: 2 });
    const userSock = await rt.connect(h.tokenFor(user, "user"), V2);
    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"), V2);
    await h.sleep(100);
    await astroSock.emitAck("session:accept", { sessionId: String(session._id) });
    await userSock.emitAck("session:media_ready", { sessionId: String(session._id) });
    await astroSock.emitAck("session:media_ready", { sessionId: String(session._id) });

    const r = await userSock.emitAck("session:resume", { sessionId: String(session._id) });
    assert.equal(r.ok, true);
    assert.equal(r.session.status, "ACTIVE");
    assert.ok(r.session.startedAt && r.session.serverNow && r.session.maxEndAt);
    assert.equal(r.session.role, "USER");
    assert.equal(r.session.agora.uid, 1);
    assert.ok(r.session.agora.token);
    assert.equal(r.session.perMinuteRate, 20);

    const stranger = await h.createUser();
    const strangerSock = await rt.connect(h.tokenFor(stranger, "user"), V2);
    const denied = await strangerSock.emitAck("session:resume", { sessionId: String(session._id) });
    assert.equal(denied.ok, false);
});

test("GET /api/session/active: live session -> final result until acknowledged -> nothing", async () => {
    const app = require("../src/app");
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const user = await h.createUser({ walletBalance: 5000 });
    const astro = await h.createAstrologer();
    await h.createAdmin();
    const userTok = h.tokenFor(user, "user");
    const astroTok = h.tokenFor(astro, "astrologer");
    const getActive = (tok) => fetch(`${base}/api/session/active`, { headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json());

    try {
        assert.equal((await getActive(userTok)).data, null);

        // PENDING is recoverable too (a restart while ringing)
        const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "CHAT", now: new Date() });
        const pending = await getActive(userTok);
        assert.equal(pending.data.status, "PENDING");
        assert.equal(pending.data.snapshot.status, "PENDING");
        assert.ok(pending.data.snapshot.expiresAt);
        assert.equal((await getActive(astroTok)).data.status, "PENDING", "the astrologer sees the request too");

        await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro) });
        const active = await getActive(userTok);
        assert.equal(active.data.status, "ACTIVE");
        assert.ok(active.data.startedAt && active.data.serverNow);
        assert.equal(active.data.role, "USER");

        // someone else cannot see it
        const other = await h.createUser();
        assert.equal((await getActive(h.tokenFor(other, "user"))).data, null);

        // the end event was missed while offline: the result is still delivered on recovery
        await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: new Date(Date.now() + 120000) });
        const finished = await getActive(userTok);
        assert.equal(finished.data.status, "COMPLETED");
        assert.ok(finished.data.snapshot.final.totalCost > 0);
        assert.ok("walletBalanceAfter" in finished.data.snapshot.final);
        const astroFinished = await getActive(astroTok);
        assert.ok("earnings" in astroFinished.data.snapshot.final);

        // acknowledged -> gone
        await engine.ackFinal({ sessionId: session._id, actor: h.asUser(user) });
        assert.equal((await getActive(userTok)).data, null);
        assert.equal((await getActive(astroTok)).data.status, "COMPLETED", "each participant acknowledges separately");
    } finally {
        server.close();
    }
});

test("heartbeat records proof of life; the stale cleanup no longer ends long sessions", async () => {
    const { user, astro, id } = await activeSession();
    const sock = await rt.connect(h.tokenFor(user, "user"), V2);
    const before = (await get(id)).lastSeen.user;
    await h.sleep(30);
    const r = await sock.emitAck("session:heartbeat", { sessionId: String(id) });
    assert.equal(r.ok, true);
    assert.ok((await get(id)).lastSeen.user.getTime() > before.getTime());

    // legacy cleanup used to end ACTIVE sessions older than 30 minutes on every astrologer reconnect
    await Session.updateOne({ _id: id }, { $set: { createdAt: new Date(Date.now() - 90 * 60000) } });
    await require("../src/config/socket").cleanupStaleSessions(astro._id);
    assert.equal((await get(id)).status, "ACTIVE");
    sock.close();
});
