/**
 * One-time admin cleanup:
 *   node scripts/setup-superadmin.js <email> [--dry-run]
 * - backs up every admin document to ~/admin-backups (outside the repo, mode 600)
 * - makes <email> the superadmin (creates it if missing; password from NEW_ADMIN_PASSWORD or generated)
 * - merges the platform wallet (balances + settled-session markers) of all other admins into it
 * - deletes all other admins
 */
require("dotenv").config({ quiet: true });
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const Admin = require("../src/models/admin.model");

(async () => {
    const email = String(process.argv[2] || "").toLowerCase().trim();
    const dryRun = process.argv.includes("--dry-run");
    if (!email || !email.includes("@")) throw new Error("Usage: node scripts/setup-superadmin.js <email> [--dry-run]");

    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    const all = await Admin.find().select("+settledSessions +refreshSessions").lean();

    console.log(`Found ${all.length} admin account(s):`);
    all.forEach((a) => console.log(` - ${a.email} | role=${a.role} | wallet=${a.walletBalance || 0} | settledMarkers=${(a.settledSessions || []).length}`));

    const target = all.find((a) => a.email === email);
    const others = all.filter((a) => a.email !== email);
    const mergedBalance = others.reduce((s, a) => s + (a.walletBalance || 0), 0);
    const markers = [...new Set(others.flatMap((a) => (a.settledSessions || []).map(String)))];

    console.log(`\nTarget ${email}: ${target ? "exists" : "will be CREATED"}`);
    console.log(`Will delete ${others.length} other admin(s); merge wallet ₹${mergedBalance} and ${markers.length} settled markers into target.`);
    if (dryRun) { console.log("\nDRY RUN - nothing changed."); process.exit(0); }

    const dir = path.join(os.homedir(), "admin-backups");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `admins-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    fs.writeFileSync(file, JSON.stringify(all, null, 2), { mode: 0o600 });
    console.log(`Backup written: ${file}`);

    let generatedPassword = null;
    let id;
    if (target) {
        id = target._id;
        await Admin.updateOne({ _id: id }, { role: "superadmin", status: "active", permissions: [], roleId: null, roleName: "" });
    } else {
        const password = process.env.NEW_ADMIN_PASSWORD || (generatedPassword = crypto.randomBytes(12).toString("base64url"));
        const created = await Admin.create({
            name: "Super Admin", email, password: await bcrypt.hash(password, 10), role: "superadmin", status: "active"
        });
        id = created._id;
    }

    const update = { $inc: { walletBalance: mergedBalance } };
    if (markers.length) update.$addToSet = { settledSessions: { $each: markers.map((m) => new mongoose.Types.ObjectId(m)) } };
    await Admin.updateOne({ _id: id }, update);

    const del = await Admin.deleteMany({ _id: { $ne: id } });
    console.log(`Deleted ${del.deletedCount} other admin(s).`);
    if (generatedPassword) console.log(`\nNEW SUPERADMIN PASSWORD (shown once): ${generatedPassword}`);
    const final = await Admin.find().select("email role walletBalance status").lean();
    console.log("Final admins:", JSON.stringify(final));
    process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
