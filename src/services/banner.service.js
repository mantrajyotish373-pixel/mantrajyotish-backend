const sharp = require("sharp");
const cloudinaryService = require("./cloudinary.service");

const BANNER_WIDTH = 1080;
const BANNER_HEIGHT = Math.round(BANNER_WIDTH / 2.35); // matches the app's banner ratio
const WEBP_QUALITY = 80;
const ALLOWED_FORMATS = new Set(["jpeg", "png", "webp"]);

/**
 * Turn an uploaded JPG / JPEG / PNG / WebP into a small WebP at the banner size.
 * The type is checked from the real file bytes, not the file name or the client's mimetype.
 */
const toBannerWebp = async (buffer) => {
    let meta;
    try {
        meta = await sharp(buffer).metadata();
    } catch {
        throw Object.assign(new Error("This file is not a valid image"), { status: 400 });
    }
    if (!ALLOWED_FORMATS.has(meta.format)) {
        throw Object.assign(new Error("Upload a JPG, JPEG, PNG or WebP image"), { status: 400 });
    }
    const { data, info } = await sharp(buffer)
        .rotate() // apply EXIF orientation, metadata is dropped on output
        .resize(BANNER_WIDTH, BANNER_HEIGHT, { fit: "cover", position: "attention" })
        .webp({ quality: WEBP_QUALITY, effort: 4 })
        .toBuffer({ resolveWithObject: true });
    return { buffer: data, width: info.width, height: info.height, bytes: info.size };
};

const uploadBannerImage = async (fileBuffer) => {
    const webp = await toBannerWebp(fileBuffer);
    const { url, publicId } = await cloudinaryService.uploadWebpStrict(webp.buffer, "astro_banners");
    return { imageUrl: url, imagePublicId: publicId, imageBytes: webp.bytes, width: webp.width, height: webp.height };
};

module.exports = { uploadBannerImage, toBannerWebp, BANNER_WIDTH, BANNER_HEIGHT };
