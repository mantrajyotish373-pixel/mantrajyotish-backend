const User = require("../models/user.model");
const Astrologer = require("../models/astro.model");
const Admin = require("../models/admin.model");
const WalletTransaction = require("../models/walletTransaction.model");
const mongoose = require("mongoose");

/**
 * Pure Billing Calculation Engine for Mantra Jyotish
 * Computes exact per-second pricing without rounding up to full minutes.
 * 
 * Formula:
 *   ratePerSec = perMinuteRate / 60
 *   billableDurationSeconds = Math.max(0, totalDurationSeconds - unbilledGraceSeconds)
 *   totalCost = parseFloat((billableDurationSeconds * ratePerSec).toFixed(2))
 *   astrologerEarnings = parseFloat((totalCost * 0.60).toFixed(2))
 *   platformFee = parseFloat((totalCost - astrologerEarnings).toFixed(2))  <-- Strict financial balance guarantee
 */
const calculateSessionBilling = (totalDurationSeconds = 0, perMinuteRate = 9, unbilledGraceSeconds = 0) => {
    const rate = Number(perMinuteRate) || 9;
    const ratePerSec = rate / 60;
    const rawSeconds = Math.max(0, Number(totalDurationSeconds) || 0);
    const unbilledSecs = Math.max(0, Number(unbilledGraceSeconds) || 0);
    const billableSeconds = Math.max(0, rawSeconds - unbilledSecs);

    const totalCost = parseFloat((billableSeconds * ratePerSec).toFixed(2));
    const astrologerEarnings = parseFloat((totalCost * 0.60).toFixed(2));
    // Ensure exact mathematical parity: totalCost === astrologerEarnings + platformFee
    const platformFee = parseFloat((totalCost - astrologerEarnings).toFixed(2));

    return {
        totalDurationSeconds: rawSeconds,
        unbilledGraceSeconds: unbilledSecs,
        billableSeconds,
        totalDurationMinutes: Math.ceil(billableSeconds / 60),
        perMinuteRate: rate,
        ratePerSec,
        totalCost,
        astrologerEarnings,
        platformFee
    };
};

/**
 * Atomic and Idempotent Wallet Settlement
 * Deducts user wallet balance atomically via MongoDB $inc.
 * Credits astrologer (60%) and admin (40%) balances atomically.
 * Generates an immutable audit record in WalletTransaction.
 * 
 * Idempotency Guarantee:
 * Checks if a successful WalletTransaction already exists for this sessionId.
 * If already settled, returns existing transaction immediately without double-debiting.
 */
