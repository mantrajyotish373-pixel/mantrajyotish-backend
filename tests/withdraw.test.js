const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const h = require("./helpers/harness");

let mongo, server, base, Admin, Astrologer, Payout, su;
const call = async (path, { method = "GET", token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
};

before(async () => {
    mongo = await h.startMongo();
    Admin = require("../src/models/admin.model");
    Astrologer = require("../src/models/astro.model");
    Payout = require("../src/models/payout.model");
    const app = express(); app.use(express.json()); app.use("/api", require("../src/routes"));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api`;
    await Admin.create({ name: "Boss", email: "boss@x.com", password: await bcrypt.hash("password123", 10), role: "superadmin" });
    su = (await call("/admin/login", { method: "POST", body: { email: "boss@x.com", password: "password123" } })).json.data.token;
});
after(async () => { await new Promise((r) => server.close(r)); await mongo.stop(); });

const mkPayout = async (amount = 500) => {
    const astro = await Astrologer.create({ name: "Ast", email: `a${Date.now()}${Math.random()}@x.com`, phone: String(9000000000 + Math.floor(Math.random() * 99999999)), status: "approved", walletBalance: 100 });
    const p = await Payout.create({ astrologer: astro._id, amount, payoutMethod: "upi", upiId: "ast@upi", status: "Pending" });
    return { astro, p };
};

test("withdraw list is real data with payment details, admin-only", async () => {
    const { p } = await mkPayout(500);
    assert.equal((await call("/withdraw/all")).status, 401);
    const res = await call("/withdraw/all", { token: su });
    assert.equal(res.status, 200);
    const row = res.json.data.find((r) => r.id === String(p._id));
    assert.equal(row.status, "Pending");
    assert.equal(row.accountDetails, "UPI ID ast@upi");
});

test("approve marks paid once; wallet is not touched again", async () => {
    const { astro, p } = await mkPayout(300);
    assert.equal((await call(`/withdraw/${p._id}/approve`, { method: "POST", token: su })).status, 200);
    assert.equal((await call(`/withdraw/${p._id}/approve`, { method: "POST", token: su })).status, 409);
    assert.equal((await Payout.findById(p._id)).status, "Completed");
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 100);
});

test("reject refunds exactly once, even if clicked twice at the same time", async () => {
    const { astro, p } = await mkPayout(400);
    const rs = await Promise.all([1, 2, 3].map(() => call(`/withdraw/${p._id}/reject`, { method: "POST", token: su })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409]);
    assert.equal((await Astrologer.findById(astro._id)).walletBalance, 500); // 100 + 400 refunded once
    assert.equal((await Payout.findById(p._id)).status, "Rejected");
});

test("sub-admin needs withdrawals.view / withdrawals.manage", async () => {
    const created = await call("/admin/team", { method: "POST", token: su, body: { name: "S", email: "s@x.com", password: "password123", permissions: ["withdrawals.view"] } });
    const t = (await call("/admin/login", { method: "POST", body: { email: "s@x.com", password: "password123" } })).json.data.token;
    const { p } = await mkPayout(200);
    assert.equal((await call("/withdraw/all", { token: t })).status, 200);
    assert.equal((await call(`/withdraw/${p._id}/approve`, { method: "POST", token: t })).status, 403);
    await call(`/admin/team/${created.json.data._id}`, { method: "PUT", token: su, body: { permissions: ["withdrawals.view", "withdrawals.manage"] } });
    assert.equal((await call(`/withdraw/${p._id}/approve`, { method: "POST", token: t })).status, 200);
});

test("bookings endpoint returns a list for admins", async () => {
    const res = await call("/admin/bookings", { token: su });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.data));
    assert.equal((await call("/admin/bookings")).status, 401);
});
