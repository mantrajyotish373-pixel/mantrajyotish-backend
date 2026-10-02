const mongoose = require("mongoose");
const User = require("../../models/user.model");
const Astrologer = require("../../models/astro.model");

/** Resolves a user by _id, phone, uniqueId, email or userLogin (same lookups as the legacy engine). */
const findUserByIdOrRef = async (id) => {
    if (!id) return null;
    let user = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
        user = await User.findById(id).lean();
    }
    if (!user) {
        const orConditions = [
            { phone: id },
            { phone: "+91" + String(id).replace(/\D/g, "") },
            { uniqueId: id },
            { email: id }
        ];
        if (mongoose.Types.ObjectId.isValid(id)) {
            orConditions.push({ userLogin: id });
        }
        user = await User.findOne({ $or: orConditions }).lean();
    }
    return user;
};

/**
 * Resolves an astrologer by _id, linked user / login id, email or name.
 * An unknown id resolves to null. It never falls back to some other astrologer.
 */
const findAstrologerByIdOrRef = async (id) => {
    if (!id) return null;
    let astro = null;
    if (mongoose.Types.ObjectId.isValid(id)) {
        astro = await Astrologer.findById(id).lean();
    }
    if (!astro) {
        const orConditions = [{ email: id }, { name: id }];
        if (mongoose.Types.ObjectId.isValid(id)) {
            orConditions.push({ user: id }, { astrologerLogin: id });
        }
        astro = await Astrologer.findOne({ $or: orConditions }).lean();
    }
    return astro;
};

module.exports = { findUserByIdOrRef, findAstrologerByIdOrRef };
