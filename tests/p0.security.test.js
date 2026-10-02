/**
 * P0 security fixes:
 *  - /astro/create can no longer be used by anonymous callers to rewrite another astrologer (or their password)
 *  - customers cannot be created without OTP verification
 *  - OTP: per-number cooldown, wrong-guess cap, single use, hashed at rest
 *  - a customer cannot edit money fields through PUT /user/profile
 *  - uploads need a signed-in user and only accept images
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const h = require("./helpers/harness");

let mongo;
let server;
let base;
let User;
let Otp;
let Astrologer;
let authService;
let fast2sms;
let lastOtp;

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
    Otp = require("../src/models/otp.model");
    Astrologer = require("../src/models/astro.model");
    authService = require("../src/services/auth.service");
    fast2sms = require("../src/services/fast2sms.service");
    // capture the code instead of sending a WhatsApp message
    fast2sms.sendOtp = async (phone, otp) => { lastOtp = String(otp); return { success: true }; };

    const app = express();
    app.use(express.json());
    app.use("/api", require("../src/routes"));
    app.use(require("../src/middlewares/error.middleware"));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
    await new Promise((r) => server.close(r));
    await mongo.stop();
});

beforeEach(async () => {
    await h.resetData();
    lastOtp = null;
});

// ---------------------------------------------------------------------------------------------
// astrologer profile
// ---------------------------------------------------------------------------------------------

test("/astro/create needs a signed-in astrologer (or an admin), never an anonymous caller", async () => {
    const victim = await h.createAstrologer({ email: "victim@test.dev", name: "Victim" });
    const attack = { email: "victim@test.dev", password: "hacked-pass", name: "Pwned", consultationFee: 1 };

    assert.equal((await call("/astro/create", { method: "POST", body: attack })).status, 401);

    const user = await h.createUser();
    assert.equal((await call("/astro/create", { method: "POST", token: h.tokenFor(user, "user"), body: attack })).status, 403);

    const after = await Astrologer.findById(victim._id).lean();
    assert.equal(after.name, "Victim");
});

test("an astrologer saves only their own profile and cannot change email or password through it", async () => {
    const bcryptHash = await bcrypt.hash("original", 4);
    const me = await h.createAstrologer({ email: "me@test.dev", name: "Me", password: bcryptHash });
    const other = await h.createAstrologer({ email: "other@test.dev", name: "Other" });

    const res = await call("/astro/create", {
        method: "POST",
        token: h.tokenFor(me, "astrologer"),
        body: { name: "Me Renamed", email: "other@test.dev", password: "new-pass", astrologerId: String(other._id), astrologerLogin: String(other._id) }
    });
    assert.equal(res.status, 200);

    const mine = await Astrologer.findById(me._id).lean();
    const theirs = await Astrologer.findById(other._id).lean();
    assert.equal(mine.name, "Me Renamed");
    assert.equal(mine.email, "me@test.dev");
    assert.equal(mine.password, bcryptHash);
    assert.equal(theirs.name, "Other");
    assert.equal(await Astrologer.countDocuments(), 2);
});

// ---------------------------------------------------------------------------------------------
// customer registration
// ---------------------------------------------------------------------------------------------

test("customers cannot be registered without an OTP", async () => {
    for (const p of ["/user/register", "/user/create"]) {
        const r = await call(p, { method: "POST", body: { phone: "9876543210", name: "Squatter" } });
        assert.ok([401, 404].includes(r.status), `${p} answered ${r.status}`);
    }
    assert.equal(await User.countDocuments(), 0);
});

// ---------------------------------------------------------------------------------------------
// OTP
// ---------------------------------------------------------------------------------------------

test("OTP is stored hashed, works once, and a replay is rejected", async () => {
    await authService.sendOtp("9876500001");
    assert.match(lastOtp, /^\d{6}$/);
    const record = await Otp.findOne({ phone: "9876500001" }).lean();
    assert.notEqual(record.otp, lastOtp);

    const ok = await authService.verifyOtp("9876500001", lastOtp);
    assert.ok(ok.token && ok.refreshToken);
    await assert.rejects(() => authService.verifyOtp("9876500001", lastOtp), (e) => e.status === 400);
});

test("five wrong guesses burn the code, even if the right one is sent afterwards", async () => {
    await authService.sendOtp("9876500002");
    const right = lastOtp;
    const wrong = right === "111111" ? "222222" : "111111";

    for (let i = 0; i < 5; i++) {
        await assert.rejects(() => authService.verifyOtp("9876500002", wrong), (e) => e.status === 400);
    }
    await assert.rejects(() => authService.verifyOtp("9876500002", right), (e) => e.status === 429);
    assert.equal(await Otp.countDocuments({ phone: "9876500002" }), 0);
    assert.equal(await User.countDocuments({ phone: "9876500002" }), 0);
});

test("parallel guesses cannot beat the attempt limit", async () => {
    await authService.sendOtp("9876500003");
    const right = lastOtp;
    const wrong = right === "111111" ? "222222" : "111111";

    const results = await Promise.allSettled(Array.from({ length: 30 }, () => authService.verifyOtp("9876500003", wrong)));
    assert.ok(results.every((r) => r.status === "rejected"));
    await assert.rejects(() => authService.verifyOtp("9876500003", right));
});

test("a number cannot be flooded: resend cooldown and a cap per window", async () => {
    await authService.sendOtp("9876500004");
    await assert.rejects(() => authService.sendOtp("9876500004"), (e) => e.status === 429);

    // pretend the cooldown has passed each time, until the per-window cap is reached
    for (let i = 0; i < 4; i++) {
        await Otp.updateOne({ phone: "9876500004" }, { $set: { lastSentAt: new Date(Date.now() - 60000) } });
        await authService.sendOtp("9876500004").catch((e) => { assert.equal(e.status, 429); });
    }
    await Otp.updateOne({ phone: "9876500004" }, { $set: { lastSentAt: new Date(Date.now() - 60000) } });
    await assert.rejects(() => authService.sendOtp("9876500004"), (e) => e.status === 429);
});

test("a phone sent as an object is rejected, not used as a query", async () => {
    await assert.rejects(() => authService.verifyOtp({ $ne: null }, "123456"), (e) => e.status === 400);
    await assert.rejects(() => authService.sendOtp({ $ne: null }), (e) => e.status === 400);
});

// ---------------------------------------------------------------------------------------------
// profile + uploads
// ---------------------------------------------------------------------------------------------

test("a customer cannot raise their own bonus or wallet through PUT /user/profile", async () => {
    const user = await h.createUser({ walletBalance: 100, bonusBalance: 0, phone: "9876500010" });
    const token = h.tokenFor(user, "user");

    const res = await call("/user/profile", {
        method: "PUT",
        token,
        body: { name: "New Name", bonusBalance: 99999, walletBalance: 99999, settledSessions: [], role: "admin", phone: "1111111111" }
    });
    assert.equal(res.status, 200);

    const fresh = await User.findById(user._id).lean();
    assert.equal(fresh.name, "New Name");
    assert.equal(fresh.bonusBalance, 0);
    assert.equal(fresh.walletBalance, 100);
    assert.equal(fresh.role, "user");
    assert.equal(fresh.phone, "9876500010");
});

test("uploads need a signed-in user and only accept images", async () => {
    assert.equal((await call("/upload/image", { method: "POST" })).status, 401);
    assert.equal((await call("/upload/base64", { method: "POST", body: { image: "data:image/png;base64,AAAA" } })).status, 401);

    const user = await h.createUser();
    const token = h.tokenFor(user, "user");
    const notImage = await call("/upload/base64", { method: "POST", token, body: { image: "data:text/html;base64,PHNjcmlwdD4=" } });
    assert.equal(notImage.status, 400);
    const nothing = await call("/upload/base64", { method: "POST", token, body: {} });
    assert.equal(nothing.status, 400);
});