const settleWalletBalance = async ({
    userId,
    astrologerId,
    sessionType,
    sessionId,
    sessionCode,
    perMinuteRate,
    totalDurationSeconds,
    totalCost,
    astrologerEarnings,
    platformFee
}) => {
    try {
        if (!userId || !astrologerId) {
            return { success: false, error: "Missing userId or astrologerId" };
        }

        const Session = mongoose.models.Session || require("../models/session.model");

        // 1. Idempotency Check: Check if session has already been settled in WalletTransaction ledger
        if (sessionId) {
            const existingTxn = await WalletTransaction.findOne({
                sessionId: sessionId,
                status: "SUCCESS"
            });

            if (existingTxn) {
                console.log(`ℹ️ [Idempotency Guard] Session ${sessionId} was already settled in transaction ${existingTxn.transactionId}. Skipping duplicate deduction.`);
                await Session.findByIdAndUpdate(sessionId, {
                    billingSettled: true,
                    billingSettlementStatus: "SETTLED"
                }).catch(() => null);

                return {
                    success: true,
                    alreadySettled: true,
                    transactionId: existingTxn.transactionId,
                    settledAmount: existingTxn.amountDeducted
                };
            }
        }

        // If zero cost, mark settled as zero amount
        if (totalCost <= 0) {
            if (sessionId) {
                await Session.findByIdAndUpdate(sessionId, {
                    billingSettled: true,
                    billingSettlementStatus: "ZERO_AMOUNT"
                }).catch(() => null);
            }
            return { success: true, settledAmount: 0 };
        }

        // 2. Fetch user balance snapshot before deduction
        const userBefore = await User.findById(userId).select("walletBalance");
        const userBalanceBefore = userBefore ? Number(userBefore.walletBalance || 0) : 0;

        // 3. Atomically debit user balance
        const updatedUser = await User.findByIdAndUpdate(
            userId,
            { $inc: { walletBalance: -totalCost } },
            { new: true }
        );

        if (updatedUser && updatedUser.walletBalance < 0) {
            await User.findByIdAndUpdate(userId, { $set: { walletBalance: 0 } });
        }
        const userBalanceAfter = updatedUser ? Math.max(0, Number(updatedUser.walletBalance)) : 0;

        // 4. Atomically credit astrologer wallet (60%)
        if (astrologerEarnings > 0) {
            await Astrologer.findByIdAndUpdate(
                astrologerId,
                { $inc: { walletBalance: astrologerEarnings } }
            );
        }

        // 5. Atomically credit admin platform fee (40%)
        if (platformFee > 0) {
            await Admin.findOneAndUpdate(
                { role: "superadmin" },
                { $inc: { walletBalance: platformFee } },
                { upsert: true }
            );
        }

        // 6. Generate Immutable Wallet Transaction Audit Log
        const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
        await WalletTransaction.create({
            transactionId,
            user: userId,
            astrologer: astrologerId,
            sessionType: sessionType || "CHAT",
            sessionId: sessionId,
            sessionCode: sessionCode || null,
            ratePerMinute: perMinuteRate,
            durationSeconds: totalDurationSeconds,
            totalDurationMinutes: Math.ceil(totalDurationSeconds / 60),
            amountDeducted: totalCost,
            astrologerEarnings,
            platformFee,
            userBalanceBefore,
            userBalanceAfter,
            status: "SUCCESS"
        });

        // 7. Update Session billing settlement status in DB
        if (sessionId) {
            await Session.findByIdAndUpdate(sessionId, {
                billingSettled: true,
                billingSettlementStatus: "SETTLED",
                totalAmount: totalCost,
                totalAmountDeducted: totalCost,
                astrologerEarnings,
                platformFee
            }).catch(() => null);
        }

        console.log(`💰 [Atomic Settlement] Complete: Session ${sessionId} -> User -₹${totalCost}, Astro +₹${astrologerEarnings}, Plat +₹${platformFee}`);
        return {
            success: true,
            transactionId,
            settledAmount: totalCost,
            userBalanceAfter
        };
    } catch (err) {
        console.error(`❌ Atomic settlement error for session ${sessionId}:`, err.message);
        return {
            success: false,
            error: err.message
        };
    }
};

/**
 * Crash Recovery Reconciler
 * Scans for COMPLETED sessions that were never settled due to a process crash / network drop.
 */
const reconcileUnsettledCompletedSessions = async () => {
    try {
        const Session = mongoose.models.Session || require("../models/session.model");
        const unsettledSessions = await Session.find({
            status: "COMPLETED",
            billingSettled: { $ne: true }
        });

        if (!unsettledSessions || unsettledSessions.length === 0) {
            return { reconciledCount: 0 };
        }

        console.log(`🔍 [Crash Recovery Reconciler] Found ${unsettledSessions.length} unsettled completed sessions.`);
        let reconciledCount = 0;

        for (const session of unsettledSessions) {
            const startedAt = session.startedAt || session.startTime;
            const endedAt = session.endedAt || session.endTime || new Date();
            const rawSecs = startedAt ? Math.max(0, Math.floor((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000)) : 0;
            const unbilledSecs = (session.disconnectState && session.disconnectState.unbilledGraceSeconds) || 0;

            const billing = calculateSessionBilling(rawSecs, session.perMinuteRate || 9, unbilledSecs);

            const result = await settleWalletBalance({
                userId: session.user,
                astrologerId: session.astrologer,
                sessionType: session.type,
                sessionId: session._id,
                sessionCode: session.sessionCode,
                perMinuteRate: billing.perMinuteRate,
                totalDurationSeconds: billing.billableSeconds,
                totalCost: billing.totalCost,
                astrologerEarnings: billing.astrologerEarnings,
                platformFee: billing.platformFee
            });

            if (result.success) {
                reconciledCount++;
            }
        }

        console.log(`✅ [Crash Recovery Reconciler] Successfully reconciled ${reconciledCount} sessions.`);
        return { reconciledCount };
    } catch (err) {
        console.error("❌ Error running reconcileUnsettledCompletedSessions:", err.message);
        return { error: err.message };
    }
};

module.exports = {
    calculateSessionBilling,
    settleWalletBalance,
    reconcileUnsettledCompletedSessions
};
