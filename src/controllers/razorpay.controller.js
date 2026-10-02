const razorpayService = require("../services/razorpay.service");
const User = require("../models/user.model");
const Payment = require("../models/payment.model");
const Appointment = require("../models/appointment.model");
const mongoose = require("mongoose");
const Coupon = require("../models/coupon.model");
const bonusService = require("../services/bonus.service");
const addMoneyConfig = require("../services/addMoneyConfig.service");
const couponService = require("../services/paymentCoupon.service");
const { logPaymentEvent } = require("../services/paymentLog.service");

const round2 = (n) => Math.round(Number(n) * 100) / 100;
const MAX_PENDING_ORDERS = 5;          // open orders one user may have in the last 10 minutes
const STALE_ORDER_HOURS = 6;           // an order nobody paid for in this long is closed as expired

/** Helper: find user by id/phone/uniqueId/email */
const findUserByIdentifier = async (identifier, phoneFallback = null) => {
    if (!identifier && !phoneFallback) return null;

    let user = null;

    if (identifier && mongoose.Types.ObjectId.isValid(identifier)) {
        user = await User.findById(identifier);
    }

    if (!user && identifier) {
        user = await User.findOne({
            $or: [
                { phone: identifier },
                { uniqueId: identifier },
                { email: identifier },
                { userLogin: identifier }
            ]
        });
    }

    if (!user && phoneFallback) {
        const cleanPhone = phoneFallback.trim();
        user = await User.findOne({
            $or: [
                { phone: cleanPhone },
                { phone: cleanPhone.replace("+91", "") },
                { phone: "+91" + cleanPhone.replace("+91", "") }
            ]
        });
    }

    return user;
};

/** Resolves the paying user from the verified JWT (routes require authMiddleware) */
const resolveUserFromRequest = async (req) => {
    const identifier = req.user && (req.user.userId || req.user.id);
    if (!identifier) return null;
    return await findUserByIdentifier(String(identifier));
};

/**
 * The app can hand us Razorpay's error as a block of JSON ({"error":{"code":"BAD_REQUEST_ERROR","description":"undefined",...}}).
 * Store a short readable sentence instead; the raw text is kept in the payment event trail.
 */
const tidyReason = (raw) => {
    let text = String(raw || "").trim();
    if (text.startsWith("{")) {
        try {
            const e = (JSON.parse(text) || {}).error || {};
            const desc = String(e.description || "").trim();
            if (desc && desc.toLowerCase() !== "undefined" && desc.toLowerCase() !== "null") text = desc;
            else {
                const why = String(e.reason || e.code || "").replace(/_/g, " ").toLowerCase().trim();
                const step = String(e.step || "").replace(/_/g, " ").toLowerCase().trim();
                text = why || step ? `Payment failed${step ? ` at ${step}` : ""}${why ? ` (${why})` : ""}` : "Payment failed";
            }
        } catch (err) { text = "Payment failed"; }
    }
    return (text || "Payment failed").slice(0, 300);
};

/** Rupees that actually reached (or will reach) the wallet for a successful payment. */
const creditedOf = (payment) => {
    if (payment.walletCredit == null) return Number(payment.amount);
    if (payment.coupon && !payment.couponCounted) return Math.max(0, round2(Number(payment.amount) - Number(payment.gstAmount || 0)));
    return Number(payment.walletCredit);
};

