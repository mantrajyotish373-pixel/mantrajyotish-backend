/**
 * One-time: treat ALL money currently in user wallets as bonus (these are internal/test accounts, not real customers).
 *   node scripts/migrate-bonus-balances.js [--dry-run]
 * - sets bonusBalance = walletBalance for every user
 * - writes one BonusGrant (source "migration", no expiry) per user with a balance, so history and expiry stay consistent
 * Safe to re-run: users that already have a migration grant are skipped.
 */
require("dotenv").config({ quiet: true });
const mongoose = require("mongoose");
const User = require("../src/models/user.model");
const BonusGrant = require("../src/models/bonusGrant.model");

(async () => {
    const dryRun = process.argv.includes("--dry-run");
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);

    const users = await User.find({ walletBalance: { $gt: 0 } }).select("name phone walletBalance bonusBalance").lean();
    const done = new Set((await BonusGrant.find({ source: "migration" }).select("user").lean()).map((g) => String(g.user)));
    const todo = users.filter((u) => !done.has(String(u._id)));
    const total = todo.reduce((s, u) => s + u.walletBalance, 0);

    console.log(`Users with a balance: ${users.length} | to convert: ${todo.length} | already converted: ${users.length - todo.length}`);
    console.log(`Total money converted to bonus: ₹${total.toFixed(2)}`);
    todo.slice(0, 15).forEach((u) => console.log(` - ${u.name || "(no name)"} ${u.phone || ""}: ₹${u.walletBalance}`));
    if (todo.length > 15) console.log(` ... and ${todo.length - 15} more`);
    if (dryRun) { console.log("\nDRY RUN - nothing changed."); process.exit(0); }

    for (const u of todo) {
        await BonusGrant.create({ user: u._id, source: "migration", amount: u.walletBalance, remaining: u.walletBalance, reason: "Existing balance converted to bonus" });
        await User.updateOne({ _id: u._id }, [{ $set: { bonusBalance: { $ifNull: ["$walletBalance", 0] } } }], { updatePipeline: true });
    }
    const bad = await User.countDocuments({ $expr: { $gt: ["$bonusBalance", "$walletBalance"] } });
    console.log(`\nConverted ${todo.length} user(s). Users where bonus > wallet (must be 0): ${bad}`);
    process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
