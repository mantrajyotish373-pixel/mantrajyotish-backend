const Razorpay = require("razorpay");
const config = require("../config/config");
const crypto = require("crypto");

const instance = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret
});

// Constant-time comparison of hex HMAC signatures
const safeEqualHex = (expected, received) => {
    if (typeof received !== "string" || received.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(received, "utf8"));
};

const createOrder = async ({ amount, currency = "INR", receipt = null, payment_capture = 1, notes = null } = {}) => {
    if (!amount || Number(amount) <= 0) throw new Error("Invalid amount");

    // Razorpay expects amount in paise
    const amountInPaise = Math.round(Number(amount) * 100);

    const options = {
        amount: amountInPaise,
        currency,
        payment_capture: payment_capture,
    };

    if (receipt) options.receipt = receipt;
    if (notes) options.notes = notes;

    const order = await instance.orders.create(options);
    return order;
};

const verifyPaymentSignature = ({ order_id, payment_id, signature }) => {
    const generated_signature = crypto.createHmac('sha256', config.razorpay.keySecret)
        .update(`${order_id}|${payment_id}`)
        .digest('hex');

    return safeEqualHex(generated_signature, signature);
};

const fetchPayment = async (payment_id) => {
    if (!payment_id) throw new Error('payment_id is required');
    const payment = await instance.payments.fetch(payment_id);
    return payment;
};

// All payment attempts Razorpay has on record for an order (used to recover payments the app never reported)
const fetchOrderPayments = async (order_id) => {
    if (!order_id) throw new Error("order_id is required");
    const res = await instance.orders.fetchPayments(order_id);
    return (res && res.items) || [];
};

// Captures an authorized payment (auto-capture normally does this, but the status can lag by a moment)
const capturePayment = async (payment_id, amountPaise, currency = "INR") => {
    return instance.payments.capture(payment_id, amountPaise, currency);
};

const verifyWebhookSignature = ({ payload, signature }) => {
    const secret = config.razorpay.webhookSecret;
    if (!secret) {
        console.error("RAZORPAY_WEBHOOK_SECRET is not configured; rejecting webhook.");
        return false;
    }

    const generated = crypto.createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

    return safeEqualHex(generated, signature);
};

module.exports = {
    createOrder,
    verifyPaymentSignature,
    verifyWebhookSignature,
    fetchPayment,
    fetchOrderPayments,
    capturePayment
};
