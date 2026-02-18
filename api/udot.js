// Vercel serverless proxy for UDOT Traffic API.
// Sits behind the vercel.json rewrite: /api/proxy/:path* → /api/udot?p=/:path*
//
// Resilience strategy:
//   - JSON responses: validate content, cache on success, serve stale on failure.
//   - Image responses: proxy directly (not cached — they change every ~30s).
//   - If UDOT returns HTML / a WAF challenge: return a clean JSON error (not the HTML).

const https = require('https');

// Module-level cache survives warm invocations.  key = path, value = { buf, at }
const cache = {};
const CACHE_TTL     = 10 * 60 * 1000; // 10 min fresh
const CACHE_STALE   = 60 * 60 * 1000; // 60 min stale-while-revalidate

function udotRequest(path, acceptHeader) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'www.udottraffic.utah.gov',
      port: 443,
      path,
      method: 'GET',
      headers: {
        'User-Agent':        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept':            acceptHeader || 'application/json, */*;q=0.8',
        'Accept-Language':   'en-US,en;q=0.9',
        'Accept-Encoding':   'identity',
        'Referer':           'https://www.udottraffic.utah.gov/map',
        'Origin':            'https://www.udottraffic.utah.gov',
        'sec-fetch-dest':    'empty',
        'sec-fetch-mode':    'cors',
        'sec-fetch-site':    'same-origin',
        'Cache-Control':     'no-cache',
      },
    }, proxyRes => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => resolve({
        status: proxyRes.statusCode,
        ct:     proxyRes.headers['content-type'] || '',
        buf:    Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
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

  const targetPath = req.query.p || '/';
  const isImage    = /\/Cctv\//i.test(targetPath);

  // ── IMAGES: proxy directly, no caching ──────────────────────────────────
  if (isImage) {
    try {
      const { status, ct, buf } = await udotRequest(targetPath, 'image/jpeg,*/*');
      res.writeHead(status, {
        'Content-Type':              ct || 'image/jpeg',
        'Cache-Control':             'public, max-age=30',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(buf);
    } catch (e) {
      res.writeHead(502);
      return res.end();
    }
  }

  // ── JSON: validate → cache → serve stale on failure ─────────────────────
  const hit = cache[targetPath];

  // Serve fresh cache immediately (skip UDOT entirely)
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    res.writeHead(200, {
      'Content-Type':  'application/json',
      'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      'X-Cache':       'HIT',
    });
    return res.end(hit.buf);
  }

  try {
    const { buf } = await udotRequest(targetPath, 'application/json, */*;q=0.8');
    const text    = buf.toString('utf8').trimStart();

    if (text.startsWith('{') || text.startsWith('[')) {
      // Valid JSON — update cache and respond
      cache[targetPath] = { buf, at: Date.now() };
      res.writeHead(200, {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        'X-Cache':       'MISS',
      });
      return res.end(buf);
    }

    // UDOT returned HTML / WAF challenge — serve stale if available
    console.error('[udot] Non-JSON from UDOT:', text.slice(0, 120));
    if (hit && Date.now() - hit.at < CACHE_STALE) {
      res.writeHead(200, {
        'Content-Type':  'application/json',
        'Cache-Control': 'public, s-maxage=60',
        'X-Cache':       'STALE',
      });
      return res.end(hit.buf);
    }

    res.writeHead(503);
    return res.end(JSON.stringify({
      error:   'UDOT API unavailable — non-JSON response',
      preview: text.slice(0, 80),
    }));

  } catch (e) {
    // Network-level failure — serve stale if available
    console.error('[udot] Fetch error:', e.message);
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