// POST /api/razorpay/order
const createOrder = async (req, res) => {
    try {
        const { amount, receipt, payment_capture } = req.body;

        if (!amount || !(Number(amount) > 0) || !Number.isFinite(Number(amount))) {
            return res.status(400).json({ success: false, message: "Invalid amount" });
        }

        // Robustly resolve user
        const user = await resolveUserFromRequest(req);
        if (!user) {
            return res.status(401).json({ success: false, message: "Authentication required or user not found" });
        }

        // Stop order spam: only a handful of unpaid orders at a time
        const recentPending = await Payment.countDocuments({
            user: user._id, paymentGateway: "Razorpay", paymentStatus: "pending", createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) }
        });
        if (recentPending >= MAX_PENDING_ORDERS) {
            await logPaymentEvent({ user, type: "order.rejected_too_many_pending", source: "client", level: "warn", message: `${recentPending} unpaid orders in 10 minutes`, req });
            return res.status(429).json({ success: false, message: "You have several unfinished payments. Please wait a few minutes and try again." });
        }

        // Wallet top-up limits and the extra bonus promised for this amount (set in the admin's Add Money settings)
        const isTopUp = !(req.body.appointmentId || req.body.appointment);
        let extraBonus = 0;
        let gstPercent = 0;
        if (isTopUp) {
            const cfg = await addMoneyConfig.getConfig();
            gstPercent = Number(cfg.gstPercent) || 0;
            if (Number(amount) < cfg.minAmount || Number(amount) > cfg.maxAmount) {
                return res.status(400).json({ success: false, message: `Enter an amount between ₹${cfg.minAmount} and ₹${cfg.maxAmount.toLocaleString("en-IN")}` });
            }
            extraBonus = addMoneyConfig.extraFor(cfg, Number(amount));
        }

        // Optional payment-page coupon: reduces what is charged, the wallet still gets the full amount.
        let applied = null;
        const couponCode = String(req.body.couponCode || "").trim();
        const method = req.body.method ? String(req.body.method) : null;
        if (couponCode) {
            try {
                applied = await couponService.validate({ code: couponCode, userId: user._id, amount: Number(amount), method });
            } catch (e) {
                if (e instanceof couponService.CouponError) return res.status(400).json({ success: false, code: e.code, message: e.message });
                throw e;
            }
        }

        // GST is charged on top of what the user pays for the credit (after any coupon discount).
        // The wallet still receives the full amount the user chose.
        const taxable = applied ? applied.payable : Number(amount);
        const gstAmount = isTopUp && gstPercent > 0 ? Math.round(taxable * gstPercent) / 100 : 0;
        const chargeAmount = Math.round((taxable + gstAmount) * 100) / 100;

        // notes.userId lets the webhook attribute the payment even if no local record exists.
        // The currency is always INR: it is never taken from the client.
        const order = await razorpayService.createOrder({ amount: chargeAmount, currency: "INR", receipt: receipt || `MJ${Date.now()}`, payment_capture, notes: { userId: String(user._id) } });

        const appointmentId = req.body.appointmentId || req.body.appointment || null;

        const paymentData = {
            user: user._id,
            amount: chargeAmount,
            currency: "INR",
            paymentGateway: "Razorpay",
            paymentStatus: "pending",
            orderId: order.id,
            paymentMethod: method,
            bonusAmount: extraBonus
        };
        if (isTopUp && (applied || gstAmount > 0)) {
            paymentData.walletCredit = Number(amount);
            paymentData.gstAmount = gstAmount;
            paymentData.gstPercent = gstPercent;
        }
        if (applied) {
            paymentData.discountAmount = applied.discount;
            paymentData.coupon = applied.coupon._id;
            paymentData.couponCode = applied.coupon.code;
        }

        if (appointmentId && mongoose.Types.ObjectId.isValid(appointmentId)) paymentData.appointment = appointmentId;

        let paymentRecord = null;
        try {
            paymentRecord = await Payment.create(paymentData);
        } catch (e) {
            // Without a local record the payment could not be tracked safely, so do not hand out the order.
            await logPaymentEvent({ user, orderId: order.id, type: "order.record_failed", source: "system", level: "error", message: e.message, req });
            return res.status(500).json({ success: false, message: "Could not start the payment. Please try again." });
        }

        await logPaymentEvent({
            payment: paymentRecord, user, type: "order.created", source: "client", req,
            message: `Order for ₹${chargeAmount}${applied ? ` (coupon ${applied.coupon.code})` : ""}`,
            details: { credit: Number(amount), charge: chargeAmount, gst: gstAmount, discount: applied ? applied.discount : 0, extraBonus, method }
        });

        return res.status(201).json({
            success: true,
            data: {
                order, keyId: process.env.RAZORPAY_KEY_ID || null, payment: paymentRecord,
                pricing: isTopUp ? { amount: Number(amount), discount: applied ? applied.discount : 0, gst: gstAmount, gstPercent, payable: chargeAmount, couponCode: applied ? applied.coupon.code : null } : null,
                extraBonus
            }
        });
    } catch (error) {
        console.error("createOrder error:", error);
        return res.status(500).json({ success: false, message: "Could not start the payment. Please try again." });
    }
};

/**
 * Turns a captured Razorpay payment into wallet money. Safe to call any number of times, from any source
 * (app verify, webhook, reconciliation): the payment is claimed atomically so money is credited exactly once.
 */
