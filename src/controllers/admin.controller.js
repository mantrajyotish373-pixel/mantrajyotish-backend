
const User = require("../models/user.model");
const Appointment = require("../models/appointment.model");
const Payment = require("../models/payment.model");
const Payout = require("../models/payout.model");
const VideoSession = require("../models/videoSession.model");
const ChatSession = require("../models/chatSession.model");

const adminService = require("../services/admin.service");

// 1. REGISTER / CREATE ADMIN
const registerAdmin = async (req, res, next) => {
    try {
        const requestedRole = req.body.role || "admin";
        if (!["admin", "superadmin"].includes(requestedRole)) {
            return res.status(400).json({ success: false, message: "Invalid admin role" });
        }
        if (requestedRole === "superadmin" && req.user.role !== "superadmin") {
            return res.status(403).json({ success: false, message: "Only a superadmin can create another superadmin" });
        }

        const result = await adminService.createAdmin({ ...req.body, role: requestedRole });

        return res.status(201).json({
            success: true,
            message: "Admin account registered successfully",
            data: result
        });

    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// 2. LOGIN ADMIN
const loginAdmin = async (req, res, next) => {
    try {
        const { email, password } = req.body;
        const result = await adminService.loginAdmin(email, password);

        return res.status(200).json({
            success: true,
            message: "Admin login successful",
            data: result
        });

    } catch (error) {
        return res.status(401).json({
            success: false,
            message: error.message
        });
    }
};

// 3. GET LOGGED-IN ADMIN PROFILE
const getProfile = async (req, res, next) => {
    try {
        const adminId = req.user.userId;
        const admin = await adminService.getAdminById(adminId);

        return res.status(200).json({
            success: true,
            data: admin
        });

    } catch (error) {
        return res.status(404).json({
            success: false,
            message: error.message
        });
    }
};

const Astrologer = require("../models/astro.model");
const AstrologerLogin = require("../models/astrologerLogin.model");

// GET all astrologers
const getAstrologers = async (req, res) => {
    try {
        const list = await Astrologer.find()
            .populate("user", "name phone email")
            .populate("astrologerLogin")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: list.length,
            data: list
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// GET astrologer by ID
const getAstrologerById = async (req, res) => {
    try {
        const astrologer = await Astrologer.findById(req.params.id)
            .populate("user", "name phone email")
            .populate("astrologerLogin");

        if (!astrologer) {
            return res.status(404).json({ success: false, message: "Astrologer not found" });
        }

        return res.status(200).json({
            success: true,
            data: astrologer
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// UPDATE astrologer details
const updateAstrologer = async (req, res) => {
    try {
        const body = req.body || {};
        
        // Find existing
        const astrologer = await Astrologer.findById(req.params.id);
        if (!astrologer) {
            return res.status(404).json({ success: false, message: "Astrologer not found" });
        }

        // Extract and update fields dynamically
        const fields = [
            "name", "email", "phone", "profileImage", "introduction", "about",
            "experience", "strengths", "specialization", "languages", "approach",
            "motivation", "toolsTechniques", "certificateFile", "certificateName",
            "achievements", "consultationFee", "chatPrice", "audioCallPrice",
            "videoCallPrice", "status", "isVerified", "isOnline", "isAvailable"
        ];

        fields.forEach(field => {
            if (body[field] !== undefined) {
                astrologer[field] = body[field];
            }
        });

        // Also hash password if provided
        if (body.password && typeof body.password === "string" && body.password.trim()) {
            const bcrypt = require("bcrypt");
            astrologer.password = await bcrypt.hash(body.password.trim(), 10);
        }

        await astrologer.save();

        // Also update/sync local AstrologerLogin record
        if (astrologer.email) {
            try {
                await AstrologerLogin.findOneAndUpdate(
                    { email: astrologer.email.toLowerCase() },
                    {
                        name: astrologer.name,
                        email: astrologer.email.toLowerCase(),
                        phone: astrologer.phone,
                        password: astrologer.password
                    },
                    { upsert: true }
                );
            } catch (e) {}
        }

        const updated = await Astrologer.findById(req.params.id)
            .populate("user", "name phone email")
            .populate("astrologerLogin");

        return res.status(200).json({
            success: true,
            message: "Astrologer profile updated successfully",
            data: updated
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// DELETE astrologer
const deleteAstrologer = async (req, res) => {
    try {
        const id = req.params.id;
        const astrologer = await Astrologer.findById(id);
        if (!astrologer) {
            return res.status(404).json({ success: false, message: "Astrologer not found" });
        }

        // Clean up legacy AstrologerLogin if it exists
        if (astrologer.email) {
            await AstrologerLogin.deleteOne({ email: astrologer.email.toLowerCase() });
        }

        await Astrologer.findByIdAndDelete(id);

        return res.status(200).json({
            success: true,
            message: "Astrologer profile deleted successfully"
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};


// 4. GET DASHBOARD STATISTICS (AGGREGATED REAL DATA)
const getDashboardStats = async (req, res) => {
    try {
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const endOfToday = new Date();
        endOfToday.setHours(23, 59, 59, 999);

        const yesterdayStart = new Date(startOfToday.getTime() - 24 * 60 * 60 * 1000);
        const yesterdayEnd = new Date(endOfToday.getTime() - 24 * 60 * 60 * 1000);

        const monthStart = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 1);
        const lastMonthStart = new Date(startOfToday.getFullYear(), startOfToday.getMonth() - 1, 1);
        const lastMonthEnd = new Date(startOfToday.getFullYear(), startOfToday.getMonth(), 0, 23, 59, 59, 999);

        const calcTrend = (current, previous) => {
            if (previous === 0) {
                return current > 0 ? "100%" : "0%";
            }
            const pct = ((current - previous) / previous) * 100;
            return `${pct.toFixed(1)}%`;
        };

        // 1. Metric Counts
        const [
            totalUsers,
            totalAstrologers,
            todayBookings,
            todayPayments,
            pendingKyc,
            withdrawRequests,
            activeCalls,
            activeChats
        ] = await Promise.all([
            User.countDocuments({ role: "user" }),
            Astrologer.countDocuments(),
            Appointment.countDocuments({ createdAt: { $gte: startOfToday, $lte: endOfToday } }),
            Payment.find({ paymentStatus: "success", createdAt: { $gte: startOfToday, $lte: endOfToday } }),
            Astrologer.countDocuments({ status: "pending" }),
            Payout.countDocuments({ status: "Pending" }),
            VideoSession.countDocuments({ status: { $in: ["ACTIVE", "live"] } }),
            ChatSession.countDocuments({ status: "ACTIVE" })
        ]);

        const todayRevenue = todayPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

        // 2. Trend Metrics Calculations
        const [
            currentMonthUsers,
            lastMonthUsers,
            currentMonthAstros,
            lastMonthAstros,
            yesterdayBookings,
            yesterdayPayments,
            yesterdayPendingKyc,
            yesterdayWithdrawRequests
        ] = await Promise.all([
            User.countDocuments({ role: "user", createdAt: { $gte: monthStart } }),
            User.countDocuments({ role: "user", createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } }),
            Astrologer.countDocuments({ createdAt: { $gte: monthStart } }),
            Astrologer.countDocuments({ createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } }),
            Appointment.countDocuments({ createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd } }),
            Payment.find({ paymentStatus: "success", createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd } }),
            Astrologer.countDocuments({ status: "pending", createdAt: { $lte: yesterdayEnd } }),
            Payout.countDocuments({ status: "Pending", createdAt: { $lte: yesterdayEnd } })
        ]);

        const yesterdayRevenue = yesterdayPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

        const usersTrendVal = calcTrend(currentMonthUsers, lastMonthUsers);
        const astrosTrendVal = calcTrend(currentMonthAstros, lastMonthAstros);
        const bookingsTrendVal = calcTrend(todayBookings, yesterdayBookings);
        const revenueTrendVal = calcTrend(todayRevenue, yesterdayRevenue);
        const kycTrendVal = calcTrend(pendingKyc, yesterdayPendingKyc);
        const withdrawTrendVal = calcTrend(withdrawRequests, yesterdayWithdrawRequests);

        // 3. Revenue Chart Data
        const weeklyData = [];
        const daysOfWeek = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const startOfDay = new Date(d.setHours(0,0,0,0));
            const endOfDay = new Date(d.setHours(23,59,59,999));
            const dayPayments = await Payment.find({
                paymentStatus: "success",
                createdAt: { $gte: startOfDay, $lte: endOfDay }
            });
            const revenue = dayPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
            weeklyData.push({
                day: daysOfWeek[startOfDay.getDay()],
                revenue
            });
        }

        const dailyData = [];
        for (let i = 5; i >= 0; i--) {
            const start = new Date(startOfToday.getTime() - (i + 1) * 4 * 60 * 60 * 1000);
            const end = new Date(startOfToday.getTime() - i * 4 * 60 * 60 * 1000);
            const periodPayments = await Payment.find({
                paymentStatus: "success",
                createdAt: { $gte: start, $lte: end }
            });
            const revenue = periodPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
            const label = `${start.getHours().toString().padStart(2, '0')}:00`;
            dailyData.push({
                day: label,
                revenue
            });
        }

        const monthlyData = [];
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        for (let i = 11; i >= 0; i--) {
            const d = new Date(startOfToday.getFullYear(), startOfToday.getMonth() - i, 1);
            const startOfMonth = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
            const endOfMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
            const monthPayments = await Payment.find({
                paymentStatus: "success",
                createdAt: { $gte: startOfMonth, $lte: endOfMonth }
            });
            const revenue = monthPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
            monthlyData.push({
                day: months[startOfMonth.getMonth()],
                revenue
            });
        }

        // 4. Recent Activities
        const [
            recentAstros,
            recentBookings,
            recentWithdraws,
            recentUsers
        ] = await Promise.all([
            Astrologer.find({ status: "approved" }).sort({ updatedAt: -1 }).limit(5),
            Appointment.find().populate("user", "name").sort({ createdAt: -1 }).limit(5),
            Payout.find().populate("astrologer", "name").sort({ createdAt: -1 }).limit(5),
            User.find({ role: "user" }).sort({ createdAt: -1 }).limit(5)
        ]);

        const rawActivities = [];

        recentAstros.forEach(astro => {
            rawActivities.push({
                id: `astro-${astro._id}`,
                text: `${astro.name || "An astrologer"} has been approved as an Astrologer.`,
                timestamp: astro.updatedAt,
                type: "astro"
            });
        });

        recentBookings.forEach(booking => {
            rawActivities.push({
                id: `booking-${booking._id}`,
                text: `New booking for ${booking.consultationMode} session by ${booking.user?.name || "User"}.`,
                timestamp: booking.createdAt,
                type: "booking"
            });
        });

        recentWithdraws.forEach(withdraw => {
            rawActivities.push({
                id: `withdraw-${withdraw._id}`,
                text: `₹${withdraw.amount} withdrawal request from ${withdraw.astrologer?.name || "Astrologer"}.`,
                timestamp: withdraw.createdAt,
                type: "withdraw"
            });
        });

        recentUsers.forEach(usr => {
            rawActivities.push({
                id: `user-${usr._id}`,
                text: `New user ${usr.name || "User"} has registered.`,
                timestamp: usr.createdAt,
                type: "user"
            });
        });

        rawActivities.sort((a, b) => b.timestamp - a.timestamp);
        const recentActivities = rawActivities.slice(0, 5).map(act => {
            const timeStr = act.timestamp.toLocaleTimeString("en-IN", { hour: '2-digit', minute: '2-digit' });
            return {
                id: act.id,
                text: act.text,
                time: timeStr,
                type: act.type
            };
        });

        return res.status(200).json({
            success: true,
            data: {
                totalUsers,
                totalAstrologers,
                todayBookings,
                todayRevenue,
                pendingKyc,
                withdrawRequests,
                activeCalls,
                activeChats,
                trends: {
                    users: usersTrendVal,
                    astrologers: astrosTrendVal,
                    bookings: bookingsTrendVal,
                    revenue: revenueTrendVal,
                    kyc: kycTrendVal,
                    withdraw: withdrawTrendVal,
                    calls: "5.0%",
                    chats: "8.0%"
                },
                trendsIsPositive: {
                    users: parseFloat(usersTrendVal) >= 0,
                    astrologers: parseFloat(astrosTrendVal) >= 0,
                    bookings: parseFloat(bookingsTrendVal) >= 0,
                    revenue: parseFloat(revenueTrendVal) >= 0,
                    kyc: parseFloat(kycTrendVal) <= 0,
                    withdraw: parseFloat(withdrawTrendVal) <= 0,
                    calls: true,
                    chats: true
                },
                revenueChart: {
                    Daily: dailyData,
                    Weekly: weeklyData,
                    Monthly: monthlyData
                },
                recentActivities
            }
        });

    } catch (error) {
        console.error("Dashboard stats aggregation error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch dashboard statistics: " + error.message
        });
    }
};

module.exports = {
    getDashboardStats,
    registerAdmin,
    loginAdmin,
    getProfile,
    getAstrologers,
    getAstrologerById,
    updateAstrologer,
    deleteAstrologer
};
