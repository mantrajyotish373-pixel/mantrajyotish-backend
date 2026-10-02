const User = require("../models/user.model");
const UserLogin = require("../models/userLogin.model");
const Otp = require("../models/otp.model");
const fast2smsService = require("./fast2sms.service");
const { generateToken, generateRefreshToken, verifyRefreshToken } = require("../utils/jwt");

const crypto = require("crypto");

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_SENDS_PER_WINDOW = 5;   // codes sent to one number within one OTP lifetime
const MAX_VERIFY_ATTEMPTS = 5;    // wrong guesses before the code is burned

const httpError = (status, message) => {
    const err = new Error(message);
    err.status = status;
    return err;
};

// The code is stored as an HMAC bound to the phone, so a database read does not reveal usable codes.
const hashOtp = (phone, otp) =>
    crypto.createHmac("sha256", process.env.JWT_SECRET || "").update(`${phone}:${otp}`).digest("hex");

const safeEqualHex = (a, b) => {
    const x = Buffer.from(String(a), "hex");
    const y = Buffer.from(String(b), "hex");
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Send OTP via Fast2SMS
 * @param {string} phone - User phone number
 */
const sendOtp = async (phone) => {
    if (!phone) {
        throw httpError(400, "Phone number is required");
    }

    const cleanPhone = fast2smsService.formatPhoneNumber(phone);
    if (!cleanPhone || cleanPhone.length !== 10) {
        throw httpError(400, "Invalid phone number. Please enter a valid 10-digit mobile number.");
    }

    // Per-number limits, so one number cannot be flooded with messages (each one costs money)
    const existing = await Otp.findOne({ phone: cleanPhone }).select("sendCount lastSentAt expiresAt").lean();
    if (existing && existing.expiresAt > new Date()) {
        const sinceLast = Date.now() - new Date(existing.lastSentAt || 0).getTime();
        if (sinceLast < RESEND_COOLDOWN_MS) {
            throw httpError(429, `Please wait ${Math.ceil((RESEND_COOLDOWN_MS - sinceLast) / 1000)} seconds before requesting another OTP.`);
        }
        if ((existing.sendCount || 1) >= MAX_SENDS_PER_WINDOW) {
            throw httpError(429, "Too many OTP requests for this number. Please try again in a few minutes.");
        }
    }

    const customOtp = crypto.randomInt(100000, 1000000);
    const fresh = !existing || existing.expiresAt <= new Date();

    // New code: reset the wrong-guess counter. Resends inside one window keep counting toward the send cap.
    const set = { otp: hashOtp(cleanPhone, customOtp), attempts: 0, lastSentAt: new Date(), expiresAt: new Date(Date.now() + OTP_TTL_MS) };
    const update = fresh ? { $set: { ...set, sendCount: 1 } } : { $set: set, $inc: { sendCount: 1 } };
    await Otp.findOneAndUpdate({ phone: cleanPhone }, update, { upsert: true, new: true });

    // Trigger Fast2SMS WhatsApp service
    const result = await fast2smsService.sendOtp(cleanPhone, customOtp);
    if (!result || !result.success) {
        throw new Error(result?.message || "Failed to deliver WhatsApp OTP");
    }

    return {
        success: true,
        message: "WhatsApp OTP sent successfully"
    };
};

/**
 * Verify OTP and login/register user
 * @param {string} phone - User phone number
 * @param {string|number} otp - Entered OTP
 */
const verifyOtp = async (phone, otp) => {
    if (!phone || !otp) {
        throw httpError(400, "Phone number and OTP code are required");
    }

    const cleanPhone = fast2smsService.formatPhoneNumber(phone);
    const cleanOtp = String(otp).trim();

    if (!cleanPhone || cleanPhone.length !== 10) {
        throw httpError(400, "Invalid phone number format");
    }
    if (!/^\d{6}$/.test(cleanOtp)) {
        throw httpError(400, "Invalid OTP. Please check the code sent to your WhatsApp and try again.");
    }

    // Count this guess first, atomically, so parallel requests cannot out-run the attempt limit
    const otpRecord = await Otp.findOneAndUpdate(
        { phone: cleanPhone },
        { $inc: { attempts: 1 } },
        { new: true }
    );

    if (!otpRecord) {
        throw httpError(400, "Invalid OTP. Please check the code sent to your WhatsApp and try again.");
    }

    // Check expiry
    if (otpRecord.expiresAt < new Date()) {
        await Otp.deleteOne({ _id: otpRecord._id });
        throw httpError(400, "OTP has expired. Please request a new OTP.");
    }

    if (otpRecord.attempts > MAX_VERIFY_ATTEMPTS) {
        await Otp.deleteOne({ _id: otpRecord._id });
        throw httpError(429, "Too many wrong attempts. Please request a new OTP.");
    }

    if (!safeEqualHex(otpRecord.otp, hashOtp(cleanPhone, cleanOtp))) {
        throw httpError(400, "Invalid OTP. Please check the code sent to your WhatsApp and try again.");
    }

    // Single use: only the request that actually deletes the record may continue
    const consumed = await Otp.findOneAndDelete({ _id: otpRecord._id });
    if (!consumed) {
        throw httpError(400, "This OTP was already used. Please request a new OTP.");
    }

    // Check if user exists, otherwise create
    let user = await User.findOne({
        $or: [{ phone: cleanPhone }, { phone: `+91${cleanPhone}` }]
    });

    if (!user) {
        user = await User.create({
            phone: cleanPhone,
            role: "user",
            isProfileCompleted: false,
            walletBalance: 0
        });

        // Signup bonus is an editable promotion (Admin > Offers & Bonus); it credits wallet + bonus balance and logs history.
        try {
            const { grantSignupBonus } = require("./bonus.service");
            await grantSignupBonus(user._id);
            const fresh = await User.findById(user._id);
            if (fresh) user.walletBalance = fresh.walletBalance;
        } catch (bonusErr) {
            console.error("Failed to grant signup bonus:", bonusErr.message);
        }
    }

    // Record login entry in UserLogin model
    try {
        const userLoginRecord = await UserLogin.create({
            user: user._id,
            phone: user.phone,
            email: user.email || null,
            loginMethod: "otp",
            lastLoginAt: new Date()
        });

        user.userLogin = userLoginRecord._id;
        await user.save();
    } catch (e) {
        console.warn("UserLogin audit log warning:", e.message);
    }

    // Generate JWT token
    const token = generateToken({
        userId: user._id,
        role: user.role
    });
    const refreshToken = generateRefreshToken({
        userId: user._id,
        role: user.role
    });

    return {
        user,
        token,
        refreshToken
    };
};

/**
 * Refresh access token using refresh token
 * @param {string} tokenStr - Refresh token
 */
const refresh = async (tokenStr) => {
    try {
        const decoded = verifyRefreshToken(tokenStr);
        if (!decoded || !decoded.userId) {
            throw new Error("Invalid token payload");
        }

        const user = await User.findById(decoded.userId);
        if (!user) {
            throw new Error("User not found");
        }

        const token = generateToken({
            userId: user._id,
            role: user.role
        });
        const refreshToken = generateRefreshToken({
            userId: user._id,
            role: user.role
        });

        return {
            token,
            refreshToken
        };
    } catch (error) {
        throw new Error(error.message || "Failed to refresh token");
    }
};

module.exports = {
    sendOtp,
    verifyOtp,
    refresh
};