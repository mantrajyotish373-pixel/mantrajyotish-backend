const User = require("../models/user.model");
const UserLogin = require("../models/userLogin.model");
const Otp = require("../models/otp.model");
const fast2smsService = require("./fast2sms.service");
const { generateToken, generateRefreshToken, verifyRefreshToken } = require("../utils/jwt");

/**
 * Send OTP via Fast2SMS
 * @param {string} phone - User phone number
 */
const sendOtp = async (phone) => {
    if (!phone) {
        throw new Error("Phone number is required");
    }

    const cleanPhone = fast2smsService.formatPhoneNumber(phone);
    if (!cleanPhone || cleanPhone.length !== 10) {
        throw new Error("Invalid phone number. Please enter a valid 10-digit mobile number.");
    }

    const min = 100000;
    const max = 999999;
    const customOtp = Math.floor(Math.random() * (max - min + 1)) + min;

    // Save/update OTP record in database (storing clean 10-digit number & string OTP)
    await Otp.findOneAndUpdate(
        { phone: cleanPhone },
        { phone: cleanPhone, otp: String(customOtp), expiresAt: new Date(Date.now() + 10 * 60 * 1000) }, // 10 minutes expiry
        { upsert: true, new: true }
    );

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
        throw new Error("Phone number and OTP code are required");
    }

    const cleanPhone = fast2smsService.formatPhoneNumber(phone);
    const cleanOtp = String(otp).trim();

    if (!cleanPhone) {
        throw new Error("Invalid phone number format");
    }

    // Find OTP record by clean 10 digit number or exact string phone
    const otpRecord = await Otp.findOne({
        $or: [{ phone: cleanPhone }, { phone: phone }],
        otp: cleanOtp
    });

    if (!otpRecord) {
        throw new Error("Invalid OTP. Please check the code sent to your WhatsApp and try again.");
    }

    // Check expiry
    if (otpRecord.expiresAt < new Date()) {
        await Otp.deleteOne({ _id: otpRecord._id });
        throw new Error("OTP has expired. Please request a new OTP.");
    }

    // Delete OTP record after successful verification
    await Otp.deleteOne({ _id: otpRecord._id });

    // Check if user exists, otherwise create
    let user = await User.findOne({
        $or: [{ phone: cleanPhone }, { phone: phone }]
    });

    if (!user) {
        user = await User.create({
            phone: cleanPhone,
            role: "user",
            isProfileCompleted: false,
            walletBalance: 100
        });

        // Log signup reward to Payment history
        try {
            const Payment = require("../models/payment.model");
            const txnId = `SIGNUP_${Date.now()}`;
            await Payment.create({
                user: user._id,
                amount: 100,
                currency: "INR",
                paymentGateway: "Admin",
                transactionId: txnId,
                orderId: txnId,
                paymentStatus: "success",
                paidAt: new Date()
            });
        } catch (paymentErr) {
            console.error("Failed to log signup reward to Payment collection:", paymentErr.message);
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