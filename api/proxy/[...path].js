// Vercel serverless proxy — forwards /api/proxy/* to udottraffic.utah.gov/*

const https = require('https');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Reconstruct target path from [...path] catch-all segments
  const segments = req.query.path || [];
  const targetPath = '/' + (Array.isArray(segments) ? segments.join('/') : segments);

  // Forward query params (everything except the internal 'path' key)
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'path') params.append(k, v);
  }
  const qs = params.toString() ? `?${params.toString()}` : '';

  const options = {
    hostname: 'www.udottraffic.utah.gov',
    port: 443,
    path: targetPath + qs,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MTS-Proxy/1.0)',
      'Accept': req.headers['accept'] || '*/*',
      'Referer': 'https://www.udottraffic.utah.gov/',
      'Origin': 'https://www.udottraffic.utah.gov',
    },
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, {
      'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    });
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: e.message }));
  });

  proxyReq.end();
};
