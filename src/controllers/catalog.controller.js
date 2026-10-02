const mongoose = require("mongoose");
const StoreProduct = require("../models/storeProduct.model");
const PlanetInsight = require("../models/planetInsight.model");
const { ensureStoreSeed, ensurePlanetSeed } = require("../services/catalogSeed.service");
const { logAudit } = require("../utils/audit");

const fail = (res, code, message) => res.status(code).json({ success: false, message });
const validId = (id) => mongoose.Types.ObjectId.isValid(id);
const audit = (req, entry) => { req.skipAutoAudit = true; logAudit(req, req.admin, entry); };
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isImage = (v) => v === "" || /^https?:\/\//i.test(v);

// ---------- field parsing ----------
const parseProduct = (b, partial) => {
    const out = {};
    if (!partial || b.title !== undefined) { out.title = str(b.title, 120); if (!out.title) throw new Error("Title is required"); }
    if (!partial || b.category !== undefined) { out.category = str(b.category, 60); if (!out.category) throw new Error("Category is required"); }
    if (!partial || b.price !== undefined) {
        const p = Number(b.price);
        if (!Number.isFinite(p) || p < 0 || p > 10000000) throw new Error("Enter a valid price");
        out.price = p;
    }
    if (b.oldPrice !== undefined) {
        const o = b.oldPrice === "" || b.oldPrice === null ? 0 : Number(b.oldPrice);
        if (!Number.isFinite(o) || o < 0) throw new Error("Enter a valid old price");
        out.oldPrice = o;
    }
    const price = out.price ?? Number(b.price);
    if (out.oldPrice && Number.isFinite(price) && out.oldPrice < price) throw new Error("Old price must be higher than the selling price");
    if (b.description !== undefined) out.description = str(b.description, 1000);
    if (b.image !== undefined) { out.image = str(b.image, 1000); if (!isImage(out.image)) throw new Error("Image must be an http(s) link"); }
    if (b.rating !== undefined) {
        const r = Number(b.rating);
        if (!Number.isFinite(r) || r < 0 || r > 5) throw new Error("Rating must be between 0 and 5");
        out.rating = r;
    }
    if (b.popular !== undefined) out.popular = !!b.popular;
    if (b.status !== undefined) { if (!["active", "hidden"].includes(b.status)) throw new Error("Invalid status"); out.status = b.status; }
    if (b.sortOrder !== undefined) out.sortOrder = Math.trunc(Number(b.sortOrder) || 0);
    return out;
};

const parsePlanet = (b, partial) => {
    const out = {};
    if (!partial || b.title !== undefined) { out.title = str(b.title, 80); if (!out.title) throw new Error("Title is required"); }
    if (!partial || b.description !== undefined) { out.description = str(b.description, 200); if (!out.description) throw new Error("Short description is required"); }
    if (b.details !== undefined) out.details = str(b.details, 3000);
    if (b.image !== undefined) { out.image = str(b.image, 1000); if (!isImage(out.image)) throw new Error("Image must be an http(s) link"); }
    if (b.bgColor !== undefined) out.bgColor = str(b.bgColor, 30);
    if (b.status !== undefined) { if (!["active", "hidden"].includes(b.status)) throw new Error("Invalid status"); out.status = b.status; }
    if (b.sortOrder !== undefined) out.sortOrder = Math.trunc(Number(b.sortOrder) || 0);
    return out;
};

// ---------- generic CRUD factory ----------
const makeAdminCrud = (Model, parse, seed, label, moduleKey) => ({
    list: async (req, res) => {
        await seed();
        const rows = await Model.find().sort({ sortOrder: 1, createdAt: 1 }).lean();
        res.json({ success: true, data: rows });
    },
    create: async (req, res) => {
        let fields;
        try { fields = parse(req.body || {}, false); } catch (e) { return fail(res, 400, e.message); }
        const last = await Model.findOne().sort({ sortOrder: -1 }).select("sortOrder").lean();
        if (req.body?.sortOrder === undefined) fields.sortOrder = (last?.sortOrder ?? -1) + 1;
        const doc = await Model.create({ ...fields, updatedBy: req.admin._id });
        audit(req, { action: `${moduleKey}.manage`, module: moduleKey, statusCode: 201, summary: `Added ${label} "${doc.title}"` });
        res.status(201).json({ success: true, data: doc });
    },
    update: async (req, res) => {
        if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
        const existing = await Model.findById(req.params.id);
        if (!existing) return fail(res, 404, `${label} not found`);
        let fields;
        try { fields = parse({ ...(req.body || {}), price: req.body?.price ?? existing.price }, true); } catch (e) { return fail(res, 400, e.message); }
        if (req.body?.price === undefined) delete fields.price;
        Object.assign(existing, fields, { updatedBy: req.admin._id });
        await existing.save();
        audit(req, { action: `${moduleKey}.manage`, module: moduleKey, statusCode: 200, summary: `Edited ${label} "${existing.title}"` });
        res.json({ success: true, data: existing });
    },
    remove: async (req, res) => {
        if (!validId(req.params.id)) return fail(res, 400, "Invalid id");
        const doc = await Model.findByIdAndDelete(req.params.id);
        if (!doc) return fail(res, 404, `${label} not found`);
        audit(req, { action: `${moduleKey}.manage`, module: moduleKey, statusCode: 200, summary: `Removed ${label} "${doc.title}"` });
        res.json({ success: true, message: `${label} removed` });
    }
});

const store = makeAdminCrud(StoreProduct, parseProduct, ensureStoreSeed, "product", "store");
const planets = makeAdminCrud(PlanetInsight, parsePlanet, ensurePlanetSeed, "planetary insight", "planets");

// ---------- public (mobile app) ----------
const publicStore = async (req, res) => {
    await ensureStoreSeed();
    const rows = await StoreProduct.find({ status: "active" }).sort({ sortOrder: 1, createdAt: 1 }).lean();
    res.json({ success: true, data: rows.map((p) => ({ id: String(p._id), title: p.title, category: p.category, description: p.description, price: p.price, oldPrice: p.oldPrice, image: p.image, rating: p.rating, popular: p.popular })) });
};

const publicPlanets = async (req, res) => {
    await ensurePlanetSeed();
    const rows = await PlanetInsight.find({ status: "active" }).sort({ sortOrder: 1, createdAt: 1 }).lean();
    res.json({ success: true, data: rows.map((p) => ({ id: String(p._id), key: p.key, title: p.title, description: p.description, details: p.details, image: p.image, bgColor: p.bgColor })) });
};

module.exports = { store, planets, publicStore, publicPlanets };