const processSuccessfulPayment = async ({
    orderId,
    transactionId,
    paymentEntity = null,
    resolvedUser = null,
    currency = "INR",
    source = "VERIFY", // 'VERIFY' | 'WEBHOOK' | 'RECONCILE'
    req = null,
}) => {
    const src = source.toLowerCase();
    let creditedAmount = null;

    if (paymentEntity && paymentEntity.amount) {
        if (orderId && paymentEntity.order_id && paymentEntity.order_id !== orderId) {
            await logPaymentEvent({ orderId, paymentId: transactionId, type: "payment.order_mismatch", source: src, level: "error", message: `Payment belongs to order ${paymentEntity.order_id}`, req });
            return { claimed: false, reason: "ORDER_MISMATCH", payment: null };
        }

        // Only a CAPTURED payment is real money. An authorized one is captured here first.
        if (paymentEntity.status === "authorized") {
            try {
                paymentEntity = await razorpayService.capturePayment(paymentEntity.id, paymentEntity.amount, paymentEntity.currency || "INR");
                await logPaymentEvent({ orderId, paymentId: paymentEntity.id, type: "payment.captured_by_server", source: src, message: "Authorized payment captured", req });
            } catch (e) {
                await logPaymentEvent({ orderId, paymentId: paymentEntity.id, type: "payment.capture_failed", source: src, level: "error", message: e.message, req });
                return { claimed: false, reason: "PAYMENT_NOT_CAPTURED", payment: null };
            }
        }
        if (paymentEntity.status && paymentEntity.status !== "captured") {
            return { claimed: false, reason: "PAYMENT_NOT_CAPTURED", payment: null };
        }
        if (paymentEntity.currency && paymentEntity.currency !== "INR") {
            await logPaymentEvent({ orderId, paymentId: transactionId, type: "payment.currency_mismatch", source: src, level: "error", message: paymentEntity.currency, req });
            return { claimed: false, reason: "CURRENCY_MISMATCH", payment: null };
        }
        creditedAmount = Number(paymentEntity.amount) / 100;
    }

    let payment = null;
    if (orderId) payment = await Payment.findOne({ orderId });
    if (!payment && transactionId) payment = await Payment.findOne({ transactionId });

    if (!payment) {
        if (!resolvedUser) {
            await logPaymentEvent({ orderId, paymentId: transactionId, type: "payment.unmatched", source: src, level: "error", message: "No payment record and no user to attribute it to", req });
            return { claimed: false, reason: "USER_NOT_RESOLVED", payment: null };
        }
        if (creditedAmount == null) {
            await logPaymentEvent({ orderId, paymentId: transactionId, user: resolvedUser, type: "payment.unverified_amount", source: src, level: "error", message: "No record and no authoritative amount", req });
            return { claimed: false, reason: "AMOUNT_UNVERIFIED", payment: null };
        }
        try {
            payment = await Payment.create({
                user: resolvedUser._id, amount: creditedAmount, currency: "INR", paymentGateway: "Razorpay",
                paymentStatus: "pending", orderId: orderId || null, transactionId: transactionId || null,
            });
            await logPaymentEvent({ payment, user: resolvedUser, type: "payment.record_created_late", source: src, level: "warn", message: "Payment had no local order record", req });
        } catch (e) {
            if (orderId) payment = await Payment.findOne({ orderId });
            if (!payment && transactionId) payment = await Payment.findOne({ transactionId });
            if (!payment) return { claimed: false, reason: "CREATE_FAILED", payment: null, error: e.message };
        }
    }

    if (payment.paymentStatus === "success") {
        return { claimed: false, reason: "ALREADY_SUCCESS", payment, creditedAmount: creditedOf(payment) };
    }

    // The amount Razorpay took must equal what we asked for. Anything else is held for a human to review, never credited.
    if (creditedAmount != null && payment.amount > 0 && Math.abs(creditedAmount - Number(payment.amount)) > 0.01 && !payment.needsReview) {
        await Payment.updateOne({ _id: payment._id }, { $set: { needsReview: true, reviewReason: `Paid ₹${creditedAmount} but order was ₹${payment.amount}` } });
        await logPaymentEvent({ payment, type: "payment.amount_mismatch", source: src, level: "error", message: `Paid ₹${creditedAmount}, expected ₹${payment.amount}`, details: { paid: creditedAmount, expected: payment.amount }, req });
        return { claimed: false, reason: "AMOUNT_MISMATCH", payment };
    }
    if (payment.needsReview) return { claimed: false, reason: "NEEDS_REVIEW", payment };

    // ATOMIC CLAIM: pending/failed -> success, exactly once.
    const claimedPayment = await Payment.findOneAndUpdate(
        { _id: payment._id, paymentStatus: { $ne: "success" } },
        {
            $set: {
                paymentStatus: "success",
                transactionId: transactionId || payment.transactionId,
                paidAt: payment.paidAt || new Date(),
                amount: creditedAmount != null ? creditedAmount : payment.amount,
                failureReason: null,
                creditPending: true,
                ...(resolvedUser && !payment.user ? { user: resolvedUser._id } : {}),
            },
        },
        { new: true }
    );

    if (!claimedPayment) {
        const latest = await Payment.findById(payment._id);
        return { claimed: false, reason: "CLAIM_LOST", payment: latest, creditedAmount: latest ? creditedOf(latest) : null };
    }

    await logPaymentEvent({ payment: claimedPayment, type: "payment.claimed", source: src, message: `Payment confirmed (${paymentEntity ? paymentEntity.method : "unknown method"})`, details: { paid: claimedPayment.amount, method: paymentEntity && paymentEntity.method }, req });

    // Work out what goes into the wallet. A discounted/GST top-up credits the full amount the user chose, but only
    // if the coupon's rules held for the method actually used; otherwise just what was paid (without GST).
    let finalCreditedAmt = Number(claimedPayment.amount);
    if (claimedPayment.walletCredit != null) {
        let methodOk = true;
        if (claimedPayment.coupon) {
            try {
                const coupon = await Coupon.findById(claimedPayment.coupon).lean();
                const used = paymentEntity && paymentEntity.method;
                if (coupon && coupon.allowedMethods && coupon.allowedMethods.length && used && !coupon.allowedMethods.includes(used)) methodOk = false;
                if (methodOk && !claimedPayment.couponCounted) {
                    await Coupon.updateOne({ _id: claimedPayment.coupon }, { $inc: { redemptionCount: 1 } });
                    await Payment.updateOne({ _id: claimedPayment._id }, { $set: { couponCounted: true } });
                    claimedPayment.couponCounted = true;
                }
            } catch (e) {
                await logPaymentEvent({ payment: claimedPayment, type: "coupon.count_failed", source: src, level: "warn", message: e.message, req });
            }
        }
        if (methodOk) finalCreditedAmt = Number(claimedPayment.walletCredit);
        else {
            finalCreditedAmt = Math.max(0, round2(Number(claimedPayment.amount) - Number(claimedPayment.gstAmount || 0)));
            await logPaymentEvent({ payment: claimedPayment, type: "coupon.method_mismatch", source: src, level: "warn", message: "Coupon not honoured: paid with a method the coupon does not allow" });
        }
    }

    if (claimedPayment.appointment) {
        try {
            await Appointment.findByIdAndUpdate(claimedPayment.appointment, { appointmentStatus: "confirmed", paymentStatus: "paid" });
            await Payment.updateOne({ _id: claimedPayment._id }, { $set: { creditPending: false } });
        } catch (e) {
            await logPaymentEvent({ payment: claimedPayment, type: "appointment.confirm_failed", source: src, level: "error", message: e.message });
        }
    } else if (claimedPayment.user) {
        await creditWallet(claimedPayment, finalCreditedAmt, src);
    }

    return { claimed: true, payment: claimedPayment, creditedAmount: finalCreditedAmt, bonusAmount: claimedPayment.bonusAmount || 0 };
};

