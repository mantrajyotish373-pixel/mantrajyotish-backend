/**
 * Phase 6: client contract. The astrologer webapp's real helper modules (serverClock,
 * sessionSummary) are imported and fed REAL payloads from a live session on the real backend:
 *   - two devices with badly wrong clocks derive the SAME elapsed time from the server's startedAt
 *   - the request countdown follows the server deadline, not the device clock
 *   - the summary shown to the astrologer equals what the server settled (never recomputed locally)
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const h = require("./helpers/harness");

let mongo;
let rt;
let background;
let Session;
let clockModule;
let summaryModule;

const V2 = { sessionProtocol: 2 };
const webappFile = (f) => pathToFileURL(path.join(__dirname, "../../Astro-frontend-astrologer/src/services", f)).href;

before(async () => {
    mongo = await h.startMongo();
    rt = await h.startRealtime();
    background = require("../src/services/session/background");
    Session = require("../src/models/session.model");
    await h.syncAllIndexes();
    summaryModule = await import(webappFile("sessionSummary.js"));
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

/** A fresh copy of the clock module per simulated device (each has its own offset state). */
let deviceCounter = 0;
const newDeviceClock = async (skewMs) => {
    deviceCounter += 1;
    const mod = await import(`${webappFile("serverClock.js")}?device=${deviceCounter}`);
    return { mod, skewMs, nowMs: () => Date.now() + skewMs };
};

/** Run a function while this device's clock reads `Date.now() + skewMs`. */
const withSkew = async (skewMs, fn) => {
    const real = Date.now;
    Date.now = () => real() + skewMs;
    try {
        return await fn();
    } finally {
        Date.now = real;
    }
};

test("two devices with wrong clocks (+3 min and -2 min) derive the same elapsed time from the server startedAt", async () => {
    const user = await h.createUser({ walletBalance: 5000 });
    const astro = await h.createAstrologer();
    await h.createAdmin();
    const userSock = await rt.connect(h.tokenFor(user, "user"), V2);
    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"), V2);
    await h.sleep(100);

    const r = await userSock.emitAck("session:request", { astrologerId: String(astro._id), type: "CHAT" });
    await astroSock.emitAck("session:accept", { sessionId: r.session.sessionId });
    const userStarted = await userSock.waitFor("session:started");
    const astroStarted = await astroSock.waitFor("session:started");

    // the astrologer's device is 3 minutes fast, the user's is 2 minutes slow
    const astroDevice = await newDeviceClock(180000);
    const userDevice = await newDeviceClock(-120000);

    // each device learns the offset from the serverNow in the message it received, as the real client does
    await withSkew(astroDevice.skewMs, () => astroDevice.mod.syncServerClock(astroStarted.serverNow));
    await withSkew(userDevice.skewMs, () => userDevice.mod.syncServerClock(userStarted.serverNow));

    // 40 seconds later, by the server's reckoning
    await h.sleep(1200);
    const wait = 40;
    const astroElapsed = await withSkew(astroDevice.skewMs + wait * 1000, () => astroDevice.mod.elapsedSince(astroStarted.startedAt));
    const userElapsed = await withSkew(userDevice.skewMs + wait * 1000, () => userDevice.mod.elapsedSince(userStarted.startedAt));

    assert.equal(userStarted.startedAt, astroStarted.startedAt, "one server startedAt for both");
    assert.ok(Math.abs(astroElapsed - userElapsed) <= 1, `devices disagree: astrologer ${astroElapsed}s vs user ${userElapsed}s`);
    assert.ok(astroElapsed >= 40 && astroElapsed <= 43, `expected ~41s, got ${astroElapsed}`);
});

test("the request countdown follows the server deadline even on a device whose clock is 5 minutes off", async () => {
    const user = await h.createUser({ walletBalance: 5000 });
    const astro = await h.createAstrologer();
    const userSock = await rt.connect(h.tokenFor(user, "user"), V2);
    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"), V2);
    await h.sleep(100);

    await userSock.emitAck("session:request", { astrologerId: String(astro._id), type: "CHAT" });
    const incoming = await astroSock.waitFor("session:incoming");

    const device = await newDeviceClock(300000); // 5 minutes fast
    const left = await withSkew(device.skewMs, async () => {
        device.mod.syncServerClock(incoming.serverNow);
        return device.mod.secondsUntil(incoming.expiresAt);
    });
    assert.ok(left >= 29 && left <= 30, `a 30s request must show ~30s, not ${left}`);

    // 10 server-seconds later it shows ~20
    const later = await withSkew(device.skewMs + 10000, () => device.mod.secondsUntil(incoming.expiresAt));
    assert.ok(later >= 19 && later <= 20, `expected ~20, got ${later}`);
    // past the deadline it never goes negative
    assert.equal(await withSkew(device.skewMs + 60000, () => device.mod.secondsUntil(incoming.expiresAt)), 0);
});

