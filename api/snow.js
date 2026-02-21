/* ═══════════════════════════════════════════════
   api/snow.js — NWS Snow Accumulation Endpoint
   Vercel serverless function.

   Strategy:
   1. For each resort, call NWS /points/{lat},{lng} to discover
      the nearest observation station (cached per Vercel instance).
   2. Fetch the latest observation from that station.
   3. Extract snowfallLast6Hours and snowDepth (SI → inches).
   4. Cache the full response for CACHE_TTL (12 hours).
   5. On error: serve stale cache, then "Unavailable".

   NWS API docs: https://www.weather.gov/documentation/services-web-api
   Rate limits: generous, but cache aggressively per their guidance.
   ═══════════════════════════════════════════════ */

'use strict';

const https = require('https');

// Resorts to fetch snow data for — mirrors window.RESORTS in resorts.js.
// Keep lat/lng in sync if resort coordinates change.
const RESORT_QUERIES = [
  { id: 'snowbowl',        name: 'Montana Snowbowl',                      lat: 46.9528, lng: -113.9987 },
  { id: 'discovery',       name: 'Discovery Ski Area',                    lat: 46.4025, lng: -113.5085 },
  { id: 'lookout-pass',    name: 'Lookout Pass',                          lat: 47.4612, lng: -115.6973 },
  { id: 'lost-trail',      name: 'Lost Trail Powder Mountain',            lat: 45.6956, lng: -113.9457 },
  { id: 'blacktail',       name: 'Blacktail Mountain',                    lat: 47.9419, lng: -114.5289 },
  { id: 'great-divide',    name: 'Great Divide Ski Area',                 lat: 46.8847, lng: -112.0939 },
  { id: 'showdown',        name: 'Showdown Montana',                      lat: 46.8695, lng: -110.9003 },
  { id: 'whitefish',       name: 'Whitefish Mountain Resort',             lat: 48.4925, lng: -114.3561 },
  { id: 'silver-mountain', name: 'Silver Mountain Resort',                lat: 47.5494, lng: -116.1066 },
];

const CACHE_TTL    = 12 * 60 * 60 * 1000; // 12 hours
const REQ_TIMEOUT  = 12000;               // 12 s per NWS request
const USER_AGENT   = 'monitor-the-ski-tuation/1.0 (https://github.com/mtski/monitor-the-situation)';

// Module-level cache — persists across warm Vercel invocations.
let snowCache    = { data: null, ts: 0 };
let stationCache = {};  // resortId → { stationId, stationName }

// ── NWS HTTP helper ────────────────────────────
function nwsGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept':     'application/geo+json',
      },
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode === 404) {
          return reject(Object.assign(new Error('NWS 404'), { status: 404 }));
        }
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          reject(new Error('NWS JSON parse error: ' + e.message));
        }
      });
    });
    req.setTimeout(REQ_TIMEOUT, () => {
      req.destroy(new Error(`NWS request timeout (${REQ_TIMEOUT}ms)`));
    });
    req.on('error', reject);
  });
}

// ── Resolve station for a resort (cached) ─────
async function resolveStation(resort) {
  if (stationCache[resort.id]) return stationCache[resort.id];

  const ptRes = await nwsGet(
    `https://api.weather.gov/points/${resort.lat},${resort.lng}`
  );
  if (ptRes.status !== 200) {
    throw new Error(`Points lookup failed: HTTP ${ptRes.status}`);
  }

  const stationsUrl = ptRes.body.properties?.observationStations;
  if (!stationsUrl) throw new Error('No observationStations URL in NWS response');

  const stRes = await nwsGet(stationsUrl);
  if (stRes.status !== 200) {
    throw new Error(`Station list failed: HTTP ${stRes.status}`);
  }

  const features = stRes.body.features || [];
  if (!features.length) throw new Error('No observation stations found nearby');

  const station = {
    stationId:   features[0].properties.stationIdentifier,
    stationName: features[0].properties.name,
  };
  stationCache[resort.id] = station;
  return station;
}

// ── Meters → inches ───────────────────────────
function toInches(meters) {
  if (meters == null || isNaN(meters)) return null;
  return parseFloat((meters * 39.3701).toFixed(1));
}

// ── Celsius → Fahrenheit ──────────────────────
function toFahrenheit(celsius) {
  if (celsius == null || isNaN(celsius)) return null;
  return Math.round(celsius * 9 / 5 + 32);
}

// ── Fetch snow for one resort ─────────────────
async function fetchSnowForResort(resort) {
  try {
    const { stationId, stationName } = await resolveStation(resort);

    const obsRes = await nwsGet(
      `https://api.weather.gov/stations/${stationId}/observations/latest`
    );
    if (obsRes.status !== 200) {
      throw new Error(`Observation fetch failed: HTTP ${obsRes.status}`);
    }

    const props = obsRes.body.properties || {};

    return {
      id:              resort.id,
      stationId,
      stationName,
      snowfallLast6h:  toInches(props.snowfallLast6Hours?.value),
      snowDepth:       toInches(props.snowDepth?.value),
      tempF:           toFahrenheit(props.temperature?.value),
      observationTime: props.timestamp || null,
      unit:            'in',
      available:       true,
    };
  } catch (err) {
    // Clear station cache on error so next run retries discovery
    delete stationCache[resort.id];
    return {
      id:        resort.id,
      available: false,
      error:     err.message,
    };
  }
}

// ── Handler ───────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=43200, stale-while-revalidate=86400');

  const now = Date.now();

  // Return cached data if fresh
  if (snowCache.data && (now - snowCache.ts) < CACHE_TTL) {
    res.setHeader('X-Snow-Cache', 'HIT');
    res.setHeader('X-Snow-Cache-Age', Math.floor((now - snowCache.ts) / 1000) + 's');
    return res.status(200).json(snowCache.data);
  }

  try {
    // Fetch all resorts in parallel
    const results = await Promise.all(
      RESORT_QUERIES.map(r => fetchSnowForResort(r))
    );

    const data = {
      resorts:     results,
      lastUpdated: new Date().toISOString(),
      source:      'US National Weather Service API (api.weather.gov)',
      note:        'Snow data from the nearest NWS observation station — not resort-specific. Station may be at a lower elevation than the ski area.',
      timeWindow:  'snowfallLast6Hours + snowDepth as reported by NWS ASOS/AWOS stations',
    };

    snowCache = { data, ts: now };

    res.setHeader('X-Snow-Cache', 'MISS');
    return res.status(200).json(data);

  } catch (err) {
    // Serve stale cache rather than an error if we have anything
    if (snowCache.data) {
      res.setHeader('X-Snow-Cache', 'STALE');
      return res.status(200).json(snowCache.data);
    }
    return res.status(503).json({
      error:       'Snow data unavailable',
      message:     err.message,
      lastUpdated: null,
    });
  }
};
