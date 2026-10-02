const cloudinaryService = require("../services/cloudinary.service");

// Upload Image (Base64 string, URL, or File multipart)
const uploadImage = async (req, res) => {
    try {
        let imageUrl = null;

        const uploaded = req.file || (req.files && ((req.files.file && req.files.file[0]) || (req.files.image && req.files.image[0])));

        // 1. If file uploaded via Multer (multipart/form-data)
        if (uploaded && uploaded.buffer) {
            imageUrl = await cloudinaryService.uploadBuffer(uploaded.buffer, "astro_uploads", uploaded.mimetype);
        }
        // 2. If Base64 string or URL sent in body JSON
        else if (req.body && (req.body.image || req.body.file || req.body.base64)) {
            const input = req.body.image || req.body.file || req.body.base64;
            // Only an image data URI or an http(s) link is accepted, and only up to ~10 MB of base64
            const isImageDataUri = typeof input === "string" && /^data:image\/(jpeg|png|webp|gif|heic|heif);base64,/i.test(input);
            const isHttpUrl = typeof input === "string" && /^https?:\/\//i.test(input);
            if (!isImageDataUri && !isHttpUrl) {
                return res.status(400).json({ success: false, message: "Send an image file, an image data URI or an image URL" });
            }
            if (isImageDataUri && input.length > 14 * 1024 * 1024) {
                return res.status(413).json({ success: false, message: "Image is too large (max 10 MB)" });
            }
            imageUrl = await cloudinaryService.uploadBase64OrUrl(input, "astro_uploads");
        }

        if (!imageUrl) {
            return res.status(400).json({
                success: false,
                message: "No image file or base64 string provided"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Image uploaded successfully to Cloudinary",
            url: imageUrl,
            data: {
                url: imageUrl
            }
        });

    } catch (error) {
        console.error("Upload Controller Error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to upload image to Cloudinary"
        });
    }
};

module.exports = {
    uploadImage
};
