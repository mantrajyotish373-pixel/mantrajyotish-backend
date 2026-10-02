const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const h = require("./helpers/harness");

let mongo;
let server;
let base;
let Admin;
let Astrologer;

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
    Admin = require("../src/models/admin.model");
    Astrologer = require("../src/models/astro.model");
    const app = express();
    app.use(express.json());
    app.use("/api", require("../src/routes"));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
    await new Promise((r) => server.close(r));
    await mongo.stop();
});

test("admin login issues access + refresh token, refresh works, logout revokes it", async () => {
    await Admin.create({ name: "A", email: "a@x.com", password: await bcrypt.hash("password123", 10), role: "superadmin" });

    const login = await call("/admin/login", { method: "POST", body: { email: "a@x.com", password: "password123" } });
    assert.equal(login.status, 200);
    const { token, refreshToken } = login.json.data;
    assert.ok(token && refreshToken);

    assert.equal((await call("/admin/profile", { token })).status, 200);

    const refreshed = await call("/admin/refresh", { method: "POST", body: { refreshToken } });
    assert.equal(refreshed.status, 200);
    assert.equal((await call("/admin/profile", { token: refreshed.json.data.token })).status, 200);

    assert.equal((await call("/admin/refresh", { method: "POST", body: { refreshToken: "bogus" } })).status, 401);

    await call("/admin/logout", { method: "POST", body: { refreshToken } });
    assert.equal((await call("/admin/refresh", { method: "POST", body: { refreshToken } })).status, 401);
});

test("payment and appointment data now require an admin", async () => {
    for (const p of ["/payment/all", "/payment/abc", "/appointment/all", "/appointment/abc"]) {
        assert.equal((await call(p)).status, 401, p);
    }
    assert.equal((await call("/payment/create", { method: "POST", body: { amount: 1 } })).status, 401);
    assert.equal((await call("/payment/update/abc", { method: "PUT", body: { status: "paid" } })).status, 401);

    const { token } = (await call("/admin/login", { method: "POST", body: { email: "a@x.com", password: "password123" } })).json.data;
    assert.equal((await call("/payment/all", { token })).status, 200);
});

test("public astrologer endpoints never leak secrets or non-approved profiles", async () => {
    await Astrologer.create({ name: "Ok", email: "ok@x.com", phone: "9000000001", password: "$2b$10$hash", status: "approved", walletBalance: 500 });
    await Astrologer.create({ name: "Pending", email: "p@x.com", phone: "9000000002", password: "$2b$10$hash", status: "pending" });

    const res = await call("/astro/all?status=all");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.data.map((a) => a.name), ["Ok"]);
    const a = res.json.data[0];
    for (const k of ["password", "email", "phone", "walletBalance"]) assert.equal(a[k], undefined, k);

    const one = await call(`/astro/${a._id}`);
    for (const k of ["password", "email", "phone", "walletBalance"]) assert.equal(one.json.data[k], undefined, k);

    const { token } = (await call("/admin/login", { method: "POST", body: { email: "a@x.com", password: "password123" } })).json.data;
    const adminView = await call("/astro/all?status=all", { token });
    assert.equal(adminView.json.data.length, 2);
    assert.equal(adminView.json.data[0].password, undefined);
    assert.ok(adminView.json.data.some((x) => x.email === "p@x.com"));
});

test("a deleted admin's token stops working and login is rate limited", async () => {
    const { token } = (await call("/admin/login", { method: "POST", body: { email: "a@x.com", password: "password123" } })).json.data;
    await Admin.deleteMany({});
    assert.equal((await call("/admin/profile", { token })).status, 401);

    let last;
    for (let i = 0; i < 12; i++) last = await call("/admin/login", { method: "POST", body: { email: "a@x.com", password: "wrong" } });
    assert.equal(last.status, 429);
});
