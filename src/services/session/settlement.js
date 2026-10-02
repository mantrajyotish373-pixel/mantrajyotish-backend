/**
 * Idempotent settlement: ENDING -> (compute once) -> apply wallet legs -> COMPLETED.
 *
 * Money rules are the existing ones (sessionBilling.service.calculateSessionBilling and the
 * amounts settleWalletBalance used to apply). What changes is HOW they are applied:
 *
 *  - The billing numbers are computed once and stored on the session, so every retry uses
 *    identical figures.
 *  - Each wallet change is ONE atomic single-document update that also records the session id
 *    on that wallet (`settledSessions`) in the same write. Applying a leg twice is a no-op, so a
 *    crash between legs is repaired by simply running settlement again. No transaction needed.
 *  - The ledger row is unique per session (unique index on WalletTransaction.sessionId).
 *  - The final ENDING -> COMPLETED transition is a status-guarded update: one winner.
 */
const mongoose = require("mongoose");
const Session = require("../../models/session.model");
const User = require("../../models/user.model");
const Astrologer = require("../../models/astro.model");
const Admin = require("../../models/admin.model");
const WalletTransaction = require("../../models/walletTransaction.model");
const PromoLedger = require("../../models/promoLedger.model");
const { calculateSessionBilling } = require("../sessionBilling.service");
const { splitCostForBonus, consumeGrants } = require("../bonus.service");
const { STATUS } = require("./states");
const { SessionError } = require("./errors");
const availability = require("./availability");
const { scheduleMirror } = require("./legacyMirror");
const { runInBackground } = require("./background");

const MARKER_LIMIT = 200; // wallets keep only the most recent settled session ids

const ms = (d) => new Date(d).getTime();

/** Same inputs the legacy endSession used: raw duration minus unbilled astrologer-absence seconds. */
const computeBilling = (session) => {
    const startedAt = session.startedAt || session.startTime;
    const endedAt = session.endedAt || session.endTime;
    const rawSeconds = startedAt && endedAt ? Math.max(0, Math.floor((ms(endedAt) - ms(startedAt)) / 1000)) : 0;

    let unbilledSeconds = (session.disconnectState && session.disconnectState.unbilledGraceSeconds) || 0;
    const astroConn = session.connection && session.connection.astrologer;
    if (astroConn && astroConn.state === "RECONNECTING" && astroConn.since && endedAt) {
        // astrologer was still away when the session ended: that absence is unbilled too
        const from = Math.max(ms(astroConn.since), ms(startedAt));
        unbilledSeconds += Math.max(0, Math.floor((ms(endedAt) - from) / 1000));
    }
    return calculateSessionBilling(rawSeconds, session.perMinuteRate, unbilledSeconds);
};

const markerPush = (sid) => ({ $push: { settledSessions: { $each: [sid], $slice: -MARKER_LIMIT } } });

/**
 * user wallet: max(0, balance - cost), once per session. The marker { sid, before, after } is
 * written in the same atomic update (all expressions in one $set stage read the pre-update
 * document), so the audit values can always be read back, whichever caller applied the leg.
 */
const applyUserLeg = async (session, totalCost, bonusAmount = 0) => {
    const sid = session._id;
    const balance = { $ifNull: ["$walletBalance", 0] };
    const bonus = { $ifNull: ["$bonusBalance", 0] };
    const newWallet = { $max: [0, { $subtract: [balance, totalCost] }] };
    // bonus part shrinks by exactly what this session used from it, and can never exceed the wallet
    const newBonus = { $min: [{ $max: [0, { $subtract: [bonus, bonusAmount] }] }, newWallet] };
    await User.findOneAndUpdate(
        { _id: session.user, "settledSessions.sid": { $ne: sid } },
        [
            {
                $set: {
                    walletBalance: newWallet,
                    bonusBalance: newBonus,
                    settledSessions: {
                        $slice: [
                            {
                                $concatArrays: [
                                    { $ifNull: ["$settledSessions", []] },
                                    [{ sid, before: balance, after: { $max: [0, { $subtract: [balance, totalCost] }] } }]
                                ]
                            },
                            -MARKER_LIMIT
                        ]
                    }
                }
            }
        ],
        { returnDocument: "before", updatePipeline: true }
    ).select("walletBalance").lean();

    // Read the recorded values back (the marker exists now, whoever applied it)
    const doc = await User.findOne({ _id: session.user, "settledSessions.sid": sid })
        .select({ settledSessions: { $elemMatch: { sid } } })
        .lean();
    const entry = doc && doc.settledSessions && doc.settledSessions[0];
    return entry ? { before: entry.before, after: entry.after } : null;
};

