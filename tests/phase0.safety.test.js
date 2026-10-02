/**
 * Phase 0: five confirmed safety fixes in the CURRENT code, before any redesign.
 *   1. no global io.emit("call_accepted")
 *   2. no wrong-astrologer fallback
 *   3. reject/cancel socket handlers no longer crash
 *   4. chat sender cannot be impersonated over the socket
 *   5. no per-session timer leak when accept paths start billing twice
 */
const { test, before, after, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const h = require("./helpers/harness");

let mongo;
let rt;

before(async () => {
    mongo = await h.startMongo();
    rt = await h.startRealtime();
});

after(async () => {
    require("../src/services/sessionEngine.service").stopAllSessionBillingTimers();
    await rt.stop();
    await mongo.stop();
});

beforeEach(async () => {
    await h.resetData();
});

afterEach(() => {
    require("../src/services/sessionEngine.service").stopAllSessionBillingTimers();
});

test("1. call_accepted is never broadcast globally; the participants still receive it", async () => {
    const engine = require("../src/services/session/engine");
    const controller = require("../src/controllers/videoSession.controller");

    const user = await h.createUser();
    const outsider = await h.createUser();
    const astro = await h.createAstrologer();

    const userSock = await rt.connect(h.tokenFor(user, "user"));
    const outsiderSock = await rt.connect(h.tokenFor(outsider, "user"));
    await h.sleep(100);

    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "AUDIO" });

    const res = { status: () => res, json: () => res };
    await controller.acceptCall({ params: { id: String(session._id) }, body: {}, user: { userId: String(astro._id), role: "astrologer" } }, res);

    const payload = await userSock.waitFor("call_accepted", 2000);
    assert.equal(String(payload.sessionId), String(session._id));
    await h.sleep(300);
    assert.equal(outsiderSock.has("call_accepted"), false, "an unrelated connected client received call_accepted (Agora token leak)");
});

test("2. an unknown astrologer id is rejected instead of silently binding to another astrologer", async () => {
    const engine = require("../src/services/session/engine");
    const facade = require("../src/services/sessionEngine.service");
    const user = await h.createUser();
    await h.createAstrologer(); // a real astrologer exists that the old fallback would have picked

    assert.equal(await facade.findAstrologerByIdOrRef(String(new mongoose.Types.ObjectId())), null);
    await assert.rejects(
        engine.requestSession({ userId: String(user._id), astrologerId: String(new mongoose.Types.ObjectId()), type: "AUDIO" }),
        (e) => e.code === "ASTROLOGER_NOT_FOUND"
    );
    const Session = require("../src/models/session.model");
    assert.equal(await Session.countDocuments({}), 0);
});

test("3a. astrologer rejecting a chat request notifies the user (handler no longer crashes)", async () => {
    const ChatSession = require("../src/models/chatSession.model");
    const Session = require("../src/models/session.model");
    const user = await h.createUser();
    const astro = await h.createAstrologer();
    const chat = await ChatSession.create({ user: user._id, astrologer: astro._id, perMinuteRate: 9, status: "PENDING" });
    await Session.create({ _id: chat._id, type: "CHAT", user: user._id, astrologer: astro._id, status: "PENDING", perMinuteRate: 9 });

    const userSock = await rt.connect(h.tokenFor(user, "user"));
    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"));
    userSock.emit("register_user", { userId: String(user._id) });
    astroSock.emit("register_astrologer", { astrologerId: String(astro._id) });
    await h.sleep(200);

    astroSock.emit("reject_chat_request", { sessionId: String(chat._id), reason: "busy" });
    const payload = await userSock.waitFor("chat_rejected", 2000);
    assert.equal(String(payload.sessionId), String(chat._id));

    const unified = await Session.findById(chat._id);
    assert.equal(unified.status, "REJECTED");
});

test("3b. user cancelling a chat request notifies the astrologer (handler no longer crashes)", async () => {
    const ChatSession = require("../src/models/chatSession.model");
    const Session = require("../src/models/session.model");
    const user = await h.createUser();
    const astro = await h.createAstrologer();
    const chat = await ChatSession.create({ user: user._id, astrologer: astro._id, perMinuteRate: 9, status: "PENDING" });
    await Session.create({ _id: chat._id, type: "CHAT", user: user._id, astrologer: astro._id, status: "PENDING", perMinuteRate: 9 });

    const userSock = await rt.connect(h.tokenFor(user, "user"));
    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"));
    userSock.emit("register_user", { userId: String(user._id) });
    astroSock.emit("register_astrologer", { astrologerId: String(astro._id) });
    await h.sleep(200);

    userSock.emit("cancel_chat_request", { sessionId: String(chat._id) });
    const payload = await astroSock.waitFor("request_cancelled", 2000);
    assert.equal(String(payload.sessionId), String(chat._id));

    const unified = await Session.findById(chat._id);
    assert.equal(unified.status, "CANCELLED");
});

