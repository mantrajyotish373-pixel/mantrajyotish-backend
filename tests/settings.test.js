const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const h = require("./helpers/harness");

let mongo, server, base, Admin;
const call = async (path, { method = "GET", token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
};
const login = async (email, password) => (await call("/api/admin/login", { method: "POST", body: { email, password } })).json.data;

before(async () => {
    mongo = await h.startMongo();
    Admin = require("../src/models/admin.model");
    const app = express(); app.use(express.json());
    app.use(require("../src/middlewares/maintenance.middleware"));
    app.use("/api", require("../src/routes"));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}`;
    await Admin.create({ name: "Boss", email: "boss@x.com", password: await bcrypt.hash("password123", 10), role: "superadmin" });
});
after(async () => { await new Promise((r) => server.close(r)); await mongo.stop(); });

test("admin edits own name and phone with validation", async () => {
    const { token } = await login("boss@x.com", "password123");
    assert.equal((await call("/api/admin/profile", { method: "PUT", token, body: { phone: "abc" } })).status, 400);
    assert.equal((await call("/api/admin/profile", { method: "PUT", token, body: { name: "A" } })).status, 400);
    const ok = await call("/api/admin/profile", { method: "PUT", token, body: { name: "Big Boss", phone: "+91 98765 43210" } });
    assert.equal(ok.status, 200);
    const me = (await call("/api/admin/profile", { token })).json.data;
    assert.equal(me.name, "Big Boss");
    assert.equal(me.phone, "+91 98765 43210");
});

test("login sessions are real, listed with current flag, and revocable", async () => {
    const a = await login("boss@x.com", "password123");
    const b = await login("boss@x.com", "password123");
    const list = await call("/api/admin/sessions", { method: "POST", token: a.token, body: { refreshToken: a.refreshToken } });
    assert.ok(list.json.data.length >= 2);
    assert.equal(list.json.data.filter((s) => s.current).length, 1);
    assert.ok(list.json.data.every((s) => s.sid && s.createdAt));

    const other = list.json.data.find((s) => !s.current);
    assert.equal((await call(`/api/admin/sessions/${other.sid}`, { method: "DELETE", token: a.token })).status, 200);
    const after1 = await call("/api/admin/sessions", { method: "POST", token: a.token, body: { refreshToken: a.refreshToken } });
    assert.equal(after1.json.data.length, list.json.data.length - 1);

    const r = await call("/api/admin/sessions/revoke-others", { method: "POST", token: a.token, body: { refreshToken: a.refreshToken } });
    assert.equal(r.status, 200);
    const after2 = await call("/api/admin/sessions", { method: "POST", token: a.token, body: { refreshToken: a.refreshToken } });
    assert.equal(after2.json.data.length, 1);
    assert.equal(after2.json.data[0].current, true);
    // a revoked device can no longer refresh
    assert.equal((await call("/api/admin/refresh", { method: "POST", body: { refreshToken: b.refreshToken } })).status, 401);
});

test("password change checks the current password and signs other devices out", async () => {
    const a = await login("boss@x.com", "password123");
    const b = await login("boss@x.com", "password123");
    const put = (body) => call("/api/admin/password", { method: "PUT", token: a.token, body });
    assert.equal((await put({ currentPassword: "wrong", newPassword: "newpassword1", refreshToken: a.refreshToken })).status, 400);
    assert.equal((await put({ currentPassword: "password123", newPassword: "short", refreshToken: a.refreshToken })).status, 400);
    assert.equal((await put({ currentPassword: "password123", newPassword: "password123", refreshToken: a.refreshToken })).status, 400);
    assert.equal((await put({ currentPassword: "password123", newPassword: "newpassword1", refreshToken: a.refreshToken })).status, 200);

    assert.equal((await call("/api/admin/login", { method: "POST", body: { email: "boss@x.com", password: "password123" } })).status, 401);
    assert.equal((await call("/api/admin/refresh", { method: "POST", body: { refreshToken: b.refreshToken } })).status, 401);   // other device out
    assert.equal((await call("/api/admin/refresh", { method: "POST", body: { refreshToken: a.refreshToken } })).status, 200);   // this device stays
    const me = (await call("/api/admin/profile", { token: a.token })).json.data;
    assert.ok(me.passwordChangedAt);
});

test("platform settings: superadmin only, validated, audited, shown publicly", async () => {
    const su = (await login("boss@x.com", "newpassword1")).token;
    await call("/api/admin/team", { method: "POST", token: su, body: { name: "S", email: "s@x.com", password: "password123", permissions: ["users.view"] } });
    const sub = (await login("s@x.com", "password123")).token;
    assert.equal((await call("/api/admin/settings", { token: sub })).status, 403);
    assert.equal((await call("/api/admin/settings", { method: "PUT", token: sub, body: { minWithdrawal: 500 } })).status, 403);
    assert.equal((await call("/api/admin/system-info", { token: sub })).status, 403);
    assert.equal((await call("/api/admin/permissions", { token: sub })).status, 403); // sub-admins cannot see the feature/permission list

    assert.equal((await call("/api/admin/settings", { method: "PUT", token: su, body: { minWithdrawal: 50 } })).status, 400);
    assert.equal((await call("/api/admin/settings", { method: "PUT", token: su, body: { supportEmail: "nope" } })).status, 400);
    const ok = await call("/api/admin/settings", { method: "PUT", token: su, body: { minWithdrawal: 500, supportEmail: "help@x.com", supportPhone: "+91 99999 11111" } });
    assert.equal(ok.status, 200);

    const pub = await call("/api/settings/public");   // no login needed
    assert.equal(pub.json.data.minWithdrawal, 500);
    assert.equal(pub.json.data.supportEmail, "help@x.com");

    await new Promise((r) => setTimeout(r, 200));
    const logs = (await call("/api/admin/audit-logs?limit=100", { token: su })).json.data.map((x) => x.action);
    assert.ok(logs.includes("settings.update"));
    assert.ok(logs.includes("auth.password_change"));
});

test("maintenance mode blocks the public API but not admins, settings page or payment webhook", async () => {
    const su = (await login("boss@x.com", "newpassword1")).token;
    await call("/api/admin/settings", { method: "PUT", token: su, body: { maintenanceMode: true, maintenanceMessage: "Back at 6pm" } });

    const blocked = await call("/api/astro/all");
    assert.equal(blocked.status, 503);
    assert.equal(blocked.json.maintenance, true);
    assert.equal(blocked.json.message, "Back at 6pm");

    assert.equal((await call("/api/settings/public")).json.data.maintenanceMode, true);
    assert.equal((await call("/api/user/all", { token: su })).status, 200);          // admin token passes
    assert.notEqual((await call("/api/razorpay/webhook", { method: "POST", body: {} })).status, 503); // webhook exempt

    await call("/api/admin/settings", { method: "PUT", token: su, body: { maintenanceMode: false } });
    assert.equal((await call("/api/astro/all")).status, 200);
});

test("system info shows real server, database and payment gateway status", async () => {
    const su = (await login("boss@x.com", "newpassword1")).token;
    const d = (await call("/api/admin/system-info", { token: su })).json.data;
    assert.equal(d.database.status, "connected");
    assert.ok(d.server.nodeVersion.startsWith("v"));
    assert.equal(d.payments.gateway, "Razorpay");
    assert.equal(d.payments.mode, "test");                       // harness uses rzp_test_dummy
    assert.ok(!JSON.stringify(d).includes("dummy_secret"));      // secret never exposed
});
