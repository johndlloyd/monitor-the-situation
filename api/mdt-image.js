// Vercel serverless function — Montana MDT camera image redirect.
// Calls the MDT ATMS API to get the latest image URL for a given positionId,
// then returns a 302 redirect so the browser fetches the image directly from MDT.
//
// Endpoint: GET /api/mdt-image?id={positionId}
//
// This redirect approach keeps our server bandwidth near-zero while still
// resolving the dynamic, timestamp-based MDT image URLs.

const https = require('https');

// Short-lived URL cache: we don't need to call the API for every page refresh.
// Key = positionId, value = { url, at }
const urlCache = {};
const URL_CACHE_TTL = 30 * 1000; // 30 seconds

const ATMS_HOST = 'app.mdt.mt.gov';

function fetchLatestImageUrl(positionId) {
  return new Promise((resolve, reject) => {
    const path = `/atms/public/camera/lastFiveImages/${positionId}`;
    const req = https.request({
      hostname: ATMS_HOST,
      port:     443,
      path,
      method:   'GET',
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
          const json    = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const images  = json.data && json.data.lastFivePolledImages;
          if (!images || !images.length) return reject(new Error('No images in response'));
          const latest  = images[0];
          if (!latest.publicSharePath) return reject(new Error('No publicSharePath'));
          resolve(latest.publicSharePath);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const positionId = req.query.id;
  if (!positionId || !/^\d+$/.test(positionId)) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: 'Missing or invalid id parameter' }));
  }

  // Serve cached URL if fresh
  const cached = urlCache[positionId];
  if (cached && Date.now() - cached.at < URL_CACHE_TTL) {
    res.writeHead(302, { 'Location': cached.url, 'Cache-Control': 'public, max-age=30' });
    return res.end();
  }

  try {
    const imageUrl = await fetchLatestImageUrl(positionId);
    urlCache[positionId] = { url: imageUrl, at: Date.now() };

    res.writeHead(302, {
      'Location':      imageUrl,
      'Cache-Control': 'public, max-age=30',
    });
    return res.end();

  } catch (e) {
    console.error(`[mdt-image] id=${positionId} error:`, e.message);

    // Serve stale URL rather than a broken image
    if (cached) {
      res.writeHead(302, { 'Location': cached.url, 'Cache-Control': 'public, max-age=10' });
      return res.end();
    }

    // No image available — return a 1×1 transparent GIF as a graceful fallback
    // so the grid cell shows the error state rather than a broken img icon.
    const TRANSPARENT_GIF = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
      'base64'
    );
    res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
    return res.end(TRANSPARENT_GIF);
  }
};