test("the summary the astrologer sees equals what the server settled, for every payload shape the backend sends", async () => {
    const user = await h.createUser({ walletBalance: 5000 });
    const astro = await h.createAstrologer({ consultationFee: 25 });
    await h.createAdmin();
    const userSock = await rt.connect(h.tokenFor(user, "user"), V2);
    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"), V2);
    await h.sleep(100);

    const r = await userSock.emitAck("session:request", { astrologerId: String(astro._id), type: "VIDEO" });
    const id = r.session.sessionId;
    await astroSock.emitAck("session:accept", { sessionId: id });
    await userSock.emitAck("session:media_ready", { sessionId: id });
    await astroSock.emitAck("session:media_ready", { sessionId: id });
    const back = new Date(Date.now() - 245000); // a 4m05s call
    await Session.updateOne({ _id: id }, { $set: { startedAt: back, startTime: back, originalStartedAt: back } });

    await userSock.emitAck("session:end", { sessionId: id });
    const ended = await astroSock.waitFor("session:ended");
    const stored = await Session.findById(id).lean();
    const { buildSessionSummary, extractServerFinal } = summaryModule;

    // 1. the new session:ended payload (as the astrologer's socket layer maps it)
    const mapped = {
        success: true, ...ended,
        totalDurationSeconds: ended.durationSeconds, totalAmountDeducted: ended.totalCost, astrologerEarnings: ended.earnings,
        session: { _id: ended.sessionId, status: ended.status, settled: ended.settled, totalDurationSeconds: ended.durationSeconds, totalAmountDeducted: ended.totalCost, astrologerEarnings: ended.earnings, platformFee: ended.platformFee }
    };
    const fromEvent = buildSessionSummary({ clientName: "U", type: "Video Call", payloads: [mapped], fallbackSeconds: 1, ratePerMinute: 1 });
    assert.equal(fromEvent.estimated, false);
    assert.equal(fromEvent.totalDeducted, stored.totalAmountDeducted.toFixed(2));
    assert.equal(fromEvent.earnings, stored.astrologerEarnings.toFixed(2));
    assert.equal(fromEvent.platformFee, stored.platformFee.toFixed(2));
    assert.equal(fromEvent.duration, `${String(Math.floor(stored.totalDurationSeconds / 60)).padStart(2, "0")}:${String(stored.totalDurationSeconds % 60).padStart(2, "0")}`);

    // 2. the REST end response (a second End returns the same result)
    const app = require("../src/app");
    const server = app.listen(0);
    try {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/video-session/end/${id}`, {
            method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${h.tokenFor(astro, "astrologer")}` }, body: "{}"
        }).then((x) => x.json());
        const fromRest = buildSessionSummary({ clientName: "U", type: "Video Call", payloads: [null, res], fallbackSeconds: 1, ratePerMinute: 1 });
        assert.deepEqual({ ...fromRest }, { ...fromEvent }, "REST and event agree");
    } finally {
        server.close();
    }

    // 3. a legacy session document
    const fromLegacy = buildSessionSummary({ clientName: "U", type: "Video Call", payloads: [{ session: stored }], fallbackSeconds: 1, ratePerMinute: 1 });
    assert.equal(fromLegacy.totalDeducted, fromEvent.totalDeducted);
    assert.equal(fromLegacy.estimated, false);

    // 4. nothing usable from the server: a clearly marked estimate, never presented as final
    const estimate = buildSessionSummary({ clientName: "U", type: "Video Call", payloads: [null, { success: true }], fallbackSeconds: 120, ratePerMinute: 25 });
    assert.equal(estimate.estimated, true);
    assert.equal(estimate.totalDeducted, "50.00");
    assert.equal(extractServerFinal({ status: "PENDING", totalCost: 5, durationSeconds: 3 }), null, "an unfinished session is not a final result");
});
