const cloudinary = require("cloudinary").v2;

// Configure Cloudinary with environment variables
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "",
    api_key: process.env.CLOUDINARY_API_KEY || "",
    api_secret: process.env.CLOUDINARY_API_SECRET || ""
});

const isCloudinaryConfigured = () => {
    return Boolean(
        process.env.CLOUDINARY_CLOUD_NAME &&
        process.env.CLOUDINARY_API_KEY &&
        process.env.CLOUDINARY_API_SECRET
    );
};

/**
 * Upload Base64 data string or Image URL to Cloudinary
 * @param {string} fileInput - Base64 image data string or URL
 * @param {string} folder - Destination folder on Cloudinary
 */
const uploadBase64OrUrl = async (fileInput, folder = "astro_app") => {
    if (!fileInput) return null;

    // If input is already an http/https Cloudinary URL, return as is
    if (typeof fileInput === "string" && (fileInput.startsWith("http://") || fileInput.startsWith("https://"))) {
        return fileInput;
    }

    if (!isCloudinaryConfigured()) {
        console.log("[MOCK CLOUDINARY UPLOAD] Cloudinary credentials not set. Returning data URL fallback.");
        return fileInput;
    }

    try {
        const result = await cloudinary.uploader.upload(fileInput, {
            folder: folder,
            resource_type: "auto"
        });

        let url = result.secure_url;
        if (url && url.includes("/upload/")) {
            url = url.replace("/upload/", "/upload/f_auto,q_auto/");
        }
        return url;
    } catch (error) {
        console.error("Cloudinary Upload Error (falling back to input data):", error.message || error);
        return fileInput;
    }
};

/**
 * Upload Buffer (from Multer file upload) to Cloudinary
 * @param {Buffer} fileBuffer - Multer file buffer
 * @param {string} folder - Destination folder on Cloudinary
 * @param {string} mimetype - The file's MIME type for Base64 fallback
 */
const uploadBuffer = async (fileBuffer, folder = "astro_app", mimetype = "image/jpeg") => {
    if (!fileBuffer) return null;

    const base64DataUri = `data:${mimetype};base64,${fileBuffer.toString("base64")}`;

    if (!isCloudinaryConfigured()) {
        console.log("[MOCK CLOUDINARY UPLOAD] Cloudinary credentials not set. Returning base64 data URL fallback.");
        return base64DataUri;
    }

    return new Promise((resolve) => {
        const uploadStream = cloudinary.uploader.upload_stream(
            { folder: folder, resource_type: "auto" },
            (error, result) => {
                if (error) {
                    console.error("Cloudinary Buffer Upload Error (falling back to base64 Data URL):", error.message || error);
                    return resolve(base64DataUri);
                }
                let url = result.secure_url;
                if (url && url.includes("/upload/")) {
                    url = url.replace("/upload/", "/upload/f_auto,q_auto/");
                }
                resolve(url);
            }
        );
        uploadStream.end(fileBuffer);
    });
};

/**
 * Generate a stable deterministic Cloudinary URL for default profile pictures based on MongoDB ID, role, and gender.
 * Maps to user_female_pic_X, user_male_pic_X, astro_female_pic_X, astro_male_pic_X, or default public IDs.
 * @param {string|ObjectId} id - MongoDB ID of user or astrologer
 * @param {string} role - Role of the account ("user", "astrologer", etc.)
 * @param {string} gender - Gender of the account ("female", "male", etc.)
 */
const getDefaultProfilePic = (id, role, gender) => {
    if (!id) return null;
    const idStr = id.toString();

    // Deterministic hash based on ID string
    let hash = 0;
    for (let i = 0; i < idStr.length; i++) {
        hash = idStr.charCodeAt(i) + ((hash << 5) - hash);
    }

    const isAstro = role === "astrologer" || role === "astro" || role === "admin";
    const normalizedGender = (gender || "").toLowerCase();

    // Configurable illustration counts with defaults
    const userMaleCount = parseInt(process.env.USER_MALE_DP_COUNT) ?? 5;
    const userFemaleCount = parseInt(process.env.USER_FEMALE_DP_COUNT) ?? 4;
    const astroMaleCount = parseInt(process.env.ASTRO_MALE_DP_COUNT) ?? 4;
    const astroFemaleCount = parseInt(process.env.ASTRO_FEMALE_DP_COUNT) ?? 6;

    let prefix;
    let count;

    if (isAstro) {
        let useFemale = normalizedGender === "female";
        if (!normalizedGender) {
            // Deterministically distribute male/female default images based on the ID hash
            useFemale = Math.abs(hash % 2) === 0;
        }

        if (useFemale && astroFemaleCount > 0) {
            prefix = "astro_female_pic";
            count = astroFemaleCount;
        } else {
            prefix = "astro_male_pic";
            count = astroMaleCount > 0 ? astroMaleCount : 1;
        }
    } else {
        let useFemale = normalizedGender === "female";
        if (!normalizedGender) {
            // Deterministically distribute male/female default images based on the ID hash
            useFemale = Math.abs(hash % 2) === 0;
        }

        if (useFemale && userFemaleCount > 0) {
            prefix = "user_female_pic";
            count = userFemaleCount;
        } else {
            prefix = "user_male_pic";
            count = userMaleCount > 0 ? userMaleCount : 1;
        }
    }

    const index = Math.abs(hash % count) + 1; // 1 to count

    const cloudName = process.env.CLOUDINARY_CLOUD_NAME || "dwbhbwgz9";
    return `https://res.cloudinary.com/${cloudName}/image/upload/f_auto,q_auto/v1/${prefix}_${index}`;
};

/**
 * Strict upload of an already-converted WebP buffer (used for app banners).
 * Unlike uploadBuffer it never falls back to a base64 data URL: the caller gets an error instead.
 * Returns { url, publicId }.
 */
const uploadWebpStrict = async (buffer, folder) => {
    if (!isCloudinaryConfigured()) throw new Error("Image storage (Cloudinary) is not configured on the server");
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            { folder, resource_type: "image", format: "webp", overwrite: false },
            (error, result) => (error ? reject(new Error(error.message || "Image upload failed")) : resolve({ url: result.secure_url, publicId: result.public_id }))
        );
        stream.end(buffer);
    });
};

const deleteByPublicId = async (publicId) => {
    if (!publicId || !isCloudinaryConfigured()) return;
    try { await cloudinary.uploader.destroy(publicId, { resource_type: "image" }); }
    catch (e) { console.error("Cloudinary delete error:", e.message || e); }
};

module.exports = {
    uploadWebpStrict,
    deleteByPublicId,
    isCloudinaryConfigured,
    uploadBase64OrUrl,
    uploadBuffer,
    getDefaultProfilePic
};
