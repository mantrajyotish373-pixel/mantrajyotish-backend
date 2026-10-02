const astroInterviewService = require("../services/astroInterview.service");
const Astrologer = require("../models/astro.model");

const isAdminCaller = (req) => req.user && (req.user.role === "admin" || req.user.role === "superadmin");

// Astrologer tokens carry the Astrologer _id; older ones may carry the AstrologerLogin _id.
const findCallerAstrologer = async (req) => {
    if (!req.user || !req.user.userId) return null;
    return await Astrologer.findOne({
        $or: [{ _id: req.user.userId }, { astrologerLogin: req.user.userId }]
    }).catch(() => null);
};

// 1. ASTROLOGER REQUESTS INTERVIEW
const requestInterview = async (req, res, next) => {
    try {
        // Admins may request on behalf of an astrologer; everyone else only for themselves
        let astrologerId = isAdminCaller(req) ? (req.body.astrologerId || req.body.id || req.body.email) : null;

        if (!astrologerId) {
            const astro = await findCallerAstrologer(req);
            if (astro) astrologerId = astro._id;
        }

        const notes = req.body.notes || req.body.requestNotes || "";
        const preferredSlots = req.body.preferredSlots || [];

        const result = await astroInterviewService.requestInterview(astrologerId, notes, preferredSlots);

        return res.status(201).json({
            success: true,
            message: "Interview request submitted successfully. Waiting for admin to schedule.",
            data: result
        });

    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// 2. ADMIN SCHEDULES INTERVIEW (Date, Time, Google Meet Link)
const scheduleInterview = async (req, res, next) => {
    try {
        const identifier = req.params.id || req.body.interviewId || req.body.astrologerId || req.body.email || req.body.id;
        const { interviewDate, meetingLink, notes, interviewerNotes } = req.body;

        if (!interviewDate) {
            return res.status(400).json({
                success: false,
                message: "interviewDate is required to schedule interview"
            });
        }

        const result = await astroInterviewService.scheduleInterview(
            identifier,
            interviewDate,
            meetingLink,
            interviewerNotes || notes
        );

        return res.status(200).json({
            success: true,
            message: "Interview scheduled successfully with Google Meet link",
            data: result
        });

    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// 3. ADMIN EVALUATES RESULT (Pass / Fail)
const evaluateInterview = async (req, res, next) => {
    try {
        const identifier = req.params.id || req.body.interviewId || req.body.astrologerId || req.body.email || req.body.id;
        const resultInput = req.body.result || req.body.status;
        const notes = req.body.interviewerNotes || req.body.notes || "";

        if (!resultInput) {
            return res.status(400).json({
                success: false,
                message: "Interview result is required ('pass' or 'fail')"
            });
        }

        const result = await astroInterviewService.evaluateInterview(
            identifier,
            resultInput,
            notes
        );

        const isPass = result.result === "pass";

        return res.status(200).json({
            success: true,
            message: `Interview result set to ${result.result.toUpperCase()}. Astrologer status automatically updated to ${isPass ? "APPROVED" : "REJECTED"}.`,
            data: result
        });

    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// 3a. PASS INTERVIEW BUTTON HANDLER
const passInterview = async (req, res, next) => {
    try {
        const identifier = req.params.id || req.body.interviewId || req.body.astrologerId || req.body.email || req.body.id;
        const notes = req.body.interviewerNotes || req.body.notes || "";

        const result = await astroInterviewService.evaluateInterview(identifier, "pass", notes);

        return res.status(200).json({
            success: true,
            message: "Interview marked as PASSED. Astrologer status automatically updated to APPROVED.",
            data: result
        });

    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// 3b. FAIL INTERVIEW BUTTON HANDLER
const failInterview = async (req, res, next) => {
    try {
        const identifier = req.params.id || req.body.interviewId || req.body.astrologerId || req.body.email || req.body.id;
        const notes = req.body.interviewerNotes || req.body.notes || "";

        const result = await astroInterviewService.evaluateInterview(identifier, "fail", notes);

        return res.status(200).json({
            success: true,
            message: "Interview marked as FAILED. Astrologer status automatically updated to REJECTED.",
            data: result
        });

    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// 3c. MARK INTERVIEW COMPLETED HANDLER
const completeInterview = async (req, res, next) => {
    try {
        const identifier = req.params.id || req.body.interviewId || req.body.astrologerId || req.body.email || req.body.id;
        const notes = req.body.interviewerNotes || req.body.notes || "";

        const result = await astroInterviewService.completeInterview(identifier, notes);

        return res.status(200).json({
            success: true,
            message: "Interview marked as COMPLETED successfully.",
            data: result
        });

    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// 3d. UPDATE INTERVIEW NOTES HANDLER
const updateNotes = async (req, res, next) => {
    try {
        const identifier = req.params.id || req.body.interviewId || req.body.astrologerId || req.body.email || req.body.id;
        const notes = req.body.interviewerNotes || req.body.notes || "";

        const result = await astroInterviewService.updateInterviewNotes(identifier, notes);

        return res.status(200).json({
            success: true,
            message: "Interview notes saved successfully.",
            data: result
        });

    } catch (error) {
        return res.status(400).json({
            success: false,
            message: error.message
        });
    }
};

// 4. GET ALL INTERVIEWS (Admin)
const getAllInterviews = async (req, res, next) => {
    try {
        const filter = {};
        if (req.query.status) filter.status = req.query.status;
        if (req.query.result) filter.result = req.query.result;

        const interviews = await astroInterviewService.getAllInterviews(filter);

        return res.status(200).json({
            success: true,
            count: interviews.length,
            data: interviews
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// 5. GET PENDING INTERVIEW REQUESTS (Admin)
const getPendingInterviews = async (req, res, next) => {
    try {
        const interviews = await astroInterviewService.getAllInterviews({ status: "requested" });

        return res.status(200).json({
            success: true,
            count: interviews.length,
            data: interviews
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// 6. GET MY INTERVIEW / SPECIFIC ASTROLOGER INTERVIEW DETAILS
const getMyInterview = async (req, res, next) => {
    try {
        let identifier = isAdminCaller(req) ? (req.params.id || req.query.astrologerId || req.query.email || req.query.id) : null;

        if (!identifier) {
            const astro = await findCallerAstrologer(req);
            if (astro) identifier = astro._id;
        }

        const interview = await astroInterviewService.getAstrologerInterview(identifier);

        if (!interview) {
            return res.status(404).json({
                success: false,
                message: "No interview record found for this astrologer"
            });
        }

        const interviewObj = interview.toObject ? interview.toObject() : interview;

        // Format clean Date and Time strings
        let formattedDate = null;
        let formattedTime = null;

        if (interviewObj.interviewDate) {
            const d = new Date(interviewObj.interviewDate);
            formattedDate = d.toLocaleDateString("en-IN", {
                day: "numeric",
                month: "long",
                year: "numeric"
            });
            formattedTime = d.toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                hour12: true
            });
        }

        const formattedResponse = {
            ...interviewObj,
            status: interviewObj.astrologer?.status || "pending",
            interviewStatus: interviewObj.status,
            interviewDate: interviewObj.interviewDate,
            date: formattedDate,
            time: formattedTime,
            meetingLink: interviewObj.meetingLink || null,
            notes: interviewObj.interviewerNotes || interviewObj.requestNotes || null,
            agoraAppId: process.env.AGORA_APP_ID || "af89ac0f87f4412ea75f23aba4717e04",
            agoraChannel: interviewObj.agoraChannel || null,
            agoraToken: interviewObj.agoraAstrologerToken || null,
            agoraUid: interviewObj.agoraAstrologerUid || 2
        };

        return res.status(200).json({
            success: true,
            message: "Astrologer interview details fetched successfully",
            status: interviewObj.astrologer?.status || "pending",
            interviewStatus: interviewObj.status,
            interviewDate: interviewObj.interviewDate,
            agoraAppId: process.env.AGORA_APP_ID || "af89ac0f87f4412ea75f23aba4717e04",
            agoraChannel: interviewObj.agoraChannel || null,
            agoraToken: interviewObj.agoraAstrologerToken || null,
            agoraUid: interviewObj.agoraAstrologerUid || 2,
            data: formattedResponse
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
};

// 7. GENERATE NEW INTERVIEW TOKEN ON DEMAND
const getInterviewToken = async (req, res, next) => {
    try {
        const { id } = req.params; // interviewId
        // The token role follows the caller, not the query string
        const role = isAdminCaller(req) ? "admin" : "astrologer";
        
        const AstroInterview = require("../models/astroInterview.model");
        const agoraService = require("../services/agora.service");

        const interview = await AstroInterview.findById(id);
        if (!interview) {
            return res.status(404).json({ success: false, message: "Interview session not found" });
        }

        if (role === "astrologer") {
            const astro = await findCallerAstrologer(req);
            if (!astro || String(astro._id) !== String(interview.astrologer)) {
                return res.status(403).json({ success: false, message: "Forbidden: This interview does not belong to you" });
            }
        }

        if (!interview.agoraChannel) {
            return res.status(400).json({ success: false, message: "Interview channel is not scheduled yet" });
        }

        const tokenExpireTime = 7200; // 2 hours
        const targetRole = role === "admin" ? "publisher" : "publisher";
        const uid = role === "admin" ? interview.agoraAdminUid : interview.agoraAstrologerUid;

        const tokenData = agoraService.generateRtcToken(interview.agoraChannel, uid, targetRole, tokenExpireTime);

        // Update stored token in database
        if (role === "admin") {
            interview.agoraAdminToken = tokenData.token;
        } else {
            interview.agoraAstrologerToken = tokenData.token;
        }
        await interview.save();

        return res.status(200).json({
            success: true,
            token: tokenData.token,
            channelName: interview.agoraChannel,
            uid,
            appId: tokenData.appId
        });

    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

module.exports = {
    requestInterview,
    scheduleInterview,
    evaluateInterview,
    passInterview,
    failInterview,
    completeInterview,
    updateNotes,
    getAllInterviews,
    getPendingInterviews,
    getMyInterview,
    getInterviewToken
};
