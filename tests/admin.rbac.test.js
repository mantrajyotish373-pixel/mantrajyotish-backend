const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const h = require("./helpers/harness");

let mongo, server, base, Admin, User;
let su; // super admin token

const call = async (path, { method = "GET", token, body } = {}) => {
    const res = await fetch(base + path, {
        method,
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
};
const login = async (email, password) => (await call("/admin/login", { method: "POST", body: { email, password } }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
    mongo = await h.startMongo();
    Admin = require("../src/models/admin.model");
    User = require("../src/models/user.model");
    const app = express();
    app.use(express.json());
    app.use("/api", require("../src/routes"));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api`;
    await Admin.create({ name: "Boss", email: "boss@x.com", password: await bcrypt.hash("password123", 10), role: "superadmin" });
    su = (await login("boss@x.com", "password123")).json.data.token;
});

after(async () => {
    await new Promise((r) => server.close(r));
    await mongo.stop();
});

test("superadmin builds a custom role and a sub-admin that inherits then customises permissions", async () => {
    const cat = await call("/admin/permissions", { token: su });
    assert.equal(cat.status, 200);

    const role = await call("/admin/roles", { method: "POST", token: su, body: { name: "Support", permissions: ["users.view", "dashboard.view", "bogus.perm"] } });
    assert.equal(role.status, 201);
    assert.deepEqual(role.json.data.permissions.sort(), ["dashboard.view", "users.view"]); // unknown permission dropped

    const created = await call("/admin/team", { method: "POST", token: su, body: { name: "Sam", email: "sam@x.com", password: "password123", roleId: role.json.data._id } });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.role, "admin");
    assert.deepEqual(created.json.data.permissions.sort(), ["dashboard.view", "users.view"]);

    // per-person edit after creation: add delete-user, drop dashboard
    const upd = await call(`/admin/team/${created.json.data._id}`, { method: "PUT", token: su, body: { permissions: ["users.view", "users.delete"] } });
    assert.equal(upd.status, 200);
    assert.deepEqual(upd.json.data.permissions.sort(), ["users.delete", "users.view"]);
});

test("sub-admin can only do what the permissions allow; changes apply immediately", async () => {
    const sam = (await login("sam@x.com", "password123")).json.data;
    assert.deepEqual(sam.admin.permissions.sort(), ["users.delete", "users.view"]);
    const t = sam.token;

    assert.equal((await call("/user/all", { token: t })).status, 200);          // users.view
    assert.equal((await call("/payment/all", { token: t })).status, 403);       // not granted
    assert.equal((await call("/admin/dashboard-stats", { token: t })).status, 403);
    assert.equal((await call("/admin/team", { token: t })).status, 403);        // superadmin only
    assert.equal((await call("/admin/audit-logs", { token: t })).status, 403);
    assert.equal((await call("/admin/team", { method: "POST", token: t, body: { name: "x", email: "x@x.com", password: "password123" } })).status, 403);

    const victim = await User.create({ name: "V", phone: "9111111111", email: "v@x.com", walletBalance: 0 });
    assert.equal((await call(`/user/delete/${victim._id}`, { method: "DELETE", token: t })).status, 200); // users.delete

    // revoke delete -> next request is denied with the SAME token
    const team = (await call("/admin/team", { token: su })).json.data;
    const samId = team.find((m) => m.email === "sam@x.com")._id;
    await call(`/admin/team/${samId}`, { method: "PUT", token: su, body: { permissions: ["users.view"] } });
    const victim2 = await User.create({ name: "V2", phone: "9222222222", email: "v2@x.com", walletBalance: 0 });
    assert.equal((await call(`/user/delete/${victim2._id}`, { method: "DELETE", token: t })).status, 403);
});

test("dashboard hides money figures without dashboard.financials", async () => {
    const samId = (await call("/admin/team", { token: su })).json.data.find((m) => m.email === "sam@x.com")._id;
    await call(`/admin/team/${samId}`, { method: "PUT", token: su, body: { permissions: ["dashboard.view"] } });
    const t = (await login("sam@x.com", "password123")).json.data.token;
    let d = (await call("/admin/dashboard-stats", { token: t })).json.data;
    assert.equal(d.todayRevenue, null);
    assert.equal(d.revenueChart, null);

    await call(`/admin/team/${samId}`, { method: "PUT", token: su, body: { permissions: ["dashboard.view", "dashboard.financials"] } });
    d = (await call("/admin/dashboard-stats", { token: t })).json.data;
    assert.notEqual(d.revenueChart, null);
});

test("disabling a sub-admin kills access and refresh immediately; superadmin is protected", async () => {
    const l = (await login("sam@x.com", "password123")).json.data;
    const team = (await call("/admin/team", { token: su })).json.data;
    const samId = team.find((m) => m.email === "sam@x.com")._id;
    const bossId = team.find((m) => m.email === "boss@x.com")._id;

    await call(`/admin/team/${samId}`, { method: "PUT", token: su, body: { status: "disabled" } });
    assert.equal((await call("/admin/profile", { token: l.token })).status, 401);
    assert.equal((await call("/admin/refresh", { method: "POST", body: { refreshToken: l.refreshToken } })).status, 401);
    assert.equal((await login("sam@x.com", "password123")).status, 401);

    assert.equal((await call(`/admin/team/${bossId}`, { method: "PUT", token: su, body: { status: "disabled" } })).status, 403);
    assert.equal((await call(`/admin/team/${bossId}`, { method: "DELETE", token: su })).status, 403);
    assert.equal((await call("/admin/team", { method: "POST", token: su, body: { name: "Z", email: "z@x.com", password: "password123", role: "superadmin" } })).json.data.role, "admin");

    await call(`/admin/team/${samId}`, { method: "PUT", token: su, body: { status: "active" } });
    assert.equal((await login("sam@x.com", "password123")).status, 200);
});

test("audit log records who did what, including denied attempts, and never stores passwords", async () => {
    await sleep(300);
    const res = await call("/admin/audit-logs?limit=200", { token: su });
    assert.equal(res.status, 200);
    const actions = res.json.data.map((x) => x.action);
    for (const a of ["auth.login", "role.create", "team.create", "team.update", "team.disable", "permission.denied"]) {
        assert.ok(actions.includes(a), `missing audit action ${a}`);
    }
    const del = res.json.data.find((x) => x.action === "users.delete");
    assert.equal(del.actorEmail, "sam@x.com");
    assert.ok(!JSON.stringify(res.json.data).includes("password123"));
});
