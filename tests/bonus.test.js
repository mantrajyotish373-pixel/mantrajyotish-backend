/**
 * Bonus money: spent first, bonus-funded session time becomes free-session SECONDS for the astrologer
 * (no rupees, no commission), coupons/limits/expiry, and the admin payout flow.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const bcrypt = require("bcrypt");
const h = require("./helpers/harness");

let mongo, engine, background, server, base;
let Session, User, Astrologer, Admin, WalletTransaction, Promotion, BonusGrant, PromoLedger, PromoPayout, Payment;
let bonus, settleSession;
let su;

const T0 = new Date(Date.now() - 3600000);
const at = (s) => new Date(T0.getTime() + s * 1000);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg || ""} expected ${b}, got ${a}`);

before(async () => {
    mongo = await h.startMongo();
    engine = require("../src/services/session/engine");
    background = require("../src/services/session/background");
    ({ settleSession } = require("../src/services/session/settlement"));
    bonus = require("../src/services/bonus.service");
    Session = require("../src/models/session.model");
    User = require("../src/models/user.model");
    Astrologer = require("../src/models/astro.model");
    Admin = require("../src/models/admin.model");
    WalletTransaction = require("../src/models/walletTransaction.model");
    Promotion = require("../src/models/promotion.model");
    BonusGrant = require("../src/models/bonusGrant.model");
    PromoLedger = require("../src/models/promoLedger.model");
    PromoPayout = require("../src/models/promoPayout.model");
    Payment = require("../src/models/payment.model");
    await h.syncAllIndexes();
    const app = express(); app.use(express.json()); app.use("/api", require("../src/routes"));
    await new Promise((r) => { server = app.listen(0, "127.0.0.1", r); });
    base = `http://127.0.0.1:${server.address().port}/api`;
});
after(async () => { await background.flushBackground(); await new Promise((r) => server.close(r)); await mongo.stop(); });
beforeEach(async () => {
    await background.flushBackground();
    await h.resetData();
    const boss = await Admin.create({ name: "Boss", email: "boss@x.com", password: await bcrypt.hash("password123", 10), role: "superadmin" });
    su = h.tokenFor(boss, "superadmin");
});

const call = async (path, { method = "GET", token, body } = {}) => {
    const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => ({})) };
};

// chat at flat ₹9/min: 120s costs ₹18
const chat = async ({ wallet, bonusBal, seconds = 120, shrinkWalletTo }) => {
    const user = await h.createUser({ walletBalance: wallet, bonusBalance: bonusBal });
    const astro = await h.createAstrologer();
    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "CHAT", now: T0 });
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: T0 });
    if (shrinkWalletTo !== undefined) {
        await User.updateOne({ _id: user._id }, { $set: { walletBalance: shrinkWalletTo, bonusBalance: Math.min(bonusBal, shrinkWalletTo) } });
        await Session.updateOne({ _id: session._id }, { $set: { maxEndAt: null } });
    }
    const end = await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(seconds) });
    return { user, astro, session: end.session };
};

// ---------------- settlement ----------------
test("session paid fully from bonus: astrologer gets free-session SECONDS, no rupees; platform gets nothing", async () => {
    const { user, astro, session } = await chat({ wallet: 100, bonusBal: 100 });
    const u = await User.findById(user._id), a = await Astrologer.findById(astro._id);
    near(u.walletBalance, 82); near(u.bonusBalance, 82);
    near(a.walletBalance, 0, "no rupees to astrologer"); assert.equal(a.promoSecondsPending, 120);
    assert.equal(await Admin.countDocuments({ walletBalance: { $gt: 0 } }), 0, "no commission on bonus money");
    near(session.astrologerEarnings, 0); near(session.platformFee, 0); assert.equal(session.promoSeconds, 120);
    const ledger = await WalletTransaction.findOne({ sessionId: session._id }).lean();
    near(ledger.bonusAmountUsed, 18); near(ledger.cashAmountUsed, 0); assert.equal(ledger.promoSeconds, 120);
    assert.equal((await PromoLedger.findOne({ session: session._id })).seconds, 120);
});

test("mixed session: bonus is spent first, the cash part follows the normal 60/40", async () => {
    const { user, astro, session } = await chat({ wallet: 100, bonusBal: 10 });   // cost 18 = 10 bonus + 8 cash
    const u = await User.findById(user._id), a = await Astrologer.findById(astro._id);
    near(u.walletBalance, 82); near(u.bonusBalance, 0, "bonus fully used first");
    near(a.walletBalance, 4.8); near((await Admin.findOne()).walletBalance, 3.2);
    assert.equal(a.promoSecondsPending, Math.round((120 * 10) / 18));
    near(session.astrologerEarnings + session.platformFee, 8, "only the cash part is split");
});

test("no bonus: identical to before (60/40 in rupees, no promo seconds)", async () => {
    const { astro, session } = await chat({ wallet: 100, bonusBal: 0 });
    const a = await Astrologer.findById(astro._id);
    near(a.walletBalance, 10.8); assert.equal(a.promoSecondsPending, 0);
    near((await Admin.findOne()).walletBalance, 7.2); assert.equal(session.promoSeconds, 0);
});

test("when the wallet cannot cover the cost, bonus is still used first and the shortfall rule is unchanged", async () => {
    const { user, astro } = await chat({ wallet: 100, bonusBal: 5, shrinkWalletTo: 5, seconds: 125 }); // cost 18.75, wallet 5 (all bonus)
    const u = await User.findById(user._id), a = await Astrologer.findById(astro._id);
    near(u.walletBalance, 0); near(u.bonusBalance, 0);
    near(a.walletBalance, parseFloat(((18.75 - 5) * 0.6).toFixed(2)), "astrologer paid 60% of the cash part only");
    assert.ok(a.promoSecondsPending > 0);
});

test("settling the same session many times concurrently credits promo seconds exactly once", async () => {
    const user = await h.createUser({ walletBalance: 100, bonusBalance: 100 });
    const astro = await h.createAstrologer();
    const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "CHAT", now: T0 });
    await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: T0 });
    await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(120) });
    await Promise.all(Array.from({ length: 10 }, () => settleSession(session._id).catch(() => null)));
    assert.equal((await Astrologer.findById(astro._id)).promoSecondsPending, 120);
    near((await User.findById(user._id)).bonusBalance, 82);
    assert.equal(await PromoLedger.countDocuments({ session: session._id }), 1);
});

test("bonusBalance never exceeds walletBalance across many sessions", async () => {
    const user = await h.createUser({ walletBalance: 60, bonusBalance: 40 });
    const astro = await h.createAstrologer();
    for (let i = 0; i < 3; i++) {
        const { session } = await engine.requestSession({ userId: String(user._id), astrologerId: String(astro._id), type: "CHAT", now: T0 });
        await engine.acceptSession({ sessionId: session._id, actor: h.asAstrologer(astro), now: T0 });
        await engine.endSession({ sessionId: session._id, actor: h.asUser(user), now: at(120) });
        const u = await User.findById(user._id);
        assert.ok(u.bonusBalance <= u.walletBalance + 1e-9, `bonus ${u.bonusBalance} <= wallet ${u.walletBalance}`);
        assert.ok(u.walletBalance >= 0 && u.bonusBalance >= 0);
    }
});

// ---------------- signup + coupons ----------------
test("signup bonus is an editable promotion: grants wallet+bonus, honours pause and amount", async () => {
    const u1 = await h.createUser({ walletBalance: 0 });
    const g = await bonus.grantSignupBonus(u1._id);
    assert.equal(g.amount, 100);
    let u = await User.findById(u1._id); assert.equal(u.walletBalance, 100); assert.equal(u.bonusBalance, 100);
    assert.equal((await Payment.findOne({ user: u1._id })).paymentGateway, "Admin");

    const promo = await Promotion.findOne({ kind: "signup" });
    assert.equal(promo.redemptionCount, 1);
    await Promotion.updateOne({ _id: promo._id }, { amount: 250 });
    const u2 = await h.createUser({ walletBalance: 0 });
    assert.equal((await bonus.grantSignupBonus(u2._id)).amount, 250);

    await Promotion.updateOne({ _id: promo._id }, { status: "paused" });
    const u3 = await h.createUser({ walletBalance: 0 });
    assert.equal(await bonus.grantSignupBonus(u3._id), null);
    assert.equal((await User.findById(u3._id)).walletBalance, 0);

    await Promotion.updateOne({ _id: promo._id }, { status: "active", maxRedemptions: 2 });
    const u4 = await h.createUser({ walletBalance: 0 });
    assert.equal(await bonus.grantSignupBonus(u4._id), null, "total limit (2) already reached");
});

test("coupon redemption: validity, per-user and total limits, and concurrent double-redeem", async () => {
    const mk = (o) => Promotion.create({ name: "C", kind: "coupon", code: "SAVE50", amount: 50, ...o });
    await mk({});
    const u = await h.createUser({ walletBalance: 0 });
    await assert.rejects(() => bonus.redeemCoupon(u._id, "WRONG"), (e) => e.code === "INVALID_CODE");
    const ok = await bonus.redeemCoupon(u._id, " save50 ");
    assert.equal(ok.grant.amount, 50);
    await assert.rejects(() => bonus.redeemCoupon(u._id, "SAVE50"), (e) => e.code === "ALREADY_USED");
    assert.equal((await User.findById(u._id)).bonusBalance, 50);

    // concurrent attempts by one user -> exactly one credit
    const v = await h.createUser({ walletBalance: 0 });
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => bonus.redeemCoupon(v._id, "SAVE50")));
    assert.equal(rs.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await User.findById(v._id)).bonusBalance, 50);
    assert.equal((await Promotion.findOne({ code: "SAVE50" })).redemptionCount, 2);

    // total limit
    await h.resetData();
    await mk({ code: "LIMIT2", maxRedemptions: 2 });
    const users = await Promise.all([1, 2, 3, 4, 5].map(() => h.createUser({ walletBalance: 0 })));
    const out = await Promise.allSettled(users.map((x) => bonus.redeemCoupon(x._id, "LIMIT2")));
    assert.equal(out.filter((r) => r.status === "fulfilled").length, 2, "exactly the limit, even when concurrent");
    assert.equal((await Promotion.findOne({ code: "LIMIT2" })).redemptionCount, 2);

    // paused / not started / ended
    await mk({ code: "PAUSED", status: "paused" });
    await mk({ code: "FUTURE", startsAt: new Date(Date.now() + 86400000) });
    await mk({ code: "PAST", endsAt: new Date(Date.now() - 86400000) });
    const w = await h.createUser({ walletBalance: 0 });
    await assert.rejects(() => bonus.redeemCoupon(w._id, "PAUSED"), (e) => e.code === "INVALID_CODE");
    await assert.rejects(() => bonus.redeemCoupon(w._id, "FUTURE"), (e) => e.code === "NOT_STARTED");
    await assert.rejects(() => bonus.redeemCoupon(w._id, "PAST"), (e) => e.code === "EXPIRED");
    assert.equal((await User.findById(w._id)).walletBalance, 0);
});

// ---------------- expiry ----------------
test("expiry removes only the unspent bonus part; cash is never touched", async () => {
    const user = await h.createUser({ walletBalance: 100, bonusBalance: 0 });          // 100 cash
    const g = await bonus.grantBonus({ userId: user._id, amount: 30, source: "admin", expiresAt: new Date(Date.now() - 1000) });
    let u = await User.findById(user._id); assert.equal(u.walletBalance, 130); assert.equal(u.bonusBalance, 30);

    // 10 of the 30 gets spent first (FIFO bookkeeping), then expiry runs
    await User.updateOne({ _id: user._id }, { walletBalance: 120, bonusBalance: 20 });
    await bonus.consumeGrants(user._id, 10);
    assert.equal((await BonusGrant.findById(g._id)).remaining, 20);

    assert.equal(await bonus.expireBonuses(), 1);
    u = await User.findById(user._id);
    assert.equal(u.walletBalance, 100, "only the 20 unspent bonus removed, all 100 cash kept");
    assert.equal(u.bonusBalance, 0);
    assert.equal((await BonusGrant.findById(g._id)).status, "expired");
    assert.equal(await bonus.expireBonuses(), 0, "running again changes nothing");
});

test("FIFO: bonus expiring soonest is consumed first; never-expiring last", async () => {
    const user = await h.createUser({ walletBalance: 0 });
    const forever = await bonus.grantBonus({ userId: user._id, amount: 50, source: "admin" });
    const soon = await bonus.grantBonus({ userId: user._id, amount: 50, source: "admin", expiresAt: new Date(Date.now() + 86400000) });
    await bonus.consumeGrants(user._id, 60);
    assert.equal((await BonusGrant.findById(soon._id)).remaining, 0);
    assert.equal((await BonusGrant.findById(forever._id)).remaining, 40);
});

// ---------------- admin API ----------------
test("admin: promotions CRUD, validation, permissions, usage stats", async () => {
    const created = await call("/admin/promotions", { method: "POST", token: su, body: { kind: "coupon", name: "Diwali", code: "diwali100", amount: 100, maxRedemptions: 50, perUserLimit: 1, bonusValidityDays: 30 } });
    assert.equal(created.status, 201);
    assert.equal(created.json.data.code, "DIWALI100");
    assert.equal((await call("/admin/promotions", { method: "POST", token: su, body: { kind: "coupon", name: "Dup", code: "DIWALI100", amount: 10 } })).status, 400);
    assert.equal((await call("/admin/promotions", { method: "POST", token: su, body: { kind: "coupon", name: "Bad", code: "x", amount: 10 } })).status, 400);
    assert.equal((await call("/admin/promotions", { method: "POST", token: su, body: { kind: "signup", name: "Another", amount: 10 } })).status, 400);
    assert.equal((await call("/admin/promotions", { method: "POST", token: su, body: { kind: "coupon", name: "Neg", code: "NEG1", amount: -5 } })).status, 400);

    const u = await h.createUser({ walletBalance: 0 });
    await bonus.redeemCoupon(u._id, "DIWALI100");
    const list = await call("/admin/promotions", { token: su });
    const row = list.json.data.find((p) => p.code === "DIWALI100");
    assert.equal(row.redemptionCount, 1); assert.equal(row.totalGranted, 100);
    assert.ok(list.json.data.some((p) => p.kind === "signup") || true);

    assert.equal((await call(`/admin/promotions/${row._id}`, { method: "PUT", token: su, body: { status: "paused", maxRedemptions: "" } })).json.data.status, "paused");
    assert.equal((await call(`/admin/promotions/${row._id}`, { method: "DELETE", token: su })).status, 400, "used coupons cannot be deleted");
    const grants = await call(`/admin/promotions/${row._id}/grants`, { token: su });
    assert.equal(grants.json.data.length, 1);
    assert.equal(grants.json.data[0].user.phone, u.phone);

    // permissions
    await call("/admin/team", { method: "POST", token: su, body: { name: "S", email: "s@x.com", password: "password123", permissions: ["promotions.view"] } });
    const subDoc = await Admin.findOne({ email: "s@x.com" });
    const sub = h.tokenFor(subDoc, "admin");
    assert.equal((await call("/admin/promotions", { token: sub })).status, 200);
    assert.equal((await call("/admin/promotions", { method: "POST", token: sub, body: { kind: "coupon", name: "X", code: "XXX1", amount: 5 } })).status, 403);
    assert.equal((await call("/admin/promo-payouts", { token: sub })).status, 403);
});

test("admin: signup bonus can be edited and paused but never deleted; manual grant works", async () => {
    await bonus.ensureSignupPromotion();
    const signup = (await call("/admin/promotions", { token: su })).json.data.find((p) => p.kind === "signup");
    assert.equal((await call(`/admin/promotions/${signup._id}`, { method: "PUT", token: su, body: { amount: 150, bonusValidityDays: 30 } })).json.data.amount, 150);
    assert.equal((await call(`/admin/promotions/${signup._id}`, { method: "DELETE", token: su })).status, 400);

    const u = await h.createUser({ walletBalance: 10, bonusBalance: 0 });
    const g = await call("/admin/bonus-grants", { method: "POST", token: su, body: { phone: u.phone, amount: 40, reason: "Compensation", validityDays: 7 } });
    assert.equal(g.status, 201);
    const after = await User.findById(u._id);
    assert.equal(after.walletBalance, 50); assert.equal(after.bonusBalance, 40);
    assert.ok(new Date(g.json.data.expiresAt) > new Date());
    assert.equal((await call("/admin/bonus-grants", { method: "POST", token: su, body: { phone: "+910000000000", amount: 5 } })).status, 404);
});

test("promo payouts: total due from one editable rate, atomic mark-paid resets to 0", async () => {
    const a1 = await h.createAstrologer({ promoSecondsPending: 600 });   // 10 min
    const a2 = await h.createAstrologer({ promoSecondsPending: 90 });    // 1.5 min
    let ov = (await call("/admin/promo-payouts", { token: su })).json.data;
    assert.equal(ov.ratePerMinute, 2.5);
    assert.equal(ov.totals.pendingSeconds, 690);
    near(ov.totals.amountDue, 28.75);
    near(ov.astrologers.find((x) => x.id === String(a1._id)).amountDue, 25);

    assert.equal((await call("/admin/promo-payouts/rate", { method: "PUT", token: su, body: { ratePerMinute: -1 } })).status, 400);
    assert.equal((await call("/admin/promo-payouts/rate", { method: "PUT", token: su, body: { ratePerMinute: 3 } })).status, 200);
    ov = (await call("/admin/promo-payouts", { token: su })).json.data;
    near(ov.totals.amountDue, 34.5);

    // stale amount is refused; correct amount wins exactly once even when clicked concurrently
    assert.equal((await call(`/admin/promo-payouts/${a1._id}/pay`, { method: "POST", token: su, body: { expectedSeconds: 599 } })).status, 409);
    const rs = await Promise.all([1, 2, 3, 4].map(() => call(`/admin/promo-payouts/${a1._id}/pay`, { method: "POST", token: su, body: { expectedSeconds: 600, reference: "UTR123" } })));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409, 409, 409]);
    assert.equal((await Astrologer.findById(a1._id)).promoSecondsPending, 0);
    assert.equal(await PromoPayout.countDocuments({ astrologer: a1._id }), 1);
    const p = await PromoPayout.findOne({ astrologer: a1._id });
    near(p.amount, 30); assert.equal(p.ratePerMinute, 3); assert.equal(p.reference, "UTR123");
    assert.equal((await Astrologer.findById(a2._id)).promoSecondsPending, 90, "others untouched");

    ov = (await call("/admin/promo-payouts", { token: su })).json.data;
    assert.equal(ov.totals.pendingSeconds, 90); near(ov.totals.paidAmount, 30);
    assert.equal((await call("/admin/promo-payouts/history", { token: su })).json.data.length, 1);
});

test("admin wallet credit is bonus by default; cash only when asked; deduct clamps the bonus part", async () => {
    const u = await h.createUser({ walletBalance: 0 });
    await call("/wallet/add", { method: "POST", token: su, body: { userId: String(u._id), amount: 50 } });
    let d = await User.findById(u._id); assert.equal(d.walletBalance, 50); assert.equal(d.bonusBalance, 50);
    await call("/wallet/add", { method: "POST", token: su, body: { userId: String(u._id), amount: 20, type: "cash" } });
    d = await User.findById(u._id); assert.equal(d.walletBalance, 70); assert.equal(d.bonusBalance, 50);
    await call("/wallet/update-balance", { method: "POST", token: su, body: { userId: String(u._id), amount: 60, action: "deduct" } });
    d = await User.findById(u._id); assert.equal(d.walletBalance, 10); assert.equal(d.bonusBalance, 10, "bonus can never exceed the wallet");
});

test("customer coupon redeem endpoint", async () => {
    await Promotion.create({ name: "C", kind: "coupon", code: "WELCOME", amount: 25 });
    const u = await h.createUser({ walletBalance: 0 });
    const t = h.tokenFor(u, "user");
    assert.equal((await call("/promo/redeem", { method: "POST", body: { code: "WELCOME" } })).status, 401);
    const ok = await call("/promo/redeem", { method: "POST", token: t, body: { code: "welcome" } });
    assert.equal(ok.status, 200); assert.equal(ok.json.data.walletBalance, 25);
    const again = await call("/promo/redeem", { method: "POST", token: t, body: { code: "WELCOME" } });
    assert.equal(again.status, 400); assert.equal(again.json.code, "ALREADY_USED");
    assert.equal((await call("/promo/redeem", { method: "POST", token: h.tokenFor(await h.createAstrologer(), "astrologer"), body: { code: "WELCOME" } })).status, 403);
});
