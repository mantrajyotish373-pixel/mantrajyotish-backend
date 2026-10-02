const PaymentEvent = require("../models/paymentEvent.model");

const SECRET_KEY = /secret|signature|token|password|card|cvv|authorization|vpa|upi_id|email|contact/i;

// Keeps useful ids and amounts, drops anything that looks sensitive.
const scrub = (value, depth = 0) => {
    if (value == null || depth > 3) return value == null ? value : "[nested]";
    if (Array.isArray(value)) return value.slice(0, 10).map((v) => scrub(v, depth + 1));
    if (typeof value === "object") {
        const out = {};
        for (const [k, v] of Object.entries(value).slice(0, 40)) out[k] = SECRET_KEY.test(k) ? "[hidden]" : scrub(v, depth + 1);
        return out;
    }
    if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "…" : value;
    return value;
};

const ipOf = (req) => {
    if (!req) return "";
    const xff = req.headers && req.headers["x-forwarded-for"];
    return xff ? String(xff).split(",").pop().trim() : (req.ip || "");
};

/**
 * Records one payment event. Never throws: logging must not break a payment.
 * Returns true if stored, false if it failed or (for webhooks) the event id was already seen.
 */
const logPaymentEvent = async ({ payment = null, user = null, orderId = null, paymentId = null, type, source = "system", level = "info", message = "", details = null, req = null, webhookEventId = null }) => {
    try {
        await PaymentEvent.create({
            payment: payment && (payment._id || payment),
            user: (user && (user._id || user)) || (payment && payment.user) || null,
            orderId: orderId || (payment && payment.orderId) || null,
            paymentId: paymentId || (payment && payment.transactionId) || null,
            type, source, level, message: String(message).slice(0, 300),
            details: scrub(details), ip: ipOf(req), webhookEventId
        });
        if (level !== "info") console.warn(`[PAYMENT_${level.toUpperCase()}] ${type} order=${orderId || ""} ${message}`);
        return true;
    } catch (e) {
        if (e && e.code === 11000) return "duplicate"; // same webhook event id seen before
        console.error("payment event log failed:", e.message);
        return false;
    }
};

module.exports = { logPaymentEvent };
