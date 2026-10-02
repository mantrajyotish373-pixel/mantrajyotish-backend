const AddMoneyConfig = require("../models/addMoneyConfig.model");

const DEFAULT_PRESETS = [10, 50, 100, 200, 500, 1000, 1500, 2000, 3000, 5000, 10000, 15000, 20000].map((amount) => ({ amount, extraAmount: 0, label: "" }));

const getConfig = async () => {
    let doc = await AddMoneyConfig.findOne({ key: "default" }).lean();
    if (!doc) {
        try {
            await AddMoneyConfig.create({ key: "default", presets: DEFAULT_PRESETS });
        } catch (e) { /* created by a concurrent request */ }
        doc = await AddMoneyConfig.findOne({ key: "default" }).lean();
    }
    if (doc.gstPercent === undefined || doc.gstPercent === null) doc.gstPercent = 18; // documents saved before GST existed
    return doc;
};

/** Extra bonus for adding exactly `amount` (0 when it is not one of the configured quick amounts). */
const extraFor = (config, amount) => {
    const p = (config.presets || []).find((x) => Number(x.amount) === Number(amount));
    return p ? Number(p.extraAmount) || 0 : 0;
};

module.exports = { getConfig, extraFor, DEFAULT_PRESETS };
