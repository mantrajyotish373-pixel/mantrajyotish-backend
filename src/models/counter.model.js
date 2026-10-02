const mongoose = require("mongoose");

// Tiny atomic counters (e.g. complaint numbers)
const CounterSchema = new mongoose.Schema({ _id: { type: String, required: true }, seq: { type: Number, default: 0 } });
const Counter = mongoose.model("Counter", CounterSchema);

const nextSeq = async (name) => {
    const doc = await Counter.findOneAndUpdate({ _id: name }, { $inc: { seq: 1 } }, { new: true, upsert: true });
    return doc.seq;
};

module.exports = { Counter, nextSeq };
