const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const h = require("./helpers/harness");

let mongo, server, base, User, Astrologer, Notification, jwt;
let u1, u2, a1, a2, t1, t2, tAstro;

const call = async (path, { method = "GET", token, body } = {}) => {
    const res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
};

before(async () => {
    mongo = await h.startMongo();
    User = require("../src/models/user.model");
    Astrologer = require("../src/models/astro.model");
    Notification = require("../src/models/notification.model");
    jwt = require("../src/utils/jwt");
    const app = express();
    app.use(express.json());
    app.use("/api", require("../src/routes"));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api`;

    u1 = await User.create({ name: "Asha", phone: "9000000001", role: "user" });
    u2 = await User.create({ name: "Ravi", phone: "9000000002", role: "user" });
    a1 = await Astrologer.create({ name: "Pandit One", email: "one@x.com", phone: "9100000001", status: "approved" });
    a2 = await Astrologer.create({ name: "Pandit Two", email: "two@x.com", phone: "9100000002", status: "approved" });
    t1 = jwt.generateToken({ userId: String(u1._id), role: "user" });
    t2 = jwt.generateToken({ userId: String(u2._id), role: "user" });
    tAstro = jwt.generateToken({ userId: String(a1._id), role: "astrologer" });
});

after(async () => {
    await new Promise((r) => server.close(r));
    await mongo.stop();
});

test("follow needs login and a user account", async () => {
    assert.equal((await call(`/follow/${a1._id}`, { method: "POST" })).status, 401);
    assert.equal((await call(`/follow/${a1._id}`, { method: "POST", token: tAstro })).status, 403);
});

test("follow is idempotent and keeps the follower count right", async () => {
    let r = await call(`/follow/${a1._id}`, { method: "POST", token: t1 });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.followersCount, 1);
    r = await call(`/follow/${a1._id}`, { method: "POST", token: t1 }); // again: no double count
    assert.equal(r.json.data.followersCount, 1);
    r = await call(`/follow/${a1._id}`, { method: "POST", token: t2 });
    assert.equal(r.json.data.followersCount, 2);
    assert.equal((await Astrologer.findById(a1._id)).followersCount, 2);
});

test("unfollow lowers the count once and never goes below zero", async () => {
    let r = await call(`/follow/${a1._id}`, { method: "DELETE", token: t2 });
    assert.equal(r.json.data.followersCount, 1);
    r = await call(`/follow/${a1._id}`, { method: "DELETE", token: t2 }); // already unfollowed
    assert.equal(r.json.data.followersCount, 1);
    await call(`/follow/${a2._id}`, { method: "DELETE", token: t2 }); // never followed
    assert.equal((await Astrologer.findById(a2._id)).followersCount, 0);
});

test("my following list, ids and bad input", async () => {
    await call(`/follow/${a2._id}`, { method: "POST", token: t1 });
    const list = await call("/follow", { token: t1 });
    assert.deepEqual(list.json.data.map((a) => a.name).sort(), ["Pandit One", "Pandit Two"]);
    const ids = await call("/follow/ids", { token: t1 });
    assert.deepEqual(ids.json.data.sort(), [String(a1._id), String(a2._id)].sort());
    assert.equal((await call("/follow/not-an-id", { method: "POST", token: t1 })).status, 400);
    assert.equal((await call(`/follow/${new (require("mongoose").Types.ObjectId)()}`, { method: "POST", token: t1 })).status, 404);
});

test("astrologer sees their own followers", async () => {
    const r = await call("/follow/followers", { token: tAstro });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.total, 1);
    assert.equal(r.json.data.followers[0].name, "Asha");
    // a plain user is not an astrologer
    assert.equal((await call("/follow/followers", { token: t1 })).status, 403);
});

test("notifyFollowers sends one inbox item per follower, once per cooldown", async () => {
    const svc = require("../src/services/notification.service");
    let r = await svc.notifyFollowers(a1._id, "astro_live");
    assert.equal(r.sent, 1);
    r = await svc.notifyFollowers(a1._id, "astro_live"); // inside the cooldown
    assert.equal(r.sent, 0);
    assert.equal((await svc.notifyFollowers(a2._id, "astro_live")).sent, 1);
});

test("notification inbox: list, unread count, mark read", async () => {
    const list = await call("/notifications", { token: t1 });
    assert.equal(list.json.items.length, 2);
    assert.equal(list.json.unread, 2);
    assert.match(list.json.items[0].title, /live now/);
    assert.ok(list.json.items[0].data.astroId);
    assert.equal((await call("/notifications/unread-count", { token: t1 })).json.unread, 2);

    await call("/notifications/read", { method: "POST", token: t1, body: { ids: [list.json.items[0]._id] } });
    assert.equal((await call("/notifications/unread-count", { token: t1 })).json.unread, 1);
    await call("/notifications/read", { method: "POST", token: t1, body: {} });
    assert.equal((await call("/notifications/unread-count", { token: t1 })).json.unread, 0);
    // another user's inbox is separate
    assert.equal((await call("/notifications", { token: t2 })).json.items.length, 0);
    assert.equal((await Notification.countDocuments({ user: u1._id })), 2);
});

test("astrologer reviews are paged, with total and average", async () => {
    const ChatSession = require("../src/models/chatSession.model");
    const VideoSession = require("../src/models/videoSession.model");
    const base = Date.now();
    // 7 rated chats (ratings 5,4,5,4,5,4,5) and 3 rated calls (3,3,3) for a1
    for (let i = 0; i < 7; i++) {
        await ChatSession.collection.insertOne({ astrologer: a1._id, user: u1._id, rating: i % 2 ? 4 : 5, review: `chat ${i}`, createdAt: new Date(base - i * 60000) });
    }
    for (let i = 0; i < 3; i++) {
        await VideoSession.collection.insertOne({ astrologer: a1._id, user: u2._id, rating: 3, review: `call ${i}`, callType: "AUDIO", createdAt: new Date(base - (i + 0.5) * 60000) });
    }
    // an unrated one must not count
    await ChatSession.collection.insertOne({ astrologer: a1._id, user: u1._id, rating: null, createdAt: new Date(base) });

    const p1 = await call(`/astro/reviews/${a1._id}?page=1&limit=4`);
    assert.equal(p1.status, 200);
    assert.equal(p1.json.data.length, 4);
    assert.equal(p1.json.total, 10);
    assert.equal(p1.json.hasMore, true);
    assert.equal(p1.json.avgRating, 4.1); // (5+4+5+4+5+4+5 = 32, plus 3+3+3 = 9) / 10 = 4.1

    const p3 = await call(`/astro/reviews/${a1._id}?page=3&limit=4`);
    assert.equal(p3.json.data.length, 2);
    assert.equal(p3.json.hasMore, false);

    // pages never repeat a review and together cover all 10, newest first
    const p2 = await call(`/astro/reviews/${a1._id}?page=2&limit=4`);
    const ids = [...p1.json.data, ...p2.json.data, ...p3.json.data].map((r) => String(r.id));
    assert.equal(new Set(ids).size, 10);
    const times = [...p1.json.data, ...p2.json.data, ...p3.json.data].map((r) => new Date(r.createdAt).getTime());
    assert.deepEqual(times, [...times].sort((x, y) => y - x));

    // old callers (no limit) still get everything
    const all = await call(`/astro/reviews/${a1._id}`);
    assert.equal(all.json.data.length, 10);
    // bad input
    assert.equal((await call(`/astro/reviews/not-an-id`)).status, 400);
    assert.equal((await call(`/astro/reviews/${a2._id}?limit=1000`)).json.limit, 50);
});

test("astrologer stats: completed orders and free/paid minutes by type", async () => {
    const Session = require("../src/models/session.model");
    const mk = (over) => Session.collection.insertOne({
        user: u1._id, astrologer: a2._id, perMinuteRate: 9, status: "COMPLETED", totalDurationSeconds: 0, promoSeconds: 0, createdAt: new Date(), ...over
    });
    // a2: 2 chats (300s with 60s free, 120s), 1 audio (600s, 600s free), 1 video (180s)
    await mk({ type: "CHAT", totalDurationSeconds: 300, promoSeconds: 60 });
    await mk({ type: "CHAT", totalDurationSeconds: 120 });
    await mk({ type: "AUDIO", totalDurationSeconds: 600, promoSeconds: 600 });
    await mk({ type: "VIDEO", totalDurationSeconds: 180 });
    // must NOT count: cancelled, no billed time, and someone else's session
    await mk({ type: "CHAT", status: "CANCELLED", totalDurationSeconds: 500 });
    await mk({ type: "VIDEO", totalDurationSeconds: 0 });
    await mk({ type: "AUDIO", astrologer: a1._id, totalDurationSeconds: 900 });

    const r = await call(`/astro/stats/${a2._id}`);
    assert.equal(r.status, 200);
    const d = r.json.data;
    assert.deepEqual(d.rates, { chat: 9, audio: 9, video: 9 }); // no fee set: everything bills at 9
    assert.equal(d.orders, 4);
    assert.deepEqual(d.chat, { count: 2, seconds: 420 });
    assert.deepEqual(d.audio, { count: 1, seconds: 600 });
    assert.deepEqual(d.video, { count: 1, seconds: 180 });
    assert.equal(d.totalSeconds, 1200);
    assert.equal(d.freeSeconds, 660);
    assert.equal(d.paidSeconds, 540);

    // chat is always a flat 9; calls bill at the astrologer's own consultationFee
    const a3 = await Astrologer.create({ name: "Pandit Three", email: "three@x.com", phone: "9100000003", status: "approved", consultationFee: 25 });
    const priced = await call(`/astro/stats/${a3._id}`);
    assert.deepEqual(priced.json.data.rates, { chat: 9, audio: 25, video: 25 });

    // an astrologer with nothing completed gets zeros, and a bad id is rejected
    const none = await call(`/astro/stats/${new (require("mongoose").Types.ObjectId)()}`);
    assert.equal(none.json.data.orders, 0);
    assert.equal(none.json.data.totalSeconds, 0);
    assert.equal((await call(`/astro/stats/nope`)).status, 400);
});

test("follow rate limit is per user, not shared by everyone on one IP", async () => {
    // user 1 spams until limited; user 2 (same IP) is unaffected
    let limited = false;
    for (let i = 0; i < 70 && !limited; i++) {
        const r = await call(`/follow/${a2._id}`, { method: "POST", token: t1 });
        if (r.status === 429) limited = true;
    }
    assert.equal(limited, true);
    const other = await call(`/follow/${a2._id}`, { method: "POST", token: t2 });
    assert.equal(other.status, 200);
});

test("astrologer list carries each astrologer's completed order count", async () => {
    const list = await call("/astro/all");
    assert.equal(list.status, 200);
    const by = Object.fromEntries(list.json.data.map((a) => [a.name, a.completedOrders]));
    assert.equal(by["Pandit Two"], 4);   // from the stats test above
    assert.equal(by["Pandit One"], 1);   // one completed audio session was inserted for a1
    assert.equal(by["Pandit Three"], 0);
});