test("4. a user cannot post a chat message as the astrologer", async () => {
    const ChatSession = require("../src/models/chatSession.model");
    const ChatMessage = require("../src/models/chatMessage.model");
    const user = await h.createUser();
    const astro = await h.createAstrologer();
    const chat = await ChatSession.create({ user: user._id, astrologer: astro._id, perMinuteRate: 9, status: "ACTIVE", startTime: new Date() });

    const userSock = await rt.connect(h.tokenFor(user, "user"));
    userSock.emit("register_user", { userId: String(user._id) });
    userSock.emit("join_session", { sessionId: String(chat._id) });
    await h.sleep(200);

    userSock.emit("send_message", {
        sessionId: String(chat._id),
        text: "pretending to be the astrologer",
        senderType: "ASTROLOGER",
        senderId: String(astro._id)
    });
    const delivered = await userSock.waitFor("receive_message", 2000);
    assert.equal(delivered.senderType, "USER");

    const stored = await ChatMessage.findOne({ session: chat._id });
    assert.equal(stored.senderType, "USER");
    assert.equal(String(stored.senderId), String(user._id));
});

test("4b. the astrologer's own messages are still attributed to the astrologer", async () => {
    const ChatSession = require("../src/models/chatSession.model");
    const ChatMessage = require("../src/models/chatMessage.model");
    const user = await h.createUser();
    const astro = await h.createAstrologer();
    const chat = await ChatSession.create({ user: user._id, astrologer: astro._id, perMinuteRate: 9, status: "ACTIVE", startTime: new Date() });

    const astroSock = await rt.connect(h.tokenFor(astro, "astrologer"));
    astroSock.emit("register_astrologer", { astrologerId: String(astro._id) });
    astroSock.emit("join_session", { sessionId: String(chat._id) });
    await h.sleep(200);

    // payload claims to be the user; the authenticated identity wins
    astroSock.emit("send_message", { sessionId: String(chat._id), text: "hello", senderType: "USER" });
    const delivered = await astroSock.waitFor("receive_message", 2000);
    assert.equal(delivered.senderType, "ASTROLOGER");
    const stored = await ChatMessage.findOne({ session: chat._id });
    assert.equal(String(stored.senderId), String(astro._id));
});

test("5. the engine creates no per-session timers: N sessions, zero timers from engine code", async () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const engine = require("../src/services/session/engine");

    // structural: no timer calls anywhere in the lifecycle modules; exactly one loop in the scheduler
    const dir = path.join(__dirname, "../src/services/session");
    for (const file of ["engine.js", "settlement.js", "handlers.js", "realtime.js", "availability.js", "legacyMirror.js"]) {
        const src = fs.readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
        assert.ok(!/\b(setTimeout|setInterval)\s*\(/.test(src), `${file} must not create timers`);
    }
    const sched = fs.readFileSync(path.join(dir, "scheduler.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.equal((sched.match(/\bsetInterval\s*\(/g) || []).length, 1, "the scheduler is a single loop");
    assert.ok(!/\bsetTimeout\s*\(/.test(sched));

    // runtime: accepting many sessions starts no timer from engine code
    const spied = [];
    const realSetTimeout = global.setTimeout;
    const realSetInterval = global.setInterval;
    const spy = (real) => function (...args) {
        if (new Error().stack.includes("/src/services/session/")) spied.push(args[1]);
        return real.apply(this, args);
    };
    global.setTimeout = spy(realSetTimeout);
    global.setInterval = spy(realSetInterval);
    try {
        for (let i = 0; i < 8; i += 1) {
            const user = await h.createUser({ walletBalance: 500 });
            const astro = await h.createAstrologer();
            const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "CHAT" });
            await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro) });
        }
    } finally {
        global.setTimeout = realSetTimeout;
        global.setInterval = realSetInterval;
    }
    assert.deepEqual(spied, [], "8 active sessions must not create any timer");
});
