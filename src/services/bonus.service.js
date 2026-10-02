/**
 * Bonus (promotional) money.
 *
 * A user's walletBalance is the TOTAL spendable amount (what the apps already show).
 * bonusBalance is the promotional part of it. Sessions spend bonus first; the bonus-funded part of a
 * session earns the astrologer free-session SECONDS instead of rupees (see session/settlement.js).
 */
const User = require("../models/user.model");
const Promotion = require("../models/promotion.model");
const BonusGrant = require("../models/bonusGrant.model");
const PromotionUsage = require("../models/promotionUsage.model");
const Payment = require("../models/payment.model");

class PromoError extends Error {
    constructor(code, message, status = 400) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Splits a session cost between bonus and real cash (bonus first) and applies the existing 60/40
 * commission to the CASH part only. With no bonus this equals calculateSessionBilling exactly.
 */
const splitCostForBonus = (totalCost, billableSeconds, bonusBalance) => {
    const bonusAmount = round2(Math.min(Math.max(0, Number(bonusBalance) || 0), totalCost));
    const cashAmount = round2(totalCost - bonusAmount);
    const astrologerEarnings = parseFloat((cashAmount * 0.6).toFixed(2));
    const platformFee = parseFloat((cashAmount - astrologerEarnings).toFixed(2));
    const bonusSeconds = totalCost > 0 ? Math.round((billableSeconds * bonusAmount) / totalCost) : 0;
    return { bonusAmount, cashAmount, astrologerEarnings, platformFee, bonusSeconds };
};

const logPayment = async (userId, amount, prefix) => {
    try {
        const txnId = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
        await Payment.create({
            user: userId, amount, currency: "INR", paymentGateway: "Admin",
            transactionId: txnId, orderId: txnId, paymentStatus: "success", paidAt: new Date()
        });
    } catch (e) {
        console.error("Failed to log bonus to Payment collection:", e.message);
    }
};

/** Credits bonus to a user: total wallet and bonus part together, plus a grant record. */
const grantBonus = async ({ userId, amount, source, promotionId = null, reason = "", expiresAt = null, createdBy = null, paymentPrefix = "BONUS" }) => {
    const amt = round2(amount);
    if (!(amt > 0)) throw new PromoError("INVALID_AMOUNT", "Bonus amount must be greater than 0");
    const user = await User.findByIdAndUpdate(userId, { $inc: { walletBalance: amt, bonusBalance: amt } }, { new: true }).select("_id");
    if (!user) throw new PromoError("USER_NOT_FOUND", "User not found", 404);
    const grant = await BonusGrant.create({
        user: userId, promotion: promotionId, source, amount: amt, remaining: amt, expiresAt, reason: String(reason).slice(0, 200), createdBy
    });
    await logPayment(userId, amt, paymentPrefix);
    return grant;
};

const expiryFor = (promo) => (promo.bonusValidityDays ? new Date(Date.now() + promo.bonusValidityDays * DAY_MS) : null);
const inWindow = (promo, now = new Date()) =>
    (!promo.startsAt || promo.startsAt <= now) && (!promo.endsAt || promo.endsAt >= now);

/** Claims one redemption slot atomically (respects the total limit and the schedule window). */
const claimSlot = (promoId, now = new Date()) =>
    Promotion.findOneAndUpdate(
        {
            _id: promoId,
            status: "active",
            $and: [
                { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
                { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] },
                { $or: [{ maxRedemptions: null }, { $expr: { $lt: ["$redemptionCount", "$maxRedemptions"] } }] }
            ]
        },
        { $inc: { redemptionCount: 1 } },
        { new: true }
    );
const releaseSlot = (promoId) => Promotion.updateOne({ _id: promoId, redemptionCount: { $gt: 0 } }, { $inc: { redemptionCount: -1 } });

/** Per-user limit, race-proof: an existing row at the limit makes the upsert hit the unique index. */
const claimUserSlot = async (promo, userId) => {
    try {
        const r = await PromotionUsage.findOneAndUpdate(
            { promotion: promo._id, user: userId, count: { $lt: promo.perUserLimit } },
            { $inc: { count: 1 } },
            { upsert: true, new: true }
        );
        return !!r;
    } catch (e) {
        if (e.code === 11000) return false;
        throw e;
    }
};
const releaseUserSlot = (promoId, userId) => PromotionUsage.updateOne({ promotion: promoId, user: userId, count: { $gt: 0 } }, { $inc: { count: -1 } });

const DEFAULT_SIGNUP = { name: "Signup Bonus", kind: "signup", amount: 100, status: "active", perUserLimit: 1, description: "Granted automatically to every new user." };

/** The one signup promotion. Created with the historical ₹100 default the first time it is needed. */
const ensureSignupPromotion = async () => {
    let promo = await Promotion.findOne({ kind: "signup" }).sort({ createdAt: 1 });
    if (!promo) promo = await Promotion.create(DEFAULT_SIGNUP);
    return promo;
};

/** Called once for each new user. Returns the grant, or null when the signup bonus is off. */
const grantSignupBonus = async (userId) => {
    const promo = await ensureSignupPromotion();
    if (promo.status !== "active" || !(promo.amount > 0) || !inWindow(promo)) return null;
    const slot = await claimSlot(promo._id);
    if (!slot) return null; // total limit reached or outside the window
    try {
        return await grantBonus({
            userId, amount: promo.amount, source: "signup", promotionId: promo._id, reason: promo.name,
            expiresAt: expiryFor(promo), paymentPrefix: "SIGNUP"
        });
    } catch (e) {
        await releaseSlot(promo._id);
        throw e;
    }
};

const redeemCoupon = async (userId, rawCode) => {
    const code = String(rawCode || "").trim().toUpperCase();
    if (!code) throw new PromoError("CODE_REQUIRED", "Enter a coupon code");
    const promo = await Promotion.findOne({ kind: "coupon", code });
    if (!promo || promo.status !== "active") throw new PromoError("INVALID_CODE", "This coupon code is not valid");
    const now = new Date();
    if (promo.startsAt && promo.startsAt > now) throw new PromoError("NOT_STARTED", "This coupon is not active yet");
    if (promo.endsAt && promo.endsAt < now) throw new PromoError("EXPIRED", "This coupon has expired");

    if (!(await claimSlot(promo._id, now))) throw new PromoError("FULLY_REDEEMED", "This coupon has been fully redeemed");
    if (!(await claimUserSlot(promo, userId))) {
        await releaseSlot(promo._id);
        throw new PromoError("ALREADY_USED", promo.perUserLimit === 1 ? "You have already used this coupon" : "You have reached the limit for this coupon");
    }
    try {
        const grant = await grantBonus({
            userId, amount: promo.amount, source: "coupon", promotionId: promo._id, reason: `Coupon ${promo.code}`,
            expiresAt: expiryFor(promo), paymentPrefix: "COUPON"
        });
        return { grant, promotion: promo };
    } catch (e) {
        await releaseSlot(promo._id);
        await releaseUserSlot(promo._id, userId);
        throw e;
    }
};

/** Best-effort FIFO bookkeeping so grants know how much of them is left (earliest expiry first). */
const consumeGrants = async (userId, amount) => {
    let left = round2(amount);
    if (!(left > 0)) return;
    const grants = await BonusGrant.find({ user: userId, status: "active", remaining: { $gt: 0 } })
        .sort({ expiresAt: 1, createdAt: 1 }).limit(100).lean();
    // expiring grants first, never-expiring last
    grants.sort((a, b) => (a.expiresAt ? a.expiresAt.getTime() : Infinity) - (b.expiresAt ? b.expiresAt.getTime() : Infinity) || a.createdAt - b.createdAt);
    for (const g of grants) {
        if (left <= 0) break;
        const take = Math.min(g.remaining, left);
        const upd = await BonusGrant.findOneAndUpdate({ _id: g._id, remaining: { $gte: take } }, { $inc: { remaining: -take } }, { new: true });
        if (upd) {
            left = round2(left - take);
            if (upd.remaining <= 0.0001) await BonusGrant.updateOne({ _id: g._id, status: "active" }, { status: "exhausted", remaining: 0 });
        }
    }
};

/** Removes expired, still-unspent bonus from wallets. Only ever touches bonus, never cash. */
const expireBonuses = async (now = new Date()) => {
    const due = await BonusGrant.find({ status: "active", expiresAt: { $ne: null, $lte: now }, remaining: { $gt: 0 } }).limit(200).lean();
    let expired = 0;
    for (const g of due) {
        const claimed = await BonusGrant.findOneAndUpdate({ _id: g._id, status: "active" }, { status: "expired", remaining: 0 }, { new: false });
        if (!claimed) continue;
        const d = claimed.remaining;
        await User.updateOne({ _id: g.user }, [
            { $set: { _d: { $min: [d, { $ifNull: ["$bonusBalance", 0] }] } } },
            { $set: {
                walletBalance: { $max: [0, { $subtract: [{ $ifNull: ["$walletBalance", 0] }, "$_d"] }] },
                bonusBalance: { $subtract: [{ $ifNull: ["$bonusBalance", 0] }, "$_d"] }
            } },
            { $unset: "_d" }
        ], { updatePipeline: true });
        expired += 1;
    }
    return expired;
};

let expiryTimer = null;
const startExpiryWorker = (minutes = 10) => {
    if (expiryTimer) return;
    expiryTimer = setInterval(() => expireBonuses().catch((e) => console.error("bonus expiry failed:", e.message)), minutes * 60 * 1000);
    expiryTimer.unref();
};

module.exports = {
    PromoError, splitCostForBonus, grantBonus, grantSignupBonus, ensureSignupPromotion,
    redeemCoupon, consumeGrants, expireBonuses, startExpiryWorker, round2
};
