const express = require('express');
const router = express.Router();
const { getAutocomplete, getPlaceDetails } = require('../controllers/places.controller');

router.get('/autocomplete', getAutocomplete);
router.post('/autocomplete', getAutocomplete);
router.get('/details/:placeId', getPlaceDetails);

module.exports = router;
