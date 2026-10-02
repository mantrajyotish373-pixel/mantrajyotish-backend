const Astrologer = require("../models/astro.model");
const AstroInterview = require("../models/astroInterview.model");
const User = require("../models/user.model");
const AstrologerLogin = require("../models/astrologerLogin.model");
const { getCache, setCache, deleteCache } = require("./redis.service");

const CACHE_KEY_ONLINE = "online_astrologers";

const rebuildOnlineAstrologersCache = async () => {
    try {
        console.log("🔄 Rebuilding online astrologers cache in Redis...");
        const astrologers = await Astrologer.find({
            status: "approved",
            isOnline: true
        })
        .populate("user")
        .populate("astrologerLogin")
        .lean();

        const astroIds = astrologers.map(a => a._id);
        const interviews = await AstroInterview.find({ astrologer: { $in: astroIds } }).lean();
        const interviewMap = {};
        for (const iv of interviews) {
            interviewMap[String(iv.astrologer)] = iv;
        }

        const result = astrologers.map(astro => ({
            ...astro,
            interview: interviewMap[String(astro._id)] || null
        }));

        await setCache(CACHE_KEY_ONLINE, JSON.stringify(result), 300);
        console.log(`💾 Eagerly cached ${result.length} online astrologers in Redis`);
        return result;
    } catch (err) {
        console.error("Failed to eagerly update Redis cache for online astrologers:", err.message);
    }
};

const clearOnlineAstrologersCache = async () => {
    console.log("🧹 Invalidating and rebuilding online astrologers cache in Redis");
    await rebuildOnlineAstrologersCache();
};

const createAstrologer = async (data) => {
    const astrologer = await Astrologer.create(data);
    await clearOnlineAstrologersCache();
    return await Astrologer.findById(astrologer._id)
        .populate("user")
        .populate("astrologerLogin");
};

const enrichAstrologersWithStats = async (astrologersList) => {
    if (!astrologersList || astrologersList.length === 0) return [];
    
    const ChatSession = require("../models/chatSession.model");
    const VideoSession = require("../models/videoSession.model");
    
    return await Promise.all(astrologersList.map(async (a) => {
        try {
            const [chatCount, callCount, chatEarnings, callEarnings] = await Promise.all([
                ChatSession.countDocuments({ astrologer: a._id, status: "COMPLETED" }),
                VideoSession.countDocuments({ astrologer: a._id, status: { $in: ["COMPLETED", "ACTIVE", "live"] } }),
                ChatSession.aggregate([
                    { $match: { astrologer: a._id, status: "COMPLETED" } },
                    { $group: { _id: null, total: { $sum: "$astrologerEarnings" } } }
                ]),
                VideoSession.aggregate([
                    { $match: { astrologer: a._id, status: "COMPLETED" } },
                    { $group: { _id: null, total: { $sum: "$astrologerEarnings" } } }
                ])
            ]);

            const chatEarn = chatEarnings[0]?.total || 0;
            const callEarn = callEarnings[0]?.total || 0;
            const totalEarnings = parseFloat((chatEarn + callEarn).toFixed(2));

            return {
                ...a,
                totalChats: chatCount,
                totalCalls: callCount,
                totalEarnings: totalEarnings,
                chatEarnings: parseFloat(chatEarn.toFixed(2)),
                callEarnings: parseFloat(callEarn.toFixed(2))
            };
        } catch (err) {
            console.error("Failed to aggregate stats for astrologer:", a._id, err.message);
            return {
                ...a,
                totalChats: 0,
                totalCalls: 0,
                totalEarnings: 0,
                chatEarnings: 0,
                callEarnings: 0
            };
        }
    }));
};

const getAllAstrologers = async (filter = {}, page = null, limit = null) => {
    // Default to status: "approved" for public listing unless custom status filter is requested
    const query = { ...filter };
    if (!query.status && query.status !== "all") {
        query.status = "approved";
    } else if (query.status === "all") {
        delete query.status;
    }

    let mongoQuery = Astrologer.find(query)
        .sort({ isOnline: -1, isAvailable: -1, rating: -1, totalConsultations: -1, createdAt: -1 })
        .populate("user")
        .populate("astrologerLogin");

    if (page && limit) {
        const skip = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        mongoQuery = mongoQuery.skip(skip).limit(parseInt(limit, 10));
    }

    const astrologers = await mongoQuery.lean();

    const enriched = await enrichAstrologersWithStats(astrologers);

    // Batch fetch all interviews in ONE query instead of N queries
    const astroIds = enriched.map(a => a._id);
    const interviews = await AstroInterview.find({ astrologer: { $in: astroIds } }).lean();
    const interviewMap = {};
    for (const iv of interviews) {
        interviewMap[String(iv.astrologer)] = iv;
    }

    return enriched.map(astro => ({
        ...astro,
        interview: interviewMap[String(astro._id)] || null
    }));
};

const getPendingAstrologers = async () => {
    const astrologers = await Astrologer.find({
        $or: [
            { status: "pending" },
            { status: { $exists: false } },
            { status: null }
        ],
        isVerified: { $ne: true }
    })
        .sort({ createdAt: -1 })
        .populate("user")
        .populate("astrologerLogin")
        .lean();

    const enriched = await enrichAstrologersWithStats(astrologers);

    // Batch fetch all interviews in ONE query instead of N queries
    const astroIds = enriched.map(a => a._id);
    const interviews = await AstroInterview.find({ astrologer: { $in: astroIds } }).lean();
    const interviewMap = {};
    for (const iv of interviews) {
        interviewMap[String(iv.astrologer)] = iv;
    }

    return enriched.map(astro => ({
        ...astro,
        interview: interviewMap[String(astro._id)] || null
    }));
};

