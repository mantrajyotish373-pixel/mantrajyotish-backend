const express = require("express");
const multer = require("multer");
const uploadController = require("../controllers/upload.controller");
const authMiddleware = require("../middlewares/auth.middleware");
const { rateLimit } = require("../utils/rateLimit");

const router = express.Router();

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"]);

// Memory storage for Multer file buffer uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 }, // 10 MB limit
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIME.has(String(file.mimetype).toLowerCase())) return cb(null, true);
        const err = new Error("Only image files can be uploaded");
        err.status = 400;
        return cb(err);
    }
});

// The apps send the file under "file" (web) or "image" (mobile chat / profile)
const acceptFile = upload.fields([{ name: "file", maxCount: 1 }, { name: "image", maxCount: 1 }]);

// Uploads cost money (Cloudinary), so only signed-in users may upload and each IP is rate limited.
const uploadLimiter = rateLimit({ keyPrefix: "upload", windowMs: 10 * 60 * 1000, max: 40, message: "Too many uploads. Please try again in a few minutes." });

// Upload Single Image (multipart field "file" or "image", as well as a Base64 JSON body)
router.post("/image", uploadLimiter, authMiddleware, acceptFile, uploadController.uploadImage);
router.post("/base64", uploadLimiter, authMiddleware, uploadController.uploadImage);

module.exports = router;
