const AstrologerLogin = require("../models/astrologerLogin.model");
const Astrologer = require("../models/astro.model");
const astroService = require("../services/astro.service");
const cloudinaryService = require("../services/cloudinary.service");

const normalizeAstroData = async (req) => {
    const body = req.body || {};
    let astrologerLoginId = body.astrologerLogin || body.astrologerLoginId || body.astrologerId || req.headers["astrologer-id"] || req.headers["astrologerloginid"] || null;
    let userId = body.user || body.userId || null;
    let email = body.email || req.headers["email"] || null;

    // If request has JWT user from authMiddleware
    if (req.user) {
        if (req.user.role === "astrologer") {
            const astroId = req.params.id || req.user.userId;
            if (astroId) {
                try {
                    const astroDoc = await Astrologer.findById(astroId);
                    if (astroDoc && astroDoc.astrologerLogin) {
                        astrologerLoginId = astroDoc.astrologerLogin.toString();
                    }
                } catch (err) {}
            }
        } else {
            userId = userId || req.user.userId;
        }
    }

    let name = body.name || body.fullName || body.astrologerName || undefined;
    let phone = body.phone || body.mobileNumber || body.mobile || null;
    let password = body.password || null;

    // Auto-fetch name and email from AstrologerLogin record if ID is provided
    if (astrologerLoginId && (!name || !email)) {
        try {
            const loginInfo = await AstrologerLogin.findById(astrologerLoginId);
            if (loginInfo) {
                name = name || loginInfo.name;
                email = email || loginInfo.email;
            }
        } catch (err) {}
    }

    const payload = {};

    if (astrologerLoginId && astrologerLoginId !== req.params?.id && astrologerLoginId !== req.user?.userId) {
        payload.astrologerLogin = astrologerLoginId;
    }
    if (userId) payload.user = userId;
    if (name) payload.name = name;
    if (email) payload.email = email.toLowerCase();
    if (phone) payload.phone = phone;

    if (password && typeof password === "string" && password.trim()) {
        const bcrypt = require("bcrypt");
        payload.password = await bcrypt.hash(password.trim(), 10);
    }

    const rawProfileImage = body.profilePhoto || body.profileImage || body.avatar || body.image || body.photo || body.profilePic;
    if (rawProfileImage) {
        try {
            payload.profileImage = await cloudinaryService.uploadBase64OrUrl(rawProfileImage, "astro_profiles");
        } catch (e) {
            payload.profileImage = rawProfileImage;
        }
    }

    if (body.location !== undefined && body.location !== null) payload.location = body.location;
    if (body.city !== undefined && body.city !== null) payload.city = body.city;
    if (body.state !== undefined && body.state !== null) payload.state = body.state;
    if (body.address !== undefined && body.address !== null) payload.address = body.address;
    if (body.district !== undefined && body.district !== null) payload.district = body.district;
    if (body.age !== undefined && body.age !== null) payload.age = String(body.age);
    if (body.gender !== undefined && body.gender !== null) payload.gender = String(body.gender).toLowerCase();

    const rawCertificate = body.certificateFile;
    if (rawCertificate) {
        try {
            payload.certificateFile = await cloudinaryService.uploadBase64OrUrl(rawCertificate, "astro_certificates");
        } catch (e) {
            payload.certificateFile = rawCertificate;
        }
    }

    const introduction = body.introduction || body.about;
    if (introduction) {
        payload.introduction = introduction;
        payload.about = introduction;
    }

    if (body.experience !== undefined && body.experience !== null) payload.experience = String(body.experience);
    if (body.approach !== undefined && body.approach !== null) payload.approach = body.approach;
    if (body.motivation !== undefined && body.motivation !== null) payload.motivation = body.motivation;
    if (body.toolsTechniques !== undefined && body.toolsTechniques !== null) payload.toolsTechniques = body.toolsTechniques;
    if (body.achievements !== undefined && body.achievements !== null) payload.achievements = body.achievements;
    if (body.certificateName !== undefined && body.certificateName !== null) payload.certificateName = body.certificateName;
    // Extract consultation fee supporting common synonyms
    const feeValue = body.consultationFee !== undefined ? body.consultationFee :
                     body.consultationRate !== undefined ? body.consultationRate :
                     body.consultationCharge !== undefined ? body.consultationCharge :
                     body.perMinuteRate !== undefined ? body.perMinuteRate :
                     body.rate !== undefined ? body.rate :
                     body.fee !== undefined ? body.fee :
                     body.charge !== undefined ? body.charge :
                     body.price !== undefined ? body.price :
                     body.callRate !== undefined ? body.callRate :
                     body.chatRate !== undefined ? body.chatRate :
                     body.videoRate !== undefined ? body.videoRate :
                     undefined;

    if (feeValue !== undefined && feeValue !== null) {
        // Strip out non-numeric characters (e.g. "15/min" -> 15)
        const parsedFee = typeof feeValue === "string" 
            ? Number(feeValue.replace(/[^0-9.]/g, "")) 
            : Number(feeValue);
        
        if (!isNaN(parsedFee)) {
            payload.consultationFee = parsedFee;
        }
    }

    const parsePrice = (val) => {
        if (val === undefined || val === null) return undefined;
        const parsed = typeof val === "string" 
            ? Number(String(val).replace(/[^0-9.]/g, "")) 
            : Number(val);
        return isNaN(parsed) ? undefined : parsed;
    };

    const chatPrice = parsePrice(body.chatPrice !== undefined ? body.chatPrice : body.chatRate);
    if (chatPrice !== undefined) payload.chatPrice = chatPrice;

    const audioCallPrice = parsePrice(body.audioCallPrice !== undefined ? body.audioCallPrice : (body.audioCallRate !== undefined ? body.audioCallRate : (body.audioRate !== undefined ? body.audioRate : body.callRate)));
    if (audioCallPrice !== undefined) payload.audioCallPrice = audioCallPrice;

    const videoCallPrice = parsePrice(body.videoCallPrice !== undefined ? body.videoCallPrice : (body.videoCallRate !== undefined ? body.videoCallRate : body.videoRate));
    if (videoCallPrice !== undefined) payload.videoCallPrice = videoCallPrice;

    if (body.isOnline !== undefined && body.isOnline !== null) {
        payload.isOnline = Boolean(body.isOnline);
        payload.manualOffline = !payload.isOnline;
    }
    if (body.isAvailable !== undefined && body.isAvailable !== null) payload.isAvailable = Boolean(body.isAvailable);

    const strengths = body.selectedStrengths || body.strengths;
    if (strengths && Array.isArray(strengths) && strengths.length > 0) {
        payload.strengths = strengths;
    }

    const specialization = body.selectedSpecializations || body.specialization;
    if (specialization && Array.isArray(specialization) && specialization.length > 0) {
        payload.specialization = specialization;
    }

    const languages = body.languages;
    if (languages && Array.isArray(languages) && languages.length > 0) {
        payload.languages = languages;
    }

    return payload;
};

