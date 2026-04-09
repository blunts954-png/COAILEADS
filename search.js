// api/search.js — COAI Lead Engine Backend
// Vercel Serverless Function
//
// Environment variables required in Vercel dashboard:
//   GOOGLE_PLACES_API_KEY  — your Google API key
//   APP_PASSWORD           — your access token (e.g. COAI-GOD-MODE-2026)
//
// Modes via ?mode= param:
//   geocode  — city string → lat/lng
//   ping     — auth check only, no Google call
//   default  — NearbySearch with keyword + pagination

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // AUTH CHECK
  const MASTER_PASSWORD = process.env.APP_PASSWORD || 'COAI-GOD-MODE-2026';
  const userAuth = req.headers['authorization'];

  if (userAuth !== MASTER_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Access Key.' });
  }

  const { mode, location, lat, lng, radius = '8000', type, pagetoken } = req.query;

  // PING — auth check only
  if (mode === 'ping') {
    return res.status(200).json({ status: 'authorized' });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GOOGLE_PLACES_API_KEY not set in Vercel env vars.' });
  }

  try {
    // GEOCODE MODE
    if (mode === 'geocode') {
      if (!location) return res.status(400).json({ error: 'location param required.' });
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
      const data = await (await fetch(url)).json();
      return res.status(200).json(data);
    }

    // NEARBYSEARCH (default)
    if (!type) return res.status(400).json({ error: 'type param required.' });

    let resolvedLat = lat;
    let resolvedLng = lng;

    if (!resolvedLat || !resolvedLng) {
      if (!location) return res.status(400).json({ error: 'Provide lat+lng or location.' });
      const geoUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
      const geoData = await (await fetch(geoUrl)).json();
      if (geoData.status !== 'OK' || !geoData.results.length) {
        return res.status(400).json({ error: 'Geocode failed: ' + geoData.status });
      }
      resolvedLat = geoData.results[0].geometry.location.lat;
      resolvedLng = geoData.results[0].geometry.location.lng;
    }

    let placesUrl = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
      + `?location=${resolvedLat},${resolvedLng}`
      + `&radius=${radius}`
      + `&keyword=${encodeURIComponent(type)}`
      + `&key=${apiKey}`;

    if (pagetoken) placesUrl += `&pagetoken=${encodeURIComponent(pagetoken)}`;

    const placesData = await (await fetch(placesUrl)).json();
    return res.status(200).json(placesData);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