const applyAstrologerLeg = async (session, earnings, promoSeconds = 0) => {
    if (!(earnings > 0) && !(promoSeconds > 0)) return;
    const sid = session._id;
    const inc = {};
    if (earnings > 0) inc.walletBalance = earnings;
    if (promoSeconds > 0) { inc.promoSecondsPending = promoSeconds; inc.promoSecondsEarnedTotal = promoSeconds; }
    await Astrologer.updateOne(
        { _id: session.astrologer, settledSessions: { $ne: sid } },
        { $inc: inc, ...markerPush(sid) }
    );
};

// The platform wallet always lives on the (oldest) superadmin, never on a sub-admin.
const PLATFORM_FILTER = { role: "superadmin" };

const applyAdminLeg = async (session, platformFee) => {
    if (!(platformFee > 0)) return;
    const sid = session._id;
    const admin = await Admin.findOne(PLATFORM_FILTER).sort({ createdAt: 1 }).select("_id").lean();
    if (admin) {
        await Admin.updateOne(
            { _id: admin._id, settledSessions: { $ne: sid } },
            { $inc: { walletBalance: platformFee }, ...markerPush(sid) }
        );
        return;
    }
    // No admin yet: the legacy code created one via upsert. Keep that, retrying once on the
    // unique-email race between two first-ever settlements.
    try {
        await Admin.findOneAndUpdate(PLATFORM_FILTER, { $inc: { walletBalance: platformFee }, ...markerPush(sid) }, { upsert: true });
    } catch (err) {
        if (err.code !== 11000) throw err;
        const created = await Admin.findOne(PLATFORM_FILTER).sort({ createdAt: 1 }).select("_id").lean();
        if (created) {
            await Admin.updateOne(
                { _id: created._id, settledSessions: { $ne: sid } },
                { $inc: { walletBalance: platformFee }, ...markerPush(sid) }
            );
        }
    }
};

