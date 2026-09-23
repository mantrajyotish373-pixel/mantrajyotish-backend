const razorpayService = require("../services/razorpay.service");
const User = require("../models/user.model");
const Payment = require("../models/payment.model");
const Appointment = require("../models/appointment.model");
const mongoose = require("mongoose");

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

/** Shared helper to robustly resolve user from request headers or body */
const resolveUserFromRequest = async (req) => {
    let identifier = null;

    // 1. Try finding via Authorization JWT token
    if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
        try {
            const { verifyToken } = require("../utils/jwt");
            const decoded = verifyToken(req.headers.authorization.split(" ")[1]);
            identifier = decoded.userId || decoded.id || decoded._id || decoded.phone || null;
        } catch (e) {
            // Ignore token verification errors (e.g. expired tokens)
        }
    }

    // 2. Fallback to request body parameters
    if (!identifier) {
        identifier = req.body.userId || req.body.user_id || req.body.phone || req.body.id || null;
    }

    const phoneFallback = req.body.phone || null;
    if (!identifier && !phoneFallback) return null;

    return await findUserByIdentifier(identifier, phoneFallback);
};

// POST /api/razorpay/order
const createOrder = async (req, res) => {
    try {
        const { amount, currency, receipt, payment_capture } = req.body;

        if (!amount || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Invalid amount" });
        }

        // Robustly resolve user
        const user = await resolveUserFromRequest(req);
        if (!user) {
            return res.status(401).json({ success: false, message: "Authentication required or user not found" });
        }

        const order = await razorpayService.createOrder({ amount, currency, receipt, payment_capture });

        // Persist a Payment record (pending) so we can reconcile later.
        const appointmentId = req.body.appointmentId || req.body.appointment || null;

        const paymentData = {
            user: user._id,
            amount: Number(amount),
            currency: currency || "INR",
            paymentGateway: "Razorpay",
            paymentStatus: "pending",
            orderId: order.id
        };

        if (appointmentId && mongoose.Types.ObjectId.isValid(appointmentId)) paymentData.appointment = appointmentId;

        let paymentRecord = null;
        try {
            paymentRecord = await Payment.create(paymentData);
        } catch (e) {
            console.warn("Could not create payment record:", e.message);
        }

        return res.status(201).json({ success: true, data: { order, keyId: process.env.RAZORPAY_KEY_ID || null, payment: paymentRecord } });
    } catch (error) {
        console.error("createOrder error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// Helper function for atomic payment verification and wallet crediting
const processSuccessfulPayment = async ({
    orderId,
    transactionId,
    paymentEntity = null,
    clientAmount = null,
    resolvedUser = null,
    currency = 'INR',
    source = 'VERIFY', // 'VERIFY' | 'WEBHOOK'
}) => {
    // 1. Authoritative Amount Calculation: prefer Razorpay paymentEntity (in paise -> rupees)
    let creditedAmount = null;
    if (paymentEntity && paymentEntity.amount) {
        creditedAmount = Number(paymentEntity.amount) / 100;
    } else if (clientAmount) {
        creditedAmount = Number(clientAmount);
    }

    // 2. Find existing payment record by orderId or transactionId
    let payment = null;
    if (orderId) payment = await Payment.findOne({ orderId });
    if (!payment && transactionId) payment = await Payment.findOne({ transactionId });

    // 3. Handle missing payment record (e.g. order created outside or missing DB record)
    if (!payment) {
        if (!resolvedUser) {
            console.warn(`[${source}_CLAIM_FAIL] No payment record and could not resolve user. Order: ${orderId}`);
            return { claimed: false, reason: 'USER_NOT_RESOLVED', payment: null };
        }
        try {
            const finalAmt = creditedAmount != null ? creditedAmount : (clientAmount ? Number(clientAmount) : 0);
            payment = await Payment.create({
                user: resolvedUser._id,
                amount: finalAmt,
                currency: currency || (paymentEntity ? paymentEntity.currency : 'INR'),
                paymentGateway: 'Razorpay',
                paymentStatus: 'pending', // created as pending first so we can claim atomically
                orderId: orderId || null,
                transactionId: transactionId || null,
            });
            console.log(`[${source}_RECORD_CREATED] Created pending payment record: ${payment._id}`);
        } catch (e) {
            // Handle race condition where another concurrent worker created the record first
            console.warn(`[${source}_CREATE_RACE] Payment create collision: ${e.message}`);
            if (orderId) payment = await Payment.findOne({ orderId });
            if (!payment && transactionId) payment = await Payment.findOne({ transactionId });
            if (!payment) {
                return { claimed: false, reason: 'CREATE_FAILED', payment: null, error: e.message };
            }
        }
    }

    // Check if already processed
    if (payment.paymentStatus === 'success') {
        console.log(`[${source}_ALREADY_PROCESSED] Payment ${payment._id} (${orderId || transactionId}) already marked success.`);
        return { claimed: false, reason: 'ALREADY_SUCCESS', payment, creditedAmount: payment.amount };
    }

    // 4. ATOMIC CLAIM: Attempt to transition status from pending/failed -> success atomically
    const claimedPayment = await Payment.findOneAndUpdate(
        {
            _id: payment._id,
            paymentStatus: { $ne: 'success' },
        },
        {
            $set: {
                paymentStatus: 'success',
                transactionId: transactionId || payment.transactionId,
                paidAt: payment.paidAt || new Date(),
                amount: creditedAmount != null ? creditedAmount : payment.amount,
                ...(resolvedUser && !payment.user ? { user: resolvedUser._id } : {}),
            },
        },
        { new: true }
    );

    if (!claimedPayment) {
        console.log(`[${source}_CLAIM_LOST] Concurrent worker claimed payment ${payment._id} simultaneously.`);
        const latest = await Payment.findById(payment._id);
        return { claimed: false, reason: 'CLAIM_LOST', payment: latest, creditedAmount: latest?.amount };
    }

    console.log(`[${source}_CLAIMED_SUCCESS] Successfully claimed payment ${claimedPayment._id} for processing.`);

    // 5. ATOMIC WALLET CREDIT ($inc)
    const finalCreditedAmt = creditedAmount != null ? creditedAmount : Number(claimedPayment.amount);
    if (claimedPayment.appointment) {
        try {
            await Appointment.findByIdAndUpdate(claimedPayment.appointment, {
                appointmentStatus: 'confirmed',
                paymentStatus: 'paid',
            });
            console.log(`[${source}_APPOINTMENT_CONFIRMED] Appointment ${claimedPayment.appointment} confirmed.`);
        } catch (e) {
            console.warn(`[${source}_APPOINTMENT_ERR] Failed to confirm appointment:`, e.message);
        }
    } else if (claimedPayment.user) {
        try {
            await User.findByIdAndUpdate(claimedPayment.user, {
                $inc: { walletBalance: finalCreditedAmt },
            });
            console.log(`[${source}_WALLET_CREDITED] Atomic $inc credited ₹${finalCreditedAmt} to user ${claimedPayment.user}`);
        } catch (e) {
            console.error(`[${source}_WALLET_ERR] Failed to credit wallet:`, e.message);
        }
    }

    return { claimed: true, payment: claimedPayment, creditedAmount: finalCreditedAmt };
};

// POST /api/razorpay/verify
const verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, amount } = req.body;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ success: false, message: "Missing payment verification fields" });
        }

        const valid = razorpayService.verifyPaymentSignature({ order_id: razorpay_order_id, payment_id: razorpay_payment_id, signature: razorpay_signature });

        if (!valid) {
            return res.status(400).json({ success: false, message: "Invalid signature" });
        }

        // Fetch payment details from Razorpay to get authoritative amount (in paise)
        let paymentEntity = null;
        try {
            paymentEntity = await razorpayService.fetchPayment(razorpay_payment_id);
        } catch (e) {
            console.warn("Could not fetch payment entity from Razorpay:", e.message);
        }

        const resolvedUser = await resolveUserFromRequest(req);

        const result = await processSuccessfulPayment({
            orderId: razorpay_order_id,
            transactionId: razorpay_payment_id,
            paymentEntity,
            clientAmount: amount,
            resolvedUser,
            currency: req.body.currency,
            source: 'VERIFY',
        });

        if (!result.payment && result.reason === 'USER_NOT_RESOLVED') {
            return res.status(400).json({ success: false, message: "Could not resolve user to associate with payment" });
        }

        return res.status(200).json({
            success: true,
            message: result.claimed ? "Payment verified successfully" : "Payment already processed",
            data: {
                razorpay_order_id,
                razorpay_payment_id,
                paymentId: result.payment?._id || null,
                addedAmount: result.creditedAmount != null ? result.creditedAmount : (result.payment ? Number(result.payment.amount) : null),
                redirect: "/wallet"
            }
        });
    } catch (error) {
        console.error("verifyPayment error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

// POST /api/razorpay/webhook
const webhookHandler = async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        // Obtain raw payload string. When using express.raw the body may be a Buffer.
        let payload;
        if (req.rawBody && typeof req.rawBody === 'string') {
            payload = req.rawBody;
        } else if (Buffer.isBuffer(req.body)) {
            payload = req.body.toString();
        } else {
            payload = JSON.stringify(req.body);
        }

        const valid = razorpayService.verifyWebhookSignature({ payload, signature });

        if (!valid) {
            console.warn("Invalid webhook signature");
            return res.status(400).send('invalid signature');
        }

        const event = req.body.event;
        const payloadData = req.body.payload || {};

        // Example: payment captured
        if (event === "payment.captured") {
            const paymentEntity = payloadData.payment && payloadData.payment.entity ? payloadData.payment.entity : null;
            if (paymentEntity) {
                const orderId = paymentEntity.order_id || null;
                const paymentId = paymentEntity.id || null;

                let resolvedUser = null;
                if (paymentEntity.notes && paymentEntity.notes.userId) {
                    try {
                        resolvedUser = await User.findById(paymentEntity.notes.userId);
                    } catch (e) {}
                }

                await processSuccessfulPayment({
                    orderId,
                    transactionId: paymentId,
                    paymentEntity,
                    clientAmount: null,
                    resolvedUser,
                    currency: paymentEntity.currency || 'INR',
                    source: 'WEBHOOK',
                });
            }
        }

        // Handle payment.failed
        if (event === "payment.failed") {
            const paymentEntity = payloadData.payment && payloadData.payment.entity ? payloadData.payment.entity : null;
            if (paymentEntity) {
                const orderId = paymentEntity.order_id || null;
                const paymentId = paymentEntity.id || null;
                try {
                    let payment = null;
                    if (orderId) payment = await Payment.findOne({ orderId });
                    if (!payment && paymentId) payment = await Payment.findOne({ transactionId: paymentId });
                    if (payment) {
                        if (payment.paymentStatus === "success") {
                            console.log(`[WEBHOOK_FAIL_IGNORED] Payment ${payment._id} already marked success.`);
                            return res.status(200).json({ success: true });
                        }
                        payment.paymentStatus = "failed";
                        payment.transactionId = paymentId;
                        await payment.save();
                        console.log(`[WEBHOOK_PAYMENT_FAILED] Payment ${payment._id} marked as failed.`);
                    }
                } catch (e) {
                    console.error("Error processing webhook payment.failed:", e);
                }
            }
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("webhookHandler error:", error);
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    createOrder,
    verifyPayment,
    webhookHandler
};