const createAstrologer = async (req, res, next) => {
    try {
        const payload = await normalizeAstroData(req);

        let astrologer = null;

        const queryConditions = [];
        if (payload.astrologerLogin) queryConditions.push({ astrologerLogin: payload.astrologerLogin });
        if (payload.email) queryConditions.push({ email: payload.email });

        if (queryConditions.length > 0) {
            const existing = await Astrologer.findOne({ $or: queryConditions });
            if (existing) {
                // If payload does not contain password, preserve existing password
                if (!payload.password && existing.password) {
                    payload.password = existing.password;
                }
                astrologer = await astroService.updateAstrologer(existing._id, payload);
            }
        }

        if (!astrologer) {
            astrologer = await astroService.createAstrologer(payload);
        }

        return res.status(201).json({
            success: true,
            message: "Astrologer Profile Saved Successfully (Pending Admin Approval)",
            data: astrologer
        });

    } catch (error) {
        next(error);
    }
};

const getAllAstrologers = async (req, res, next) => {
    try {
        const filter = {};
        if (req.query.status) {
            filter.status = req.query.status;
        }
        if (req.query.online === "true" || req.query.isOnline === "true") {
            filter.isOnline = true;
        }
        if (req.query.available === "true" || req.query.isAvailable === "true") {
            filter.isAvailable = true;
        }

        const page = req.query.page ? parseInt(req.query.page, 10) : null;
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : null;

        const astrologers = await astroService.getAllAstrologers(filter, page, limit);

        return res.status(200).json({
            success: true,
            count: astrologers.length,
            page: page || 1,
            data: astrologers
        });

    } catch (error) {
        next(error);
    }
};

