// Vercel serverless proxy — forwards /api/proxy/* to udottraffic.utah.gov/*
// Uses fetch + buffer (more reliable than pipe in serverless environments)

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Reconstruct target path from [...path] catch-all segments
  const segments  = req.query.path || [];
  const targetPath = '/' + (Array.isArray(segments) ? segments.join('/') : segments);

  // Forward query params (everything except Vercel's internal 'path' key)
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'path') params.append(k, v);
  }
  const qs  = params.toString() ? `?${params.toString()}` : '';
  const url = `https://www.udottraffic.utah.gov${targetPath}${qs}`;

  try {
    const upstream = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': req.headers['accept'] || '*/*',
        'Referer': 'https://www.udottraffic.utah.gov/',
        'Origin':  'https://www.udottraffic.utah.gov',
      },
    });

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const buffer      = Buffer.from(await upstream.arrayBuffer());

    res.writeHead(upstream.status, {
      'Content-Type':                 contentType,
      'Content-Length':               buffer.length,
      'Cache-Control':                'no-cache',
      'Access-Control-Allow-Origin':  '*',
    });
    res.end(buffer);
  } catch (e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
};
