const User = require("../models/user.model");
const { generateToken } = require("../utils/jwt");

// 1. GET LOGGED-IN USER PROFILE
const getProfile = async (req, res, next) => {
    try {
        const user = await User.findById(req.user.userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const isCompleted = user.isProfileCompleted === true || Boolean(user.name && user.dateofbirth);
        const userObj = user.toObject();
        userObj.isProfileCompleted = isCompleted;

        return res.status(200).json({
            success: true,
            data: userObj
        });

    } catch (error) {
        next(error);
    }
};

// 2. CREATE / REGISTER USER (With all step-by-step profile fields)
const registerUser = async (req, res, next) => {
    try {
        let {
            name,
            firstname,
            middlename,
            lastname,
            gender,
            dateofbirth,
            timeofbirth,
            placeofbirth,
            city,
            state,
            country,
            address,
            phone,
            email,
            role
        } = req.body;

        if (!phone) {
            return res.status(400).json({
                success: false,
                message: "Phone number is required"
            });
        }

        // Check existing user by phone
        let existingUser = await User.findOne({ phone });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: "User with this phone number already exists"
            });
        }

        if (name && typeof name === "string") {
            const parts = name.trim().split(/\s+/);
            firstname = parts[0] || "";
            lastname = parts.slice(1).join(" ") || "";
        } else if (firstname) {
            name = `${firstname} ${lastname || ""}`.trim();
        }

        const user = await User.create({
            name: name || null,
            firstname: firstname || null,
            middlename: middlename || null,
            lastname: lastname || null,
            gender: gender ? gender.toLowerCase() : null,
            dateofbirth: dateofbirth ? new Date(dateofbirth) : null,
            timeofbirth: timeofbirth || null,
            placeofbirth: placeofbirth || null,
            city: city || null,
            state: state || null,
            country: country || null,
            address: address || null,
            phone,
            email: email && email.trim() ? email.trim().toLowerCase() : undefined,
            role: role || "user",
            isProfileCompleted: Boolean(name || (firstname && lastname)),
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

        const token = generateToken({
            userId: user._id,
            role: user.role
        });

        return res.status(201).json({
            success: true,
            message: "User created successfully",
            data: {
                user,
                token
            }
        });

    } catch (error) {
        next(error);
    }
};

// 3. GET ALL USERS (Admin / Listing)
const getAllUsers = async (req, res, next) => {
    try {
        const users = await User.find().sort({ createdAt: -1 }).lean();

        const ChatSession = require("../models/chatSession.model");
        const VideoSession = require("../models/videoSession.model");

        const updatedUsers = await Promise.all(users.map(async (u) => {
            try {
                const [chatCount, callCount, chatCosts, callCosts] = await Promise.all([
                    ChatSession.countDocuments({ user: u._id, status: "COMPLETED" }),
                    VideoSession.countDocuments({ user: u._id, status: { $in: ["COMPLETED", "ACTIVE", "live"] } }),
                    ChatSession.aggregate([
                        { $match: { user: u._id, status: "COMPLETED" } },
                        { $group: { _id: null, total: { $sum: "$totalAmountDeducted" } } }
                    ]),
                    VideoSession.aggregate([
                        { $match: { user: u._id, status: "COMPLETED" } },
                        { $group: { _id: null, total: { $sum: "$totalAmountDeducted" } } }
                    ])
                ]);

                const chatSpend = chatCosts[0]?.total || 0;
                const callSpend = callCosts[0]?.total || 0;
                const totalSpent = parseFloat((chatSpend + callSpend).toFixed(2));

                return {
                    ...u,
                    totalChats: chatCount,
                    totalCalls: callCount,
                    totalSpent: totalSpent
                };
            } catch (err) {
                console.error("Failed to aggregate stats for user:", u._id, err.message);
                return {
                    ...u,
                    totalChats: 0,
                    totalCalls: 0,
                    totalSpent: 0
                };
            }
        }));

        return res.status(200).json({
            success: true,
            count: updatedUsers.length,
            data: updatedUsers
        });

    } catch (error) {
        next(error);
    }
};

// 4. GET SINGLE USER BY ID
const getUserById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const user = await User.findById(id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        return res.status(200).json({
            success: true,
            data: user
        });

    } catch (error) {
        next(error);
    }
};

// 5. UPDATE USER BY ID / PROFILE
const updateProfile = async (req, res, next) => {
    try {
        const userId = req.params.id || (req.user && req.user.userId);
        
        const existingUser = await User.findById(userId);
        if (!existingUser) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const updates = { ...req.body };
        const unsetFields = {};

        if ('email' in updates) {
            if (updates.email && typeof updates.email === "string" && updates.email.trim()) {
                updates.email = updates.email.trim().toLowerCase();
            } else {
                delete updates.email;
                unsetFields.email = 1;
            }
        }

        if (updates.name && typeof updates.name === "string") {
            const parts = updates.name.trim().split(/\s+/);
            updates.firstname = parts[0] || "";
            updates.lastname = parts.slice(1).join(" ") || "";
        } else if (updates.firstname) {
            updates.name = `${updates.firstname} ${updates.lastname || ""}`.trim();
        }

        if (updates.gender) {
            updates.gender = updates.gender.toLowerCase();
        }

        if (updates.dateofbirth) {
            updates.dateofbirth = new Date(updates.dateofbirth);
        }

        const currentGender = updates.gender || existingUser.gender;
        const currentRole = updates.role || existingUser.role;

        const isDefaultPic = !existingUser.profileImage || 
            (existingUser.profileImage.includes("res.cloudinary.com") && 
             (existingUser.profileImage.includes("user_female_pic") || 
              existingUser.profileImage.includes("user_male_pic") || 
              existingUser.profileImage.includes("user_profile_pic")));

        if (updates.profileImage === null || updates.profileImage === "") {
            const { getDefaultProfilePic } = require("../services/cloudinary.service");
            updates.profileImage = getDefaultProfilePic(userId, currentRole, currentGender);
        } else if (!updates.profileImage && isDefaultPic && updates.gender && updates.gender !== existingUser.gender) {
            const { getDefaultProfilePic } = require("../services/cloudinary.service");
            updates.profileImage = getDefaultProfilePic(userId, currentRole, updates.gender);
        }

        updates.isProfileCompleted = true;

        const updateQuery = { $set: updates };
        if (Object.keys(unsetFields).length > 0) {
            updateQuery.$unset = unsetFields;
        }

        const user = await User.findByIdAndUpdate(
            userId,
            updateQuery,
            { returnDocument: 'after', runValidators: true }
        );

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "User profile updated successfully",
            data: user
        });

    } catch (error) {
        next(error);
    }
};

// 6. DELETE USER BY ID
const deleteUser = async (req, res, next) => {
    try {
        const { id } = req.params;

        const ChatSession = require("../models/chatSession.model");
        const VideoSession = require("../models/videoSession.model");
        const Appointment = require("../models/appointment.model");

        const user = await User.findByIdAndDelete(id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        // Delete all related documents for this user (except Payments, which we keep for financial audits)
        await Promise.all([
            ChatSession.deleteMany({ user: id }),
            VideoSession.deleteMany({ user: id }),
            Appointment.deleteMany({ user: id })
        ]);

        console.log(`🗑️ Permanently deleted User ${id} (${user.name || user.phone}) and all their associated chats, calls, and appointments.`);

        return res.status(200).json({
            success: true,
            message: "User and all associated chat/call session logs deleted successfully"
        });

    } catch (error) {
        next(error);
    }
};

module.exports = {
    getProfile,
    registerUser,
    getAllUsers,
    getUserById,
    updateProfile,
    deleteUser
};