/**
 * Adds money to the wallet exactly once. The creditPending flag is cleared BEFORE the money moves, and put back if
 * the credit fails, so a crash can never double-credit and the reconciliation job can finish a failed credit.
 */
const creditWallet = async (payment, amount, src) => {
    const slot = await Payment.findOneAndUpdate({ _id: payment._id, creditPending: true }, { $set: { creditPending: false } });
    if (!slot) return false; // already credited (or being credited) elsewhere
    try {
        await User.findByIdAndUpdate(payment.user, { $inc: { walletBalance: amount } });
        await logPaymentEvent({ payment, user: payment.user, type: "wallet.credited", source: src, message: `₹${amount} added to wallet`, details: { amount } });
    } catch (e) {
        await Payment.updateOne({ _id: payment._id }, { $set: { creditPending: true } });
        await logPaymentEvent({ payment, user: payment.user, type: "wallet.credit_failed", source: src, level: "error", message: e.message, details: { amount } });
        return false;
    }

    // Extra bonus promised for this top-up: granted once, as bonus (not cash)
    if (payment.bonusAmount > 0) {
        try {
            const first = await Payment.findOneAndUpdate({ _id: payment._id, bonusGranted: { $ne: true } }, { $set: { bonusGranted: true } });
            if (first) {
                const cfg = await addMoneyConfig.getConfig();
                await bonusService.grantBonus({
                    userId: payment.user,
                    amount: payment.bonusAmount,
                    source: "recharge",
                    reason: `Extra bonus on ₹${payment.walletCredit != null ? payment.walletCredit : payment.amount} recharge`,
                    expiresAt: cfg.extraValidityDays ? new Date(Date.now() + cfg.extraValidityDays * 86400000) : null,
                    paymentPrefix: "RECHARGEBONUS"
                });
                await logPaymentEvent({ payment, user: payment.user, type: "bonus.granted", source: src, message: `₹${payment.bonusAmount} extra bonus`, details: { amount: payment.bonusAmount } });
            }
        } catch (e) {
            await Payment.updateOne({ _id: payment._id }, { $set: { bonusGranted: false } });
            await logPaymentEvent({ payment, user: payment.user, type: "bonus.grant_failed", source: src, level: "error", message: e.message });
        }
    }
    return true;
};

