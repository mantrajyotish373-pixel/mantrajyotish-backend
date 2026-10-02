const Setting = require("../models/setting.model");

const DEFAULTS = { maintenanceMode: false, maintenanceMessage: "We are upgrading the app. Please try again shortly.", supportEmail: "", supportPhone: "", minWithdrawal: 100 };
let cache = null;
let cachedAt = 0;
const TTL_MS = 15 * 1000;

// Short in-memory cache so the maintenance check on every request costs no DB query.
const getSettings = async () => {
    if (cache && Date.now() - cachedAt < TTL_MS) return cache;
    try {
        const doc = await Setting.findOne({ key: "platform" }).lean();
        cache = { ...DEFAULTS, ...(doc || {}) };
    } catch (e) {
        cache = cache || { ...DEFAULTS };
    }
    cachedAt = Date.now();
    return cache;
};

const updateSettings = async (patch, adminId) => {
    const doc = await Setting.findOneAndUpdate(
        { key: "platform" },
        { $set: { ...patch, updatedBy: adminId }, $setOnInsert: { key: "platform" } },
        { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    ).lean();
    cache = null;
    return { ...DEFAULTS, ...doc };
};

module.exports = { getSettings, updateSettings, DEFAULTS };
