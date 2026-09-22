/**
 * Google Places API (New) Autocomplete Controller
 * Endpoints:
 * - GET /api/places/autocomplete?input=...&sessionToken=...
 * - GET /api/places/details/:placeId?sessionToken=...
 */

const getAutocomplete = async (req, res) => {
  try {
    const input = (req.query?.input || req.body?.input || '').trim();
    const sessionToken = req.query?.sessionToken || req.body?.sessionToken;

    if (!input || input.length < 2) {
      return res.status(200).json({
        success: true,
        suggestions: []
      });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      console.error('❌ GOOGLE_MAPS_API_KEY is missing in backend .env');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error'
      });
    }

    const payload = {
      input,
      ...(sessionToken ? { sessionToken } : {}),
    };

    const response = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Google Places Autocomplete API Error:', data);
      return res.status(response.status).json({
        success: false,
        message: data?.error?.message || 'Failed to fetch location suggestions'
      });
    }

    const rawSuggestions = data.suggestions || [];
    const suggestions = rawSuggestions.slice(0, 5).map((s) => {
      const p = s.placePrediction || {};
      const mainText = p.structuredFormat?.mainText?.text || p.text?.text || '';
      const secondaryText = p.structuredFormat?.secondaryText?.text || '';
      const placeId = p.placeId || (p.place ? p.place.replace('places/', '') : '');

      return {
        placeId,
        name: mainText,
        secondaryText,
        fullText: secondaryText ? `${mainText}, ${secondaryText}` : mainText,
      };
    }).filter((s) => s.placeId && s.name);

    return res.status(200).json({
      success: true,
      suggestions
    });
  } catch (error) {
    console.error('❌ Error in getAutocomplete:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while searching places'
    });
  }
};

const getPlaceDetails = async (req, res) => {
  try {
    let placeId = req.params?.placeId || req.query?.placeId;
    const sessionToken = req.query?.sessionToken || req.body?.sessionToken;

    if (!placeId) {
      return res.status(400).json({
        success: false,
        message: 'Place ID is required'
      });
    }

    // Clean placeId if prefixed with 'places/'
    if (placeId.startsWith('places/')) {
      placeId = placeId.replace('places/', '');
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      console.error('❌ GOOGLE_MAPS_API_KEY is missing in backend .env');
      return res.status(500).json({
        success: false,
        message: 'Server configuration error'
      });
    }

    let url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
    if (sessionToken) {
      url += `?sessionToken=${encodeURIComponent(sessionToken)}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,addressComponents'
      }
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Google Places Details API Error:', data);
      return res.status(response.status).json({
        success: false,
        message: data?.error?.message || 'Failed to fetch place details'
      });
    }

    const addressComponents = data.addressComponents || [];
    const getComponent = (types) => {
      const match = addressComponents.find((c) =>
        types.some((t) => (c.types || []).includes(t))
      );
      return match ? match.longText || match.shortText || '' : '';
    };

    const city = getComponent(['locality', 'administrative_area_level_3', 'sublocality_level_1', 'postal_town']) || data.displayName?.text || '';
    const district = getComponent(['administrative_area_level_2']) || city;
    const state = getComponent(['administrative_area_level_1']) || '';
    const country = getComponent(['country']) || '';
    const latitude = data.location?.latitude || 0;
    const longitude = data.location?.longitude || 0;
    const name = data.displayName?.text || city || data.formattedAddress || '';
    const formattedAddress = data.formattedAddress || name;

    const details = {
      placeId: data.id || placeId,
      name,
      formattedAddress,
      city,
      district,
      state,
      country,
      latitude,
      longitude
    };

    return res.status(200).json({
      success: true,
      data: details
    });
  } catch (error) {
    console.error('❌ Error in getPlaceDetails:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error while fetching place details'
    });
  }
};

module.exports = {
  getAutocomplete,
  getPlaceDetails
};