/**
 * Asks Razorpay what really happened to an order and settles our record to match.
 * Used when the app never reported a result (app closed, UPI app returned late, webhook missed).
 * Returns { status: "success" | "failed" | "pending" | "review" | "unknown", ... }.
 */
const reconcileOrder = async (orderId, { source = "reconcile", req = null } = {}) => {
    const payment = await Payment.findOne({ orderId });
    if (!payment) return { status: "unknown" };
    if (payment.paymentStatus === "success") {
        return { status: "success", creditedAmount: creditedOf(payment), bonusAmount: payment.bonusAmount || 0, payment };
    }
    if (payment.needsReview) return { status: "review", payment };

    let items;
    try {
        items = await razorpayService.fetchOrderPayments(orderId);
    } catch (e) {
        await logPaymentEvent({ payment, type: "reconcile.fetch_failed", source, level: "warn", message: e.message, req });
        return { status: payment.paymentStatus === "failed" ? "failed" : "pending", payment, failureReason: payment.failureReason };
    }

    const good = items.find((p) => p.status === "captured") || items.find((p) => p.status === "authorized");
    if (good) {
        const user = await User.findById(payment.user);
        const r = await processSuccessfulPayment({ orderId, transactionId: good.id, paymentEntity: good, resolvedUser: user, source: "RECONCILE", req });
        await logPaymentEvent({ payment, type: "reconcile.found_payment", source, message: `Razorpay has a ${good.status} payment`, details: { result: r.reason || "credited" }, req });
        if (r.payment && r.payment.paymentStatus === "success") return { status: "success", creditedAmount: r.creditedAmount, bonusAmount: r.bonusAmount || r.payment.bonusAmount || 0, payment: r.payment };
        if (r.reason === "AMOUNT_MISMATCH" || r.reason === "NEEDS_REVIEW") return { status: "review", payment: r.payment };
        return { status: "pending", payment };
    }

    if (items.length > 0 && items.every((p) => p.status === "failed")) {
        const last = items[0];
        const reason = tidyReason(last.error_description || last.error_reason);
        await Payment.updateOne({ _id: payment._id, paymentStatus: "pending" }, { $set: { paymentStatus: "failed", failureReason: reason, transactionId: payment.transactionId || last.id } });
        await logPaymentEvent({ payment, paymentId: last.id, type: "reconcile.marked_failed", source, level: "warn", message: reason, req });
        return { status: "failed", failureReason: reason, payment };
    }

    // Nothing paid yet. Close orders that have been open for hours with no payment attempt.
    const ageHours = (Date.now() - new Date(payment.createdAt).getTime()) / 3600000;
    if (items.length === 0 && ageHours >= STALE_ORDER_HOURS) {
        await Payment.updateOne({ _id: payment._id, paymentStatus: "pending" }, { $set: { paymentStatus: "failed", failureReason: "Payment not completed" } });
        await logPaymentEvent({ payment, type: "reconcile.expired", source, message: "Order expired without a payment", req });
        return { status: "failed", failureReason: "Payment not completed", payment };
    }
    return { status: "pending", payment };
};

