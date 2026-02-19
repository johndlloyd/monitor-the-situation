// Vercel serverless function — Montana MDT RWIS camera manifest.
// Fetches the RWIS XML feed from MDT's FTP server, parses it, and returns
// a filtered JSON list of Montana cameras with coordinates and IDs.
//
// Endpoint: GET /api/mdt
// Returns: JSON array of { id, lat, lng, location }

const https = require('https');

// Montana geographic bounds (with small padding)
const MT_BOUNDS = { north: 49.1, south: 44.2, west: -116.2, east: -103.9 };

// Module-level cache — survives warm Vercel invocations
const cache = {};
const CACHE_TTL   = 10 * 60 * 1000; // 10 min fresh
const CACHE_STALE = 60 * 60 * 1000; // 60 min stale fallback

const XML_URL = 'https://ftp.mdt.mt.gov/travinfo/weather/rwis.xml';

function fetchXml() {
  return new Promise((resolve, reject) => {
    const req = https.request(XML_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/xml,application/xml,*/*;q=0.8',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

function parseMarkers(xml) {
  // Simple regex parser — avoids any XML library dependency.
  // Marker format: <marker lat="..." lng="..." id="..." label="..." .../>
  const cameras = [];
  const re = /<marker\s([^>]+)\/>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1];
    const get = name => {
      const a = new RegExp(`${name}="([^"]*)"`, 'i').exec(attrs);
      return a ? a[1] : '';
    };
    const lat = parseFloat(get('lat'));
    const lng = parseFloat(get('lng'));
    const id  = get('id');
    if (!id || isNaN(lat) || isNaN(lng)) continue;
    // Filter to Montana bounds only
    if (lat < MT_BOUNDS.south || lat > MT_BOUNDS.north) continue;
    if (lng < MT_BOUNDS.west  || lng > MT_BOUNDS.east)  continue;
    cameras.push({ id, lat, lng, location: get('label') || `CAM-${id}` });
  }
  return cameras;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const hit = cache['rwis'];

  // Serve fresh cache immediately
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      'X-Cache':       'HIT',
    });
    return res.end(hit.buf);
  }

  try {
    const { status, buf } = await fetchXml();
    if (status !== 200) throw new Error(`MDT XML returned HTTP ${status}`);

    const xml     = buf.toString('utf8');
    const cameras = parseMarkers(xml);

    if (!cameras.length) throw new Error('No Montana cameras parsed from XML');

    const jsonBuf = Buffer.from(JSON.stringify(cameras), 'utf8');
    cache['rwis'] = { buf: jsonBuf, at: Date.now() };

    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      'X-Cache':       'MISS',
    });
    return res.end(jsonBuf);

  } catch (e) {
    console.error('[mdt] Manifest fetch error:', e.message);

    // Serve stale cache if available
    if (hit && Date.now() - hit.at < CACHE_STALE) {
      res.writeHead(200, {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, s-maxage=60',
        'X-Cache':       'STALE',
      });
      return res.end(hit.buf);
    }

    res.writeHead(502);
    return res.end(JSON.stringify({ error: e.message }));
  }
};
