const express = require("express");

const router = express.Router();

const authRoutes = require("./auth.route");
const userRoutes = require("./user.route");
const astroRoutes = require("./astro.route");
const astrologerLoginRoute = require("./astrologerLogin.route");
const appointmentRoutes = require("./appointment.route");
const paymentRoutes = require("./payment.route");
const razorpayRoutes = require("./razorpay.route");
const videoSessionRoutes = require("./videoSession.route");
const uploadRoutes = require("./upload.route");
const adminRoutes = require("./admin.route");
const astroInterviewRoutes = require("./astroInterview.route");
const chatRoutes = require("./chat.route");
const walletRoutes = require("./wallet.route");
const placesRoutes = require("./places.route");
const deliveryAddressRoutes = require("./deliveryAddress.route");

router.get("/", (req, res) => {
    return res.status(200).json({
        success: true,
        message: "Backend API Service running successfully"
    });
});

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/astro", astroRoutes);
router.use("/astrologer", astrologerLoginRoute);
router.use("/appointment", appointmentRoutes);
router.use("/payment", paymentRoutes);
router.use("/video-session", videoSessionRoutes);
router.use("/razorpay", razorpayRoutes);
router.use("/upload", uploadRoutes);
router.use("/admin", adminRoutes);
router.use("/interview", astroInterviewRoutes);
router.use("/chat", chatRoutes);
router.use("/wallet", walletRoutes);
router.use("/places", placesRoutes);
router.use("/addresses", deliveryAddressRoutes);

module.exports = router;