const writeLedger = async (session, billing, balances) => {
    const transactionId = `TXN-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    await WalletTransaction.updateOne(
        { sessionId: session._id },
        {
            $setOnInsert: {
                transactionId,
                user: session.user,
                astrologer: session.astrologer,
                sessionType: session.type,
                sessionCode: session.sessionCode || null,
                ratePerMinute: billing.perMinuteRate,
                durationSeconds: billing.billableSeconds,
                totalDurationMinutes: Math.ceil(billing.billableSeconds / 60),
                amountDeducted: billing.totalCost,
                astrologerEarnings: billing.astrologerEarnings,
                platformFee: billing.platformFee,
                bonusAmountUsed: billing.bonusAmount || 0,
                cashAmountUsed: billing.cashAmount != null ? billing.cashAmount : billing.totalCost,
                promoSeconds: billing.bonusSeconds || 0,
                userBalanceBefore: balances ? balances.before : 0,
                userBalanceAfter: balances ? balances.after : 0,
                status: "SUCCESS"
            }
        },
        { upsert: true }
    );
    if (billing.bonusSeconds > 0) {
        await PromoLedger.updateOne(
            { session: session._id },
            { $setOnInsert: { sessionType: session.type, astrologer: session.astrologer, user: session.user, seconds: billing.bonusSeconds, bonusAmount: billing.bonusAmount } },
            { upsert: true }
        );
    }
};

/**
 * Settles an ENDING session. Safe to call any number of times, concurrently, from any instance.
 * Returns the COMPLETED session (or the session unchanged if there is nothing to settle).
 */
const settleSession = async (sessionId, { now = new Date() } = {}) => {
    let session = await Session.findById(sessionId).lean();
    if (!session) throw new SessionError("SESSION_NOT_FOUND", "Session not found", 404);
    if (session.status !== STATUS.ENDING) return session; // COMPLETED already, or never billable

    await Session.updateOne(
        { _id: session._id, status: STATUS.ENDING },
        { $inc: { "settlement.attempts": 1 }, $set: { "settlement.lastAttemptAt": now, "settlement.state": "IN_PROGRESS" } }
    );

    // 1. Compute once. Later attempts reuse the stored numbers.
    if (!(session.settlement && session.settlement.computed)) {
        const b = computeBilling(session);
        // Bonus is spent first. Only the CASH part earns the astrologer rupees (60/40); the bonus part
        // becomes free-session seconds. With no bonus this equals the original numbers exactly.
        const owner = await User.findById(session.user).select("walletBalance bonusBalance").lean();
        const availableBonus = Math.min((owner && owner.bonusBalance) || 0, (owner && owner.walletBalance) || 0);
        const split = splitCostForBonus(b.totalCost, b.billableSeconds, availableBonus);
        b.astrologerEarnings = split.astrologerEarnings;
        b.platformFee = split.platformFee;
        const persisted = await Session.findOneAndUpdate(
            { _id: session._id, status: STATUS.ENDING, "settlement.computed": { $ne: true } },
            {
                $set: {
                    "settlement.computed": true,
                    "settlement.billing": {
                        rawSeconds: b.totalDurationSeconds,
                        unbilledSeconds: b.unbilledGraceSeconds,
                        billableSeconds: b.billableSeconds,
                        perMinuteRate: b.perMinuteRate,
                        totalCost: b.totalCost,
                        astrologerEarnings: b.astrologerEarnings,
                        platformFee: b.platformFee,
                        bonusAmount: split.bonusAmount,
                        cashAmount: split.cashAmount,
                        bonusSeconds: split.bonusSeconds
                    },
                    bonusAmountUsed: split.bonusAmount,
                    promoSeconds: split.bonusSeconds,
                    totalDurationSeconds: b.billableSeconds,
                    totalDurationMinutes: b.totalDurationMinutes,
                    duration: b.totalDurationMinutes,
                    totalAmount: b.totalCost,
                    totalAmountDeducted: b.totalCost,
                    astrologerEarnings: b.astrologerEarnings,
                    platformFee: b.platformFee
                }
            },
            { returnDocument: "after" }
        ).lean();
        session = persisted || (await Session.findById(sessionId).lean());
    }

    const billing = session.settlement.billing;
    const legs = session.settlement.legs || {};

    // 2. Apply wallet legs (each idempotent by itself)
    if (billing.totalCost > 0) {
        let userBalances = null;
        if (!legs.user || !legs.ledger) {
            userBalances = await applyUserLeg(session, billing.totalCost, billing.bonusAmount || 0);
            await Session.updateOne(
                { _id: session._id },
                {
                    $set: {
                        "settlement.legs.user": true,
                        ...(userBalances
                            ? { "settlement.userBalanceBefore": userBalances.before, "settlement.userBalanceAfter": userBalances.after }
                            : {})
                    }
                }
            );
        }
        if (!legs.astrologer) {
            await applyAstrologerLeg(session, billing.astrologerEarnings, billing.bonusSeconds || 0);
            await Session.updateOne({ _id: session._id }, { $set: { "settlement.legs.astrologer": true } });
        }
        if (!legs.grants) {
            if (billing.bonusAmount > 0) await consumeGrants(session.user, billing.bonusAmount);
            await Session.updateOne({ _id: session._id }, { $set: { "settlement.legs.grants": true } });
        }
        if (!legs.admin) {
            await applyAdminLeg(session, billing.platformFee);
            await Session.updateOne({ _id: session._id }, { $set: { "settlement.legs.admin": true } });
        }
        if (!legs.ledger) {
            await writeLedger(session, billing, userBalances);
            await Session.updateOne({ _id: session._id }, { $set: { "settlement.legs.ledger": true } });
        }
    }

    // 3. Finalise: exactly one caller wins ENDING -> COMPLETED
    const done = await Session.findOneAndUpdate(
        { _id: session._id, status: STATUS.ENDING },
        {
            $set: {
                status: STATUS.COMPLETED,
                liveLock: false,
                billingSettled: true,
                billingSettlementStatus: billing.totalCost > 0 ? "SETTLED" : "ZERO_AMOUNT",
                "settlement.state": "DONE"
            }
        },
        { returnDocument: "after" }
    ).lean();

    if (!done) return Session.findById(sessionId).lean(); // another caller finalised it

    scheduleMirror(done);
    runInBackground(availability.markFree(done.astrologer), "availability");
    return done;
};

module.exports = { settleSession, computeBilling, MARKER_LIMIT };
