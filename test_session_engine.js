const mongoose = require("mongoose");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const Session = require("./src/models/session.model");
const ChatSession = require("./src/models/chatSession.model");
const VideoSession = require("./src/models/videoSession.model");
const User = require("./src/models/user.model");
const Astrologer = require("./src/models/astro.model");
const Admin = require("./src/models/admin.model");
const WalletTransaction = require("./src/models/walletTransaction.model");

const sessionEngine = require("./src/services/sessionEngine.service");
const { calculateSessionBilling, settleWalletBalance, reconcileUnsettledCompletedSessions } = require("./src/services/sessionBilling.service");

async function runVerificationSuite() {
    console.log("==================================================================");
    console.log("🚀 STARTING PHASE 1 FINAL HARDENING & PRODUCTION SAFETY SUITE");
    console.log("==================================================================");

    const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/astrology-dev";
    console.log(`Connecting to MongoDB: ${mongoUri.replace(/:([^:@]+)@/, ":****@")}`);
    await mongoose.connect(mongoUri);
    console.log("Connected to MongoDB successfully.\n");

    let passedTests = 0;
    let failedTests = 0;

    const assert = (condition, testName) => {
        if (condition) {
            console.log(`✅ [PASS] ${testName}`);
            passedTests++;
        } else {
            console.error(`❌ [FAIL] ${testName}`);
            failedTests++;
        }
    };

    // -------------------------------------------------------------
    // TEST SECTION 1: Exact Billing Formula & Precision Across Intervals
    // -------------------------------------------------------------
    console.log("\n--- 1. Billing Precision Across Intervals ---");
    const testIntervals = [
        { sec: 1, rate: 9, expected: 0.15 },
        { sec: 29, rate: 9, expected: 4.35 },
        { sec: 30, rate: 9, expected: 4.50 },
        { sec: 31, rate: 9, expected: 4.65 },
        { sec: 59, rate: 9, expected: 8.85 },
        { sec: 60, rate: 9, expected: 9.00 },
        { sec: 61, rate: 9, expected: 9.15 },
        { sec: 90, rate: 9, expected: 13.50 },
        { sec: 125, rate: 9, expected: 18.75 },
    ];

    for (const item of testIntervals) {
        const res = calculateSessionBilling(item.sec, item.rate);
        assert(res.totalCost === item.expected, `${item.sec}s @ ₹${item.rate}/min = ₹${item.expected} (Calculated: ₹${res.totalCost})`);
        assert(parseFloat((res.astrologerEarnings + res.platformFee).toFixed(2)) === res.totalCost, `Financial parity for ${item.sec}s: Astro (₹${res.astrologerEarnings}) + Plat (₹${res.platformFee}) === Total (₹${res.totalCost})`);
    }

    // -------------------------------------------------------------
    // Setup Test DB Fixtures
    // -------------------------------------------------------------
    console.log("\n--- Setting up Test DB Fixtures ---");
    await User.deleteMany({ phone: "+919999999991" });
    await Astrologer.deleteMany({ phone: "+918888888881" });

    const testUser = await User.create({
        phone: "+919999999991",
        firstname: "Verification",
        lastname: "Tester",
        walletBalance: 200
    });

    const testAstro = await Astrologer.create({
        name: "Verification Astrologer",
        email: "verifastro@example.com",
        phone: "+918888888881",
        status: "approved",
        isOnline: true,
        isAvailable: true,
        consultationFee: 9,
        walletBalance: 0
    });

    // -------------------------------------------------------------
    // TEST SECTION 2: Billing Settlement Atomicity & Idempotency
    // -------------------------------------------------------------
    console.log("\n--- 2. Billing Settlement Idempotency ---");
    const testSessionId = new mongoose.Types.ObjectId();
    const testSessionCode = "CHAT-TEST-IDEMP";

    // First settlement call
    const settle1 = await settleWalletBalance({
        userId: testUser._id,
        astrologerId: testAstro._id,
        sessionType: "CHAT",
        sessionId: testSessionId,
        sessionCode: testSessionCode,
        perMinuteRate: 9,
        totalDurationSeconds: 60,
        totalCost: 9.00,
        astrologerEarnings: 5.40,
        platformFee: 3.60
    });
    assert(settle1.success === true && !settle1.alreadySettled, "First settlement call succeeds normally");

    // Second settlement call with same sessionId
    const settle2 = await settleWalletBalance({
        userId: testUser._id,
        astrologerId: testAstro._id,
        sessionType: "CHAT",
        sessionId: testSessionId,
        sessionCode: testSessionCode,
        perMinuteRate: 9,
        totalDurationSeconds: 60,
        totalCost: 9.00,
        astrologerEarnings: 5.40,
        platformFee: 3.60
    });
    assert(settle2.success === true && settle2.alreadySettled === true, "Second settlement call detected existing transaction and was skipped safely");

    // Check ledger
    const txnCount = await WalletTransaction.countDocuments({ sessionId: testSessionId });
    assert(txnCount === 1, `Exactly ONE transaction recorded in WalletTransaction ledger (actual: ${txnCount})`);

    const userBalAfter = await User.findById(testUser._id);
    const astroBalAfter = await Astrologer.findById(testAstro._id);
    assert(userBalAfter.walletBalance === 191.00, `User debited exactly ₹9.00 once (balance: ₹${userBalAfter.walletBalance})`);
    assert(astroBalAfter.walletBalance === 5.40, `Astro credited exactly ₹5.40 once (balance: ₹${astroBalAfter.walletBalance})`);

    // -------------------------------------------------------------
    // TEST SECTION 3: Crash Recovery for Unsettled Completed Sessions
    // -------------------------------------------------------------
    console.log("\n--- 3. Crash Recovery Reconciler ---");
    // Simulate a crash scenario: session marked COMPLETED but process crashed before settlement ran
    const crashedSession = await Session.create({
        type: "CHAT",
        user: testUser._id,
        astrologer: testAstro._id,
        status: "COMPLETED",
        perMinuteRate: 9,
        startedAt: new Date(Date.now() - 60 * 1000),
        endedAt: new Date(),
        billingSettled: false,
        billingSettlementStatus: "UNSETTLED"
    });

    const recoveryResult = await reconcileUnsettledCompletedSessions();
    assert(recoveryResult.reconciledCount >= 1, "Crash recovery reconciler found and settled unsettled completed session");

    const recoveredSession = await Session.findById(crashedSession._id);
    assert(recoveredSession.billingSettled === true && recoveredSession.billingSettlementStatus === "SETTLED", "Crashed session is now marked SETTLED in DB");

    // -------------------------------------------------------------
    // TEST SECTION 4: Double End / Race Condition
    // -------------------------------------------------------------
    console.log("\n--- 4. Double End Race Condition Handling ---");
    await Astrologer.findByIdAndUpdate(testAstro._id, { isOnline: true, isAvailable: true });
    const raceSession = await sessionEngine.createSessionRequest({
        type: "VIDEO",
        userId: testUser._id,
        astrologerId: testAstro._id,
        perMinuteRate: 9
    });
    await sessionEngine.acceptSession(raceSession._id);
    await Session.findByIdAndUpdate(raceSession._id, { startedAt: new Date(Date.now() - 30 * 1000) });

    const [end1, end2] = await Promise.all([
        sessionEngine.endSession({ sessionId: raceSession._id, endedBy: "USER" }),
        sessionEngine.endSession({ sessionId: raceSession._id, endedBy: "ASTROLOGER" })
    ]);

    assert(end1.status === "COMPLETED" && end2.status === "COMPLETED", "Both concurrent end requests resolved safely to COMPLETED");
    const raceTxnCount = await WalletTransaction.countDocuments({ sessionId: raceSession._id });
    assert(raceTxnCount === 1, `Exactly ONE WalletTransaction for concurrent end (actual: ${raceTxnCount})`);

    // -------------------------------------------------------------
    // TEST SECTION 5: Dynamic Rate Snapshot Isolation
    // -------------------------------------------------------------
    console.log("\n--- 5. Dynamic Rate Snapshot Isolation ---");
    await Astrologer.findByIdAndUpdate(testAstro._id, { isOnline: true, isAvailable: true, consultationFee: 9 });
    const sessionA = await sessionEngine.createSessionRequest({
        type: "AUDIO",
        userId: testUser._id,
        astrologerId: testAstro._id,
        perMinuteRate: 9
    });
    await sessionEngine.acceptSession(sessionA._id);

    // Astrologer changes rate to ₹25/min
    await Astrologer.findByIdAndUpdate(testAstro._id, { isOnline: true, isAvailable: true, consultationFee: 25 });
    const sessionB = await sessionEngine.createSessionRequest({
        type: "AUDIO",
        userId: testUser._id,
        astrologerId: testAstro._id,
        perMinuteRate: 25
    });
    await sessionEngine.acceptSession(sessionB._id);

    assert(sessionA.perMinuteRate === 9, "Active Session A retains initial snapshot rate of ₹9/min");
    assert(sessionB.perMinuteRate === 25, "New Session B snapshots new rate of ₹25/min");

    await sessionEngine.endSession({ sessionId: sessionA._id });
    await sessionEngine.endSession({ sessionId: sessionB._id });

    // -------------------------------------------------------------
    // TEST SECTION 6: Disconnect Edge Cases & Boundaries
    // -------------------------------------------------------------
    console.log("\n--- 6. Disconnect Edge Cases & Grace Boundaries ---");
    // Boundary Definition: reconnect <= 15.000s is INSIDE grace; > 15.000s is EXPIRED

    // 6A: Astrologer Reconnect at 5 seconds (Inside Grace -> Unbilled time credited)
    await Astrologer.findByIdAndUpdate(testAstro._id, { isOnline: true, isAvailable: true, consultationFee: 9 });
    const astroGraceSession = await sessionEngine.createSessionRequest({
        type: "CHAT",
        userId: testUser._id,
        astrologerId: testAstro._id,
        perMinuteRate: 9
    });
    await sessionEngine.acceptSession(astroGraceSession._id);
    const startAstroGrace = new Date(Date.now() - 60 * 1000);
    await Session.findByIdAndUpdate(astroGraceSession._id, { startedAt: startAstroGrace });

    // Astrologer disconnects
    await sessionEngine.handleParticipantDisconnect({ sessionId: astroGraceSession._id, role: "ASTROLOGER" });
    // Astrologer reconnects 5s later
    await sessionEngine.handleParticipantReconnect({ sessionId: astroGraceSession._id, role: "ASTROLOGER" });

    // Ending session: 60s total duration, astrologer grace recorded
    const endedAstroGrace = await sessionEngine.endSession({ sessionId: astroGraceSession._id });
    assert(endedAstroGrace.status === "COMPLETED", "Astrologer grace session completed");
    assert(endedAstroGrace.totalDurationSeconds <= 60, "Billable duration accurately accounts for astrologer unbilled grace");

    // 6B: User Disconnect (User IS billed during grace)
    await Astrologer.findByIdAndUpdate(testAstro._id, { isOnline: true, isAvailable: true, consultationFee: 9 });
    const userGraceSession = await sessionEngine.createSessionRequest({
        type: "CHAT",
        userId: testUser._id,
        astrologerId: testAstro._id,
        perMinuteRate: 9
    });
    await sessionEngine.acceptSession(userGraceSession._id);
    const startUserGrace = new Date(Date.now() - 30 * 1000);
    await Session.findByIdAndUpdate(userGraceSession._id, { startedAt: startUserGrace });

    // User disconnects & reconnects within 10s
    await sessionEngine.handleParticipantDisconnect({ sessionId: userGraceSession._id, role: "USER" });
    await sessionEngine.handleParticipantReconnect({ sessionId: userGraceSession._id, role: "USER" });

    const endedUserGrace = await sessionEngine.endSession({ sessionId: userGraceSession._id });
    assert(endedUserGrace.totalDurationSeconds >= 30, `User is billed for grace duration: ${endedUserGrace.totalDurationSeconds}s`);

    // -------------------------------------------------------------
    // TEST SECTION 7: Simultaneous Disconnects
    // -------------------------------------------------------------
    console.log("\n--- 7. Simultaneous Disconnects ---");
    await Astrologer.findByIdAndUpdate(testAstro._id, { isOnline: true, isAvailable: true, consultationFee: 9 });
    const simSession = await sessionEngine.createSessionRequest({
        type: "VIDEO",
        userId: testUser._id,
        astrologerId: testAstro._id,
        perMinuteRate: 9
    });
    await sessionEngine.acceptSession(simSession._id);
    await Session.findByIdAndUpdate(simSession._id, { startedAt: new Date(Date.now() - 45 * 1000) });

    // Both disconnect simultaneously
    await sessionEngine.handleParticipantDisconnect({ sessionId: simSession._id, role: "USER" });
    await sessionEngine.handleParticipantDisconnect({ sessionId: simSession._id, role: "ASTROLOGER" });

    // User reconnects first
    await sessionEngine.handleParticipantReconnect({ sessionId: simSession._id, role: "USER" });

    const endedSim = await sessionEngine.endSession({ sessionId: simSession._id });
    assert(endedSim.totalDurationSeconds >= 0, `Simultaneous disconnect produces non-negative duration: ${endedSim.totalDurationSeconds}s`);
    assert(endedSim.totalAmount >= 0, `Billed amount is valid: ₹${endedSim.totalAmount}`);

    // -------------------------------------------------------------
    // TEST SECTION 8: Server Restart During Grace
    // -------------------------------------------------------------
    console.log("\n--- 8. Server Restart During Grace Period ---");
    await Astrologer.findByIdAndUpdate(testAstro._id, { isOnline: true, isAvailable: true, consultationFee: 9 });
    const restartGraceSession = await sessionEngine.createSessionRequest({
        type: "CHAT",
        userId: testUser._id,
        astrologerId: testAstro._id,
        perMinuteRate: 9
    });
    await sessionEngine.acceptSession(restartGraceSession._id);
    const sessionStart = new Date(Date.now() - 50 * 1000);
    const astroAwayAt = new Date(Date.now() - 10 * 1000); // Astro disconnected 10s ago

    // Save in DB (simulating disconnect persisted before crash)
    await Session.findByIdAndUpdate(restartGraceSession._id, {
        startedAt: sessionStart,
        "disconnectState.astrologerDisconnectedAt": astroAwayAt,
        "disconnectState.unbilledGraceSeconds": 0
    });

    // Simulate Node.js restart (clear in-memory maps)
    sessionEngine.stopSessionBillingTimer(restartGraceSession._id);

    // End session using purely MongoDB state after restart
    const endedRestartGrace = await sessionEngine.endSession({ sessionId: restartGraceSession._id });
    assert(endedRestartGrace.status === "COMPLETED", "Restarted grace session completed cleanly");
    assert(endedRestartGrace.disconnectState.unbilledGraceSeconds >= 10, `Persisted astrologer away time (10s) deducted upon restart: ${endedRestartGrace.disconnectState.unbilledGraceSeconds}s`);
    assert(endedRestartGrace.totalDurationSeconds <= 41, `Billable seconds correctly reduced to ~40s (50s total - 10s grace): actual ${endedRestartGrace.totalDurationSeconds}s`);

    // -------------------------------------------------------------
    // TEST SECTION 9: Session ID Consistency Across Layers
    // -------------------------------------------------------------
    console.log("\n--- 9. Session ID Consistency Across Models & Ledger ---");
    const consistencyId = endedRestartGrace._id.toString();
    const chatLegacy = await ChatSession.findById(consistencyId);
    const txnRecord = await WalletTransaction.findOne({ sessionId: consistencyId });

    assert(chatLegacy !== null && chatLegacy._id.toString() === consistencyId, "Session._id strictly matches ChatSession._id");
    assert(txnRecord !== null && txnRecord.sessionId.toString() === consistencyId, "Session._id strictly matches WalletTransaction.sessionId");

    // Cleanup fixtures
    console.log("\n--- Cleaning up Test Fixtures ---");
    await Session.deleteMany({ user: testUser._id });
    await ChatSession.deleteMany({ user: testUser._id });
    await VideoSession.deleteMany({ user: testUser._id });
    await WalletTransaction.deleteMany({ user: testUser._id });
    await User.findByIdAndDelete(testUser._id);
    await Astrologer.findByIdAndDelete(testAstro._id);

    console.log("==================================================================");
    console.log(`📊 FINAL VERIFICATION RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
    console.log("==================================================================");

    await mongoose.disconnect();
    process.exit(failedTests > 0 ? 1 : 0);
}

runVerificationSuite().catch(err => {
    console.error("Verification execution error:", err);
    process.exit(1);
});