// POST /api/razorpay/verify
const verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: "Missing payment verification fields" });
        }

        const resolvedUser = await resolveUserFromRequest(req);
        const existing = await Payment.findOne({ orderId: razorpay_order_id });

        // A payment can only be confirmed by the user who started it
        if (existing && resolvedUser && String(existing.user) !== String(resolvedUser._id)) {
            await logPaymentEvent({ payment: existing, user: resolvedUser, paymentId: razorpay_payment_id, type: "verify.ownership_mismatch", source: "verify", level: "error", message: "Another user tried to confirm this payment", req });
            return res.status(403).json({ success: false, message: "This payment does not belong to your account" });
        }

        const valid = razorpayService.verifyPaymentSignature({ order_id: razorpay_order_id, payment_id: razorpay_payment_id, signature: razorpay_signature });
        if (!valid) {
            await logPaymentEvent({ payment: existing, user: resolvedUser, orderId: razorpay_order_id, paymentId: razorpay_payment_id, type: "verify.signature_invalid", source: "verify", level: "error", message: "Signature check failed", req });
            return res.status(400).json({ success: false, message: "Invalid signature" });
        }
        await logPaymentEvent({ payment: existing, user: resolvedUser, orderId: razorpay_order_id, paymentId: razorpay_payment_id, type: "verify.signature_ok", source: "verify", req });

        // Authoritative details come from Razorpay itself, never from the app
        let paymentEntity = null;
        try {
            paymentEntity = await razorpayService.fetchPayment(razorpay_payment_id);
        } catch (e) {
            await logPaymentEvent({ payment: existing, orderId: razorpay_order_id, paymentId: razorpay_payment_id, type: "verify.fetch_failed", source: "verify", level: "warn", message: e.message, req });
        }

        const result = await processSuccessfulPayment({
            orderId: razorpay_order_id,
            transactionId: razorpay_payment_id,
            paymentEntity,
            resolvedUser,
            source: "VERIFY",
            req,
        });

        if (!result.payment) {
            const messages = {
                USER_NOT_RESOLVED: "Could not resolve user to associate with payment",
                ORDER_MISMATCH: "Payment does not belong to this order",
                PAYMENT_NOT_CAPTURED: "Your payment is still being processed. Your balance will update shortly.",
                AMOUNT_UNVERIFIED: "Could not verify payment amount. It will be credited once Razorpay confirms it.",
                CURRENCY_MISMATCH: "This payment currency is not supported",
            };
            return res.status(400).json({ success: false, pending: result.reason === "PAYMENT_NOT_CAPTURED", message: messages[result.reason] || "Payment could not be processed" });
        }
        if (result.reason === "AMOUNT_MISMATCH" || result.reason === "NEEDS_REVIEW") {
            return res.status(202).json({ success: false, review: true, message: "Your payment is under review. Our team will update your wallet shortly." });
        }

        return res.status(200).json({
            success: true,
            message: result.claimed ? "Payment verified successfully" : "Payment already processed",
            data: {
                razorpay_order_id,
                razorpay_payment_id,
                paymentId: result.payment._id || null,
                addedAmount: result.creditedAmount != null ? result.creditedAmount : Number(result.payment.amount),
                bonusAmount: result.payment.bonusAmount ? Number(result.payment.bonusAmount) : 0,
                redirect: "/wallet"
            }
        });
    } catch (error) {
        console.error("verifyPayment error:", error);
        return res.status(500).json({ success: false, message: "Could not verify the payment. If money was deducted it will be added automatically." });
    }
};

// GET /api/razorpay/status/:orderId — the app asks this after a UPI redirect, a failure, or when it is reopened
const paymentStatus = async (req, res) => {
    try {
        const user = await resolveUserFromRequest(req);
        if (!user) return res.status(401).json({ success: false, message: "Authentication required" });
        const orderId = String(req.params.orderId || "");
        const payment = await Payment.findOne({ orderId });
        if (!payment || String(payment.user) !== String(user._id)) return res.status(404).json({ success: false, message: "Payment not found" });

        const r = await reconcileOrder(orderId, { source: "client", req });
        return res.json({ success: true, data: { status: r.status, creditedAmount: r.creditedAmount ?? null, bonusAmount: r.bonusAmount ?? 0, failureReason: r.failureReason || null } });
    } catch (e) {
        console.error("paymentStatus error:", e);
        return res.status(500).json({ success: false, message: "Could not check the payment" });
    }
};

