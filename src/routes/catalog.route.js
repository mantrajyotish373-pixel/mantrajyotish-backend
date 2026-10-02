const express = require("express");
const router = express.Router();
const catalog = require("../controllers/catalog.controller");

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Public: used by the user app. Only active items are returned.
router.get("/store", wrap(catalog.publicStore));
router.get("/add-money", wrap(require("../controllers/addMoneyConfig.controller").publicGet));
router.get("/planets", wrap(catalog.publicPlanets));

module.exports = router;
