const path = require("path");
const express = require("express");
const cors = require("cors");
const routes = require("./routes");
const notFoundMiddleware = require("./middlewares/notFound.middleware");
const errorMiddleware = require("./middlewares/error.middleware");

const connectDB = require("./config/db");

const app = express();

// Serve static public assets (sounds, ringtones)
app.use("/public", express.static(path.join(__dirname, "../public")));

// Middlewares
app.use(cors());
// Ensure Razorpay webhook receives raw body for signature verification
app.use((req, res, next) => {
    if (req.originalUrl && req.originalUrl.startsWith("/api/razorpay/webhook")) {
        return express.raw({ type: 'application/json' })(req, res, next);
    }
    return next();
});

// 14mb covers a 10 MB image sent as base64; nothing else needs more
app.use(express.json({ limit: "14mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// Middleware to ensure DB is connected on serverless platforms (Vercel)
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (err) {
        console.error("Database connection error:", err);
        return res.status(500).json({
            success: false,
            message: "Database connection failed"
        });
    }
});

// Health Check Endpoint
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "Backend API Service Running Successfully"
    });
});

// API Routes
app.use(require("./middlewares/maintenance.middleware"));
app.use("/api", routes);

// 404 Handler
app.use(notFoundMiddleware);

// Global Error Handler
app.use(errorMiddleware);

module.exports = app;