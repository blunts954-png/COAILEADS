// api/search.js — COAI Lead Engine Backend
// Vercel Serverless Function
//
// Environment variables required in Vercel dashboard:
//   GOOGLE_PLACES_API_KEY  — your Google API key
//   APP_PASSWORD           — primary access token (REQUIRED — no default)
//   APP_TOKENS             — optional comma-separated additional tokens
//                            (enables per-user tokens; any one grants access)
//
// Modes via ?mode= param:
//   geocode  — city string → lat/lng
//   ping     — auth check only, no Google call
//   details  — Place Details for a given place_id
//   default  — NearbySearch with keyword + pagination

const crypto = require('crypto');

// ── In-memory rate limiter (per IP, max 60 req/min per instance) ─────────────
// NOTE: Vercel may spin up multiple serverless instances; this provides
// best-effort protection per instance, not a hard global limit.
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

function isRateLimited(ip) {
  const now = Date.now();
  let entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }
  entry.count++;
  // Prune stale entries to prevent unbounded memory growth
  if (rateLimitStore.size > 10_000) {
    for (const [k, v] of rateLimitStore) {
      if (now > v.resetAt) rateLimitStore.delete(k);
    }
  }
  return entry.count > RATE_LIMIT_MAX;
}

// ── Timing-safe token comparison ─────────────────────────────────────────────
// Both values are hashed first so timingSafeEqual always receives equal-length buffers.
function safeCompare(a, b) {
  try {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  } catch {
    return false;
  }
}

// ── Validate token against APP_PASSWORD and optional APP_TOKENS list ─────────
function isValidToken(token) {
  if (!token) return false;
  const primary = process.env.APP_PASSWORD;
  if (!primary) return false;
  if (safeCompare(token, primary)) return true;
  const extra = process.env.APP_TOKENS;
  if (extra) {
    for (const t of extra.split(',').map(s => s.trim())) {
      if (t && safeCompare(token, t)) return true;
    }
  }
  return false;
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // STARTUP VALIDATION — fail fast if required env vars are missing
  if (!process.env.APP_PASSWORD) {
    console.error('[COAI] FATAL: APP_PASSWORD env var is not set. Configure it in your Vercel dashboard.');
    return res.status(503).json({ error: 'Server misconfigured: APP_PASSWORD not set.' });
  }
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.error('[COAI] FATAL: GOOGLE_PLACES_API_KEY env var is not set. Configure it in your Vercel dashboard.');
    return res.status(503).json({ error: 'Server misconfigured: GOOGLE_PLACES_API_KEY not set.' });
  }

  // RATE LIMITING
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    'unknown';
  if (isRateLimited(ip)) {
    res.setHeader('Retry-After', '60');
    return res.status(429).json({ error: 'Rate limit exceeded. Please wait a minute and try again.' });
  }

  // AUTH CHECK
  if (!isValidToken(req.headers['authorization'])) {
    return res.status(401).json({ error: 'Unauthorized: Invalid Access Key.' });
  }

  const { mode, location, lat, lng, radius = '8000', type, pagetoken, place_id } = req.query;
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  // PING — auth check only
  if (mode === 'ping') {
    return res.status(200).json({ status: 'authorized' });
  }

  try {
    // GEOCODE MODE
    if (mode === 'geocode') {
      if (!location) return res.status(400).json({ error: 'location param required.' });
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${apiKey}`;
      const data = await (await fetch(url)).json();
      return res.status(200).json(data);
    }

    // PLACE DETAILS MODE
    if (mode === 'details') {
      if (!place_id) return res.status(400).json({ error: 'place_id param required.' });
      const fields = 'opening_hours,photos,formatted_address,website,formatted_phone_number,rating,user_ratings_total,business_status';
      const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=${fields}&key=${apiKey}`;
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
};