// POST /api/razorpay/checkout-result { orderId, outcome: "cancelled" | "failed", code, description }
// The app reports how the checkout ended. The server records it, then checks with Razorpay what really happened
// (the user may have paid in their UPI app and returned in a way the SDK reported as a cancel).
const checkoutResult = async (req, res) => {
    try {
        const user = await resolveUserFromRequest(req);
        if (!user) return res.status(401).json({ success: false, message: "Authentication required" });
        const orderId = String((req.body && req.body.orderId) || "");
        const payment = await Payment.findOne({ orderId });
        if (!payment || String(payment.user) !== String(user._id)) return res.status(404).json({ success: false, message: "Payment not found" });

        const outcome = req.body.outcome === "cancelled" ? "cancelled" : "failed";
        await logPaymentEvent({
            payment, user, type: `client.checkout_${outcome}`, source: "client", level: outcome === "failed" ? "warn" : "info", req,
            message: tidyReason(req.body.description).slice(0, 200), details: { code: req.body.code, raw: String(req.body.description || "").slice(0, 500) }
        });
        const r = await reconcileOrder(orderId, { source: "client", req });
        // The user left with nothing paid: close the order so it does not linger. If a payment lands later
        // (e.g. a slow UPI confirmation), the failed -> success claim still credits it.
        if (r.status === "pending") {
            const reason = outcome === "cancelled" ? "Cancelled by user" : tidyReason(req.body.description);
            await Payment.updateOne({ _id: payment._id, paymentStatus: "pending" }, { $set: { paymentStatus: "failed", failureReason: reason } });
            return res.json({ success: true, data: { status: outcome === "cancelled" ? "cancelled" : "failed", failureReason: reason } });
        }
        return res.json({ success: true, data: { status: r.status, creditedAmount: r.creditedAmount ?? null, bonusAmount: r.bonusAmount ?? 0, failureReason: r.failureReason || null } });
    } catch (e) {
        console.error("checkoutResult error:", e);
        return res.status(500).json({ success: false, message: "Could not record the result" });
    }
};

