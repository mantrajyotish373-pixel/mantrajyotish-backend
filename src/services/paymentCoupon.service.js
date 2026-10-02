const Coupon = require("../models/coupon.model");
const Payment = require("../models/payment.model");

class CouponError extends Error {
    constructor(code, message) { super(message); this.code = code; }
}

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const METHODS = ["upi", "card", "netbanking", "wallet"];
const METHOD_LABEL = { upi: "UPI", card: "Card", netbanking: "Net Banking", wallet: "Wallet" };

const discountFor = (coupon, amount) => {
    let d = coupon.discountType === "percent" ? (amount * coupon.discountValue) / 100 : coupon.discountValue;
    if (coupon.discountType === "percent" && coupon.maxDiscount) d = Math.min(d, coupon.maxDiscount);
    d = Math.min(d, amount - 1); // user always pays at least ₹1
    return Math.max(0, round2(d));
};

const hasPaidBefore = async (userId) => !!(await Payment.exists({ user: userId, paymentStatus: "success", paymentGateway: "Razorpay" }));

const usedByUser = (couponId, userId) => Payment.countDocuments({ user: userId, coupon: couponId, paymentStatus: "success" });

/**
 * Checks one coupon for this user / amount / payment method.
 * Pass method = null to skip the payment-method check (used when listing before a method is chosen).
 * Throws CouponError with a user-facing message when the coupon cannot be used.
 */
const evaluate = async (coupon, { userId, amount, method = null, firstPaid = null }) => {
    const now = new Date();
    if (!coupon || coupon.status !== "active") throw new CouponError("INVALID", "This coupon is not valid");
    if (coupon.startsAt && coupon.startsAt > now) throw new CouponError("NOT_STARTED", "This coupon is not active yet");
    if (coupon.endsAt && coupon.endsAt < now) throw new CouponError("EXPIRED", "This coupon has expired");
    if (coupon.maxRedemptions && coupon.redemptionCount >= coupon.maxRedemptions) throw new CouponError("EXHAUSTED", "This coupon has been fully used");
    if (coupon.minAmount && amount < coupon.minAmount) throw new CouponError("MIN_AMOUNT", `Add at least ₹${coupon.minAmount} to use this coupon`);
    if (method && coupon.allowedMethods.length && !coupon.allowedMethods.includes(method)) {
        throw new CouponError("METHOD", `This coupon works only with ${coupon.allowedMethods.map((m) => METHOD_LABEL[m]).join(" / ")}`);
    }
    if (coupon.firstPaymentOnly) {
        const paid = firstPaid === null ? await hasPaidBefore(userId) : firstPaid;
        if (paid) throw new CouponError("FIRST_ONLY", "This coupon is only for your first payment");
    }
    if ((await usedByUser(coupon._id, userId)) >= coupon.perUserLimit) {
        throw new CouponError("USED", coupon.perUserLimit === 1 ? "You have already used this coupon" : "You have reached the limit for this coupon");
    }
    const discount = discountFor(coupon, amount);
    if (!(discount > 0)) throw new CouponError("NO_DISCOUNT", "This coupon gives no discount on this amount");
    return { coupon, discount, payable: round2(amount - discount) };
};

const validate = async ({ code, userId, amount, method }) => {
    const clean = String(code || "").trim().toUpperCase();
    if (!clean) throw new CouponError("CODE_REQUIRED", "Enter a coupon code");
    if (method && !METHODS.includes(method)) throw new CouponError("METHOD", "Unsupported payment method");
    const coupon = await Coupon.findOne({ code: clean });
    if (!coupon) throw new CouponError("INVALID", "This coupon is not valid");
    return evaluate(coupon, { userId, amount, method });
};

/** Coupons this user could use for the amount (method-agnostic; method rules are shown as text). */
const listAvailable = async ({ userId, amount }) => {
    const now = new Date();
    const coupons = await Coupon.find({
        status: "active",
        $and: [
            { $or: [{ startsAt: null }, { startsAt: { $lte: now } }] },
            { $or: [{ endsAt: null }, { endsAt: { $gte: now } }] }
        ]
    }).sort({ createdAt: -1 }).limit(30).lean();
    const firstPaid = await hasPaidBefore(userId);
    const out = [];
    for (const c of coupons) {
        try {
            const r = await evaluate(c, { userId, amount, method: null, firstPaid });
            out.push(publicView(c, r.discount, true));
        } catch (e) {
            // too small an amount: show it greyed out so users know what to add. Anything else hides the coupon.
            if (e instanceof CouponError && e.code === "MIN_AMOUNT") out.push(publicView(c, 0, false));
        }
    }
    return out;
};

const publicView = (c, discount, eligible) => ({
    id: String(c._id),
    code: c.code,
    name: c.name,
    description: c.description,
    discountType: c.discountType,
    discountValue: c.discountValue,
    maxDiscount: c.maxDiscount,
    minAmount: c.minAmount,
    allowedMethods: c.allowedMethods,
    firstPaymentOnly: c.firstPaymentOnly,
    discount,
    eligible
});

module.exports = { CouponError, validate, evaluate, listAvailable, discountFor, round2, METHODS };
