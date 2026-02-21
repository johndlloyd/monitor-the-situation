/* ═══════════════════════════════════════════════
   api/cam-snapshot.js — Camera Snapshot Proxy
   Vercel serverless function.

   Fetches camera images server-side and caches the buffer
   for 12 hours. Always serves the last known-good snapshot
   on fetch failure. Never returns a blank or broken image.

   Routes:
     GET /api/cam-snapshot?id=<mdtPositionId>   MDT RWIS camera
     GET /api/cam-snapshot?url=<encodedHttpsUrl> Ski / static camera
   ═══════════════════════════════════════════════ */

'use strict';

const https = require('https');
const http  = require('http');
const zlib  = require('zlib');

const CACHE_TTL   = 12 * 60 * 60 * 1000; // 12 hours (fresh cache)
const REQ_TIMEOUT = 15000;                // 15 s per image fetch
const MAX_REDIRECTS = 5;

// ── Placeholder PNG (16×9 dark-gray) ──────────────────────────────
// Generated once at module load. Shown only if a camera has never
// successfully loaded (e.g. brand-new cold start + source is down).
function makePlaceholderPng() {
  const W = 16, H = 9, GRAY = 50;
  const rowSize = 1 + W;
  const raw = Buffer.alloc(rowSize * H);
  for (let y = 0; y < H; y++) {
    raw[y * rowSize] = 0; // filter: None
    raw.fill(GRAY, y * rowSize + 1, y * rowSize + 1 + W);
  }
  const compressed = zlib.deflateSync(raw);

  function crc32buf(data) {
    let c = 0xFFFFFFFF;
    for (const b of data) {
      c ^= b;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
    }
    const n = (c ^ 0xFFFFFFFF) >>> 0;
    return Buffer.from([n >>> 24, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF]);
  }

  function pngChunk(type, data) {
    const t = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, t, data, crc32buf(Buffer.concat([t, data]))]);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  // color type 0 = grayscale; compression/filter/interlace remain 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const PLACEHOLDER_PNG = makePlaceholderPng();

// ── In-memory caches ──────────────────────────────────────────────
// key → { buf, contentType, fetchedAt }
const imageCache   = new Map();
// key → { buf, contentType }  (last successfully fetched image)
const lastGoodCache = new Map();

// ── MDT URL resolution ────────────────────────────────────────────
const ATMS_HOST  = 'app.mdt.mt.gov';
const mdtUrlCache = new Map(); // positionId → { url, at }
const MDT_URL_TTL = 60 * 1000; // re-resolve MDT URL every 60 s

function resolveMdtUrl(positionId) {
  const cached = mdtUrlCache.get(positionId);
  if (cached && Date.now() - cached.at < MDT_URL_TTL) return Promise.resolve(cached.url);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: ATMS_HOST,
      port: 443,
      path: `/atms/public/camera/lastFiveImages/${positionId}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept':     'application/json, */*;q=0.8',
        'Referer':    'https://app.mdt.mt.gov/atms/public/cameras',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json   = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const images = json.data && json.data.lastFivePolledImages;
          if (!images || !images.length) return reject(new Error('No images in MDT response'));
          const url = images[0].publicSharePath;
          if (!url) return reject(new Error('No publicSharePath in MDT response'));
          mdtUrlCache.set(positionId, { url, at: Date.now() });
          resolve(url);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('MDT resolve timeout')); });
    req.end();
  });
}

// ── Image buffer fetch (follows redirects) ────────────────────────
function fetchImageBuffer(url, redirectsLeft) {
  if (redirectsLeft === undefined) redirectsLeft = MAX_REDIRECTS;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { return reject(new Error('Invalid URL: ' + url)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'User-Agent': 'monitor-the-ski-tuation/1.0' },
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        const loc = res.headers.location;
        if (!loc) return reject(new Error('Redirect with no Location header'));
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
        res.resume();
        return resolve(fetchImageBuffer(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from ${parsed.hostname}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        buf:         Buffer.concat(chunks),
        contentType: res.headers['content-type'] || 'image/jpeg',
      }));
    });
    req.on('error', reject);
    req.setTimeout(REQ_TIMEOUT, () => { req.destroy(); reject(new Error('Image fetch timeout')); });
    req.end();
  });
}

// ── SSRF guard ────────────────────────────────────────────────────
const BLOCKED = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::1|169\.254\.)/i;
function isSafeUrl(raw) {
  try {
    const { protocol, hostname } = new URL(raw);
    return protocol === 'https:' && !BLOCKED.test(hostname);
  } catch { return false; }
}

// ── Handler ───────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const { id, url } = req.query || {};

  if (!id && !url) {
    res.writeHead(400); return res.end('Missing id or url parameter');
  }
  if (id && !/^\d+$/.test(id)) {
    res.writeHead(400); return res.end('Invalid id');
  }
  if (url && !isSafeUrl(url)) {
    res.writeHead(400); return res.end('Invalid or disallowed URL');
  }

  const key    = id ? `mdt:${id}` : `url:${url}`;
  const cached = imageCache.get(key);

  // ── Serve fresh in-memory cache ──────────────────────────────
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    res.writeHead(200, {
      'Content-Type':  cached.contentType,
      'Cache-Control': 'public, max-age=43200, stale-while-revalidate=86400',
      'X-Snapshot':    'HIT',
    });
    return res.end(cached.buf);
  }

  // ── Try to fetch a fresh snapshot ────────────────────────────
  try {
    const imageUrl = id ? await resolveMdtUrl(id) : url;
    const { buf, contentType } = await fetchImageBuffer(imageUrl);

    imageCache.set(key, { buf, contentType, fetchedAt: Date.now() });
    lastGoodCache.set(key, { buf, contentType });

    res.writeHead(200, {
      'Content-Type':  contentType,
      'Cache-Control': 'public, max-age=43200, stale-while-revalidate=86400',
      'X-Snapshot':    'MISS',
    });
    return res.end(buf);

  } catch (err) {
    console.error(`[cam-snapshot] ${key}:`, err.message);

    // ── Serve last known-good snapshot ───────────────────────
    const lastGood = lastGoodCache.get(key);
    if (lastGood) {
      res.writeHead(200, {
        'Content-Type':  lastGood.contentType,
        'Cache-Control': 'public, max-age=43200, stale-while-revalidate=86400',
        'X-Snapshot':    'STALE',
      });
      return res.end(lastGood.buf);
    }

    // ── Never had a good image — serve gray placeholder ──────
    res.writeHead(200, {
      'Content-Type':  'image/png',
      'Cache-Control': 'no-store',
      'X-Snapshot':    'PLACEHOLDER',
    });
    return res.end(PLACEHOLDER_PNG);
  }
};
