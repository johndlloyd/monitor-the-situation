// Vercel serverless function — aggregates camera names from multiple UDOT list endpoints.
// Module-level cache persists across warm function invocations (~5 min TTL).

const https = require('https');

const UDOT    = 'https://www.udottraffic.utah.gov';
const TTL     = 5 * 60 * 1000;
let _cache    = null;
let _cacheAt  = 0;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'MTS/1.0', 'Accept': 'application/json' } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function buildNameMap() {
  const merged = {};

  function absorb(json) {
    const items = Array.isArray(json) ? json : (json.data || json.cameras || []);
    if (!Array.isArray(items)) return;
    items.forEach(c => {
      const id  = String(c.id || c.cameraId || c.itemId || '');
      const loc = c.location || c.name || c.description || c.title || '';
      const rd  = c.roadway  || c.road  || '';
      if (id && loc && !merged[id]) merged[id] = { location: loc, roadway: rd };
    });
  }

  const fetches = [];

  // Try GetUserCameras with listId 0-19 in parallel
  for (let i = 0; i <= 19; i++) {
    fetches.push(
      fetchJson(`${UDOT}/Camera/GetUserCameras?listId=${i}`).then(absorb).catch(() => {})
    );
  }

  // Alternate endpoints
  for (const ep of ['/Camera/GetAllCameras', '/Camera/GetCameras', '/api/cameras']) {
    fetches.push(fetchJson(`${UDOT}${ep}`).then(absorb).catch(() => {}));
  }

  // mapIcons — title field is usually empty but check anyway
  fetches.push(
    fetchJson(`${UDOT}/map/mapIcons/Cameras`).then(data => {
      (data.item2 || []).forEach(item => {
        const id  = String(item.itemId || '');
        const loc = item.title || item.name || item.description || '';
        if (id && loc && !merged[id]) merged[id] = { location: loc, roadway: '' };
      });
    }).catch(() => {})
  );

  await Promise.all(fetches);
  return merged;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=300');

  if (Date.now() - _cacheAt < TTL && _cache) {
    res.json(_cache);
    return;
  }

  _cache   = await buildNameMap();
  _cacheAt = Date.now();
  res.json(_cache);
};