const getPendingAstrologers = async (req, res, next) => {
    try {
        const astrologers = await astroService.getPendingAstrologers();

        return res.status(200).json({
            success: true,
            count: astrologers.length,
            data: astrologers
        });

    } catch (error) {
        next(error);
    }
};

const getOnlineAstrologers = async (req, res, next) => {
    try {
        const astrologers = await astroService.getOnlineAstrologers();

        return res.status(200).json({
            success: true,
            count: astrologers.length,
            data: astrologers
        });

    } catch (error) {
        next(error);
    }
};

const getAstrologerById = async (req, res, next) => {
    try {
        const astrologer = await astroService.getAstrologerById(req.params.id);

        return res.status(200).json({
            success: true,
            data: astrologer
        });

    } catch (error) {
        next(error);
    }
};

const approveAstrologer = async (req, res, next) => {
    try {
        let id = req.params.id || req.body.id || req.body.astrologerId;
        const email = req.body.email;

        if (!id && email) {
            const astro = await Astrologer.findOne({ email: email.toLowerCase() });
            if (astro) id = astro._id;
        }

        if (!id) {
            return res.status(400).json({
                success: false,
                message: "Astrologer ID or Email is required"
            });
        }

        const astrologer = await astroService.approveAstrologer(id);

        if (!astrologer) {
            return res.status(404).json({
                success: false,
                message: "Astrologer not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Astrologer registration request APPROVED successfully",
            data: astrologer
        });

    } catch (error) {
        next(error);
    }
};

const rejectAstrologer = async (req, res, next) => {
    try {
        let id = req.params.id || req.body.id || req.body.astrologerId;
        const email = req.body.email;

        if (!id && email) {
            const astro = await Astrologer.findOne({ email: email.toLowerCase() });
            if (astro) id = astro._id;
        }

        if (!id) {
            return res.status(400).json({
                success: false,
                message: "Astrologer ID or Email is required"
            });
        }

        const astrologer = await astroService.rejectAstrologer(id);

        if (!astrologer) {
            return res.status(404).json({
                success: false,
                message: "Astrologer not found"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Astrologer registration request REJECTED",
            data: astrologer
        });

    } catch (error) {
        next(error);
    }
};

const toggleOnlineStatus = async (req, res, next) => {
    try {
        let astrologerId = req.params.id || req.body.id || req.body.astrologerId;
        const email = req.body.email;

        // If email provided
        if (!astrologerId && email) {
            const astroByEmail = await Astrologer.findOne({ email: email.toLowerCase() });
            if (astroByEmail) astrologerId = astroByEmail._id;
        }

        // If logged in via JWT, try matching _id directly, then astrologerLogin, then email
        if (!astrologerId && req.user) {
            const astroById = await Astrologer.findById(req.user.userId);
            if (astroById) {
                astrologerId = astroById._id;
            } else {
                const astro = await Astrologer.findOne({
                    $or: [
                        { astrologerLogin: req.user.userId },
                        { email: String(req.user.email || "").toLowerCase() }
                    ]
                });
                if (astro) astrologerId = astro._id;
            }
        }

        if (!astrologerId) {
            return res.status(400).json({
                success: false,
                message: "Unable to identify the astrologer. Please provide an astrologer ID or authentication token."
            });
        }

        const currentAstro = await Astrologer.findById(astrologerId);
        if (!currentAstro) {
            return res.status(404).json({
                success: false,
                message: "Astrologer not found"
            });
        }

        if (currentAstro.status !== "approved") {
            return res.status(403).json({
                success: false,
                message: "Only approved astrologers can set their status to online or available. Your status is: " + currentAstro.status
            });
        }

        let isOnline;
        if (typeof req.body.isOnline === "boolean") {
            isOnline = req.body.isOnline;
        } else if (typeof req.body.isOnline === "string") {
            isOnline = req.body.isOnline.toLowerCase() === "true";
        } else if (req.body.status !== undefined) {
            isOnline = String(req.body.status).toLowerCase() === "online";
        } else {
            // Dynamic Toggle: flip current DB status if no value specified
            isOnline = !currentAstro.isOnline;
        }

        let isAvailable;
        if (typeof req.body.isAvailable === "boolean") {
            isAvailable = req.body.isAvailable;
        } else if (typeof req.body.isAvailable === "string") {
            isAvailable = req.body.isAvailable.toLowerCase() === "true";
        } else {
            isAvailable = isOnline;
        }

        if (isOnline) {
            try {
                const { cleanupStaleSessions } = require("../config/socket");
                await cleanupStaleSessions(astrologerId);
            } catch (err) {
                console.error("Failed to run cleanupStaleSessions in toggleOnlineStatus controller:", err);
            }
        }

        const updatedAstrologer = await astroService.toggleOnlineStatus(
            astrologerId,
            isOnline,
            isAvailable
        );

        // Broadcast status change to all socket clients in real time
        try {
            const { getIO } = require("../config/socket");
            const io = getIO();
            if (io) {
                io.emit("astrologer_status_changed", {
                    astrologerId: String(updatedAstrologer._id),
                    isOnline: Boolean(updatedAstrologer.isOnline),
                    isAvailable: Boolean(updatedAstrologer.isAvailable)
                });
            }
        } catch (socketErr) {
            console.error("Failed to emit status change event on toggleOnlineStatus REST API:", socketErr);
        }

        return res.status(200).json({
            success: true,
            message: `Astrologer status updated to ${isOnline ? "ONLINE" : "OFFLINE"}`,
            data: updatedAstrologer
        });

    } catch (error) {
        next(error);
    }
};

const updateAstrologer = async (req, res, next) => {
    try {
        const payload = await normalizeAstroData(req);
        const astrologer = await astroService.updateAstrologer(
            req.params.id,
            payload
        );

        return res.status(200).json({
            success: true,
            message: "Astrologer Updated Successfully",
            data: astrologer
        });

    } catch (error) {
        next(error);
    }
};

const deleteAstrologer = async (req, res, next) => {
    try {
        await astroService.deleteAstrologer(req.params.id);

        return res.status(200).json({
            success: true,
            message: "Astrologer Deleted Successfully"
        });

    } catch (error) {
        next(error);
    }
};

const getAstrologerReviews = async (req, res, next) => {
    try {
        const astrologerId = req.params.id || req.user?._id;
        if (!astrologerId) {
            return res.status(400).json({ success: false, message: "Astrologer ID is required." });
        }

        const ChatSession = require("../models/chatSession.model");
        const VideoSession = require("../models/videoSession.model");

        // Fetch rated chat sessions
        const chatReviews = await ChatSession.find({
            astrologer: astrologerId,
            rating: { $ne: null }
        })
        .populate("user", "name firstname lastname profileImage avatar")
        .lean();

        // Fetch rated call sessions
        const callReviews = await VideoSession.find({
            astrologer: astrologerId,
            rating: { $ne: null }
        })
        .populate("user", "name firstname lastname profileImage avatar")
        .lean();

        // Merge and format reviews
        const formattedReviews = [
            ...chatReviews.map(r => ({
                id: r._id,
                name: r.user?.name || `${r.user?.firstname || ""} ${r.user?.lastname || ""}`.trim() || "User Client",
                rating: r.rating,
                comment: r.review || "No comment left.",
                type: "Chat",
                createdAt: r.endTime || r.createdAt
            })),
            ...callReviews.map(r => ({
                id: r._id,
                name: r.user?.name || `${r.user?.firstname || ""} ${r.user?.lastname || ""}`.trim() || "User Client",
                rating: r.rating,
                comment: r.review || "No comment left.",
                type: r.callType || "Call",
                createdAt: r.endTime || r.createdAt
            }))
        ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        return res.status(200).json({
            success: true,
            data: formattedReviews
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    createAstrologer,
    getAllAstrologers,
    getPendingAstrologers,
    getOnlineAstrologers,
    getAstrologerById,
    approveAstrologer,
    rejectAstrologer,
    toggleOnlineStatus,
    updateAstrologer,
    deleteAstrologer,
    getAstrologerReviews
};