// Vercel serverless proxy for UDOT Traffic API.
// Sits behind the vercel.json rewrite: /api/proxy/:path* → /api/udot?p=/:path*
// Sends browser-like headers so UDOT doesn't block the request.

const https = require('https');

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Path injected by the rewrite rule as ?p=/some/path
  const targetPath = req.query.p || '/';

  const options = {
    hostname: 'www.udottraffic.utah.gov',
    port: 443,
    path: targetPath,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': req.headers.accept || '*/*',
      'Referer': 'https://www.udottraffic.utah.gov/',
      'Accept-Encoding': 'identity',  // avoid gzip so we can pipe raw bytes safely
    },
  };

  const proxyReq = https.request(options, proxyRes => {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    };
    const ct = proxyRes.headers['content-type'];
    if (ct) headers['Content-Type'] = ct;

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', e => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  proxyReq.end();
};