const getOnlineAstrologers = async () => {
    const cachedData = await getCache(CACHE_KEY_ONLINE);
    if (cachedData) {
        try {
            console.log("💾 Returning cached online astrologers from Redis");
            return JSON.parse(cachedData);
        } catch (e) {
            console.error("Failed to parse cached online astrologers JSON:", e.message);
        }
    }

    return await rebuildOnlineAstrologersCache();
};

const getAstrologerById = async (id) => {
    const astro = await Astrologer.findById(id)
        .populate("user")
        .populate("astrologerLogin");
    if (!astro) return null;
    const interview = await AstroInterview.findOne({ astrologer: astro._id });
    const astroObj = astro.toObject();
    astroObj.interview = interview || null;
    return astroObj;
};

const approveAstrologer = async (id) => {
    const updated = await Astrologer.findByIdAndUpdate(
        id,
        {
            $set: {
                status: "approved",
                isVerified: true
            }
        },
        { returnDocument: 'after' }
    )
    .populate("user")
    .populate("astrologerLogin");
    await clearOnlineAstrologersCache();
    return updated;
};

const rejectAstrologer = async (id) => {
    const updated = await Astrologer.findByIdAndUpdate(
        id,
        {
            $set: {
                status: "rejected",
                isOnline: false,
                isAvailable: false,
                manualOffline: true
            }
        },
        { returnDocument: 'after' }
    )
    .populate("user")
    .populate("astrologerLogin");
    await clearOnlineAstrologersCache();
    return updated;
};

const toggleOnlineStatus = async (id, isOnline, isAvailable) => {
    // Sync status change directly to Redis presence first
    try {
        const { transitionStatus } = require("./presence.service");
        await transitionStatus(id, isOnline ? "ONLINE" : "OFFLINE");
    } catch (err) {
        console.error(`Failed to transition presence status for astro ${id} in toggleOnlineStatus service:`, err.message);
    }

    const updateData = {};
    if (isOnline !== undefined) {
        updateData.isOnline = Boolean(isOnline);
        updateData.manualOffline = !isOnline;
    }
    if (isAvailable !== undefined) updateData.isAvailable = Boolean(isAvailable);

    const updated = await Astrologer.findByIdAndUpdate(
        id,
        { $set: updateData },
        { returnDocument: 'after' }
    )
    .populate("user")
    .populate("astrologerLogin");
    await clearOnlineAstrologersCache();
    return updated;
};

const updateAstrologer = async (id, data) => {
    const existing = await Astrologer.findById(id);
    if (existing) {
        const currentGender = data.gender || existing.gender;
        
        const isDefaultPic = !existing.profileImage || 
            (existing.profileImage.includes("res.cloudinary.com") && 
             (existing.profileImage.includes("astro_female_pic") || 
              existing.profileImage.includes("astro_male_pic") || 
              existing.profileImage.includes("astro_profile_pic")));

        if (data.profileImage === null || data.profileImage === "") {
            const { getDefaultProfilePic } = require("./cloudinary.service");
            data.profileImage = getDefaultProfilePic(id, "astrologer", currentGender);
        } else if (!data.profileImage && isDefaultPic && data.gender && data.gender !== existing.gender) {
            const { getDefaultProfilePic } = require("./cloudinary.service");
            data.profileImage = getDefaultProfilePic(id, "astrologer", data.gender);
        }

        // Sync updates to corresponding AstrologerLogin document
        let astrologerLoginId = existing.astrologerLogin;
        if (!astrologerLoginId && existing.email) {
            const loginDoc = await AstrologerLogin.findOne({ email: existing.email.toLowerCase() });
            if (loginDoc) astrologerLoginId = loginDoc._id;
        }

        if (astrologerLoginId) {
            const loginUpdate = {};
            if (data.name !== undefined) loginUpdate.name = data.name;
            if (data.email !== undefined) loginUpdate.email = data.email.toLowerCase();
            if (data.phone !== undefined) loginUpdate.phone = data.phone;
            if (data.password !== undefined) loginUpdate.password = data.password;

            if (Object.keys(loginUpdate).length > 0) {
                await AstrologerLogin.findByIdAndUpdate(astrologerLoginId, loginUpdate);
            }
        }
    }

    const updated = await Astrologer.findByIdAndUpdate(
        id,
        data,
        {
            returnDocument: 'after',
            runValidators: true
        }
    ).populate("user").populate("astrologerLogin");
    await clearOnlineAstrologersCache();
    return updated;
};

const deleteAstrologer = async (id) => {
    const deleted = await Astrologer.findByIdAndDelete(id);
    await clearOnlineAstrologersCache();
    return deleted;
};

module.exports = {
    createAstrologer,
    getAllAstrologers,
    getPendingAstrologers,
    getOnlineAstrologers,
    rebuildOnlineAstrologersCache,
    getAstrologerById,
    approveAstrologer,
    rejectAstrologer,
    toggleOnlineStatus,
    updateAstrologer,
    deleteAstrologer
};