// POST /api/razorpay/webhook
const webhookHandler = async (req, res) => {
    try {
        const signature = req.headers["x-razorpay-signature"];
        // Obtain raw payload string. When using express.raw the body may be a Buffer.
        let payload;
        if (req.rawBody && typeof req.rawBody === "string") {
            payload = req.rawBody;
        } else if (Buffer.isBuffer(req.body)) {
            payload = req.body.toString();
        } else {
            payload = JSON.stringify(req.body);
        }

        const valid = razorpayService.verifyWebhookSignature({ payload, signature });

        if (!valid) {
            await logPaymentEvent({ type: "webhook.signature_invalid", source: "webhook", level: "error", message: "Rejected webhook with a bad signature", req });
            return res.status(400).send("invalid signature");
        }

        let parsedBody;
        try {
            parsedBody = Buffer.isBuffer(req.body) ? JSON.parse(payload) : req.body;
        } catch (e) {
            return res.status(400).send("invalid payload");
        }

        const event = parsedBody.event;
        const payloadData = parsedBody.payload || {};
        const eventId = req.headers["x-razorpay-event-id"] || null;
        const entity = payloadData.payment && payloadData.payment.entity ? payloadData.payment.entity : null;
        const orderId = (entity && entity.order_id) || (payloadData.order && payloadData.order.entity && payloadData.order.entity.id) || null;

        // The same event can be delivered more than once; handle each id a single time
        const fresh = await logPaymentEvent({
            orderId, paymentId: entity && entity.id, type: `webhook.${event}`, source: "webhook", req,
            webhookEventId: eventId, message: entity ? `${entity.status} ${entity.method || ""}`.trim() : "",
            details: entity ? { amount: entity.amount, status: entity.status, method: entity.method } : null
        });
        if (fresh === "duplicate") return res.status(200).json({ success: true, duplicate: true });

        if ((event === "payment.captured" || event === "order.paid") && entity) {
            let resolvedUser = null;
            if (entity.notes && entity.notes.userId) {
                try { resolvedUser = await User.findById(entity.notes.userId); } catch (e) { /* attribute via the payment record instead */ }
            }
            await processSuccessfulPayment({ orderId, transactionId: entity.id, paymentEntity: entity, resolvedUser, source: "WEBHOOK", req });
        }

        if (event === "payment.failed" && entity) {
            let payment = null;
            if (orderId) payment = await Payment.findOne({ orderId });
            if (!payment && entity.id) payment = await Payment.findOne({ transactionId: entity.id });
            // A failed attempt never overrides a payment that already succeeded
            if (payment && payment.paymentStatus !== "success") {
                payment.paymentStatus = "failed";
                payment.transactionId = payment.transactionId || entity.id;
                payment.failureReason = tidyReason(entity.error_description || entity.error_reason);
                await payment.save();
            }
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("webhookHandler error:", error);
        // 500 makes Razorpay retry the event later
        return res.status(500).json({ success: false, message: "Webhook processing failed" });
    }
};

/**
 * Background safety net, run every minute: settles orders the app never reported, and finishes wallet credits
 * that were interrupted. Money is never lost even if the app is closed or a webhook is missed.
 */
const runReconciliation = async () => {
    const now = Date.now();
    const pending = await Payment.find({
        paymentGateway: "Razorpay", paymentStatus: "pending", orderId: { $ne: null },
        createdAt: { $lte: new Date(now - 90 * 1000), $gte: new Date(now - 7 * 24 * 3600 * 1000) }
    }).sort({ createdAt: 1 }).limit(40).select("orderId").lean();
    for (const p of pending) {
        try { await reconcileOrder(p.orderId, { source: "reconcile" }); } catch (e) { console.error("reconcile failed:", e.message); }
    }

    const stuck = await Payment.find({ paymentStatus: "success", creditPending: true, updatedAt: { $lte: new Date(now - 60 * 1000) } }).limit(20);
    for (const p of stuck) {
        try {
            const amount = creditedOf(p);
            await logPaymentEvent({ payment: p, type: "wallet.credit_retry", source: "reconcile", level: "warn", message: "Finishing an interrupted wallet credit" });
            await creditWallet(p, amount, "reconcile");
        } catch (e) { console.error("credit retry failed:", e.message); }
    }
    return { checked: pending.length, retried: stuck.length };
};

let reconcileTimer = null;
const startReconciliationWorker = (seconds = 60) => {
    if (reconcileTimer) return;
    reconcileTimer = setInterval(() => runReconciliation().catch((e) => console.error("reconciliation run failed:", e.message)), seconds * 1000);
    if (reconcileTimer.unref) reconcileTimer.unref();
};

// GET /api/razorpay/coupons?amount=500  -> coupons this user can use on the payment page
const listCoupons = async (req, res) => {
    try {
        const user = await resolveUserFromRequest(req);
        if (!user) return res.status(401).json({ success: false, message: "Authentication required" });
        const amount = Number(req.query.amount) || 0;
        const data = await couponService.listAvailable({ userId: user._id, amount });
        return res.json({ success: true, data });
    } catch (e) {
        return res.status(500).json({ success: false, message: "Could not load coupons" });
    }
};

// POST /api/razorpay/coupons/validate  { code, amount, method }
const validateCoupon = async (req, res) => {
    try {
        const user = await resolveUserFromRequest(req);
        if (!user) return res.status(401).json({ success: false, message: "Authentication required" });
        const amount = Number(req.body.amount);
        if (!(amount > 0)) return res.status(400).json({ success: false, message: "Enter an amount first" });
        const r = await couponService.validate({ code: req.body.code, userId: user._id, amount, method: req.body.method || null });
        return res.json({ success: true, data: { code: r.coupon.code, name: r.coupon.name, amount, discount: r.discount, payable: r.payable } });
    } catch (e) {
        if (e instanceof couponService.CouponError) return res.status(400).json({ success: false, code: e.code, message: e.message });
        return res.status(500).json({ success: false, message: "Could not check the coupon" });
    }
};

module.exports = {
    listCoupons,
    validateCoupon,
    createOrder,
    verifyPayment,
    paymentStatus,
    checkoutResult,
    webhookHandler,
    reconcileOrder,
    runReconciliation,
    startReconciliationWorker
};
