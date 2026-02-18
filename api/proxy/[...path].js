// Vercel serverless proxy — forwards /api/proxy/* to udottraffic.utah.gov/*
// Resolves browser CORS restrictions on the UDOT public API.

const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // Reconstruct target path from [...path] segments
  const segments = req.query.path;
  const targetPath = '/' + (Array.isArray(segments) ? segments.join('/') : (segments || ''));

  // Forward any query params that aren't the Vercel path param
  const params = new URLSearchParams();
  Object.entries(req.query).forEach(([k, v]) => {
    if (k !== 'path') params.append(k, v);
  });
  const qs = params.toString() ? `?${params.toString()}` : '';

  const options = {
    hostname: 'www.udottraffic.utah.gov',
    port: 443,
    path: targetPath + qs,
    method: 'GET',
    headers: {
      'User-Agent': 'MTS-Proxy/1.0',
      'Accept': req.headers.accept || '*/*',
      'Referer': 'https://www.udottraffic.utah.gov/',
    },
  };

  return new Promise((resolve) => {
    const proxyReq = https.request(options, (proxyRes) => {
      res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.status(proxyRes.statusCode);
      proxyRes.pipe(res);
      proxyRes.on('end', resolve);
    });
    proxyReq.on('error', (e) => {
      res.status(502).json({ error: e.message });
      resolve();
    });
    proxyReq.end();
  });
};
