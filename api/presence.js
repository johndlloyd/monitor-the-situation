// Vercel serverless — real-time presence counter via Upstash Redis.
// Each client sends a POST heartbeat every 30s with their sessionId.
// Sessions not seen in 90s are pruned. Count = live sorted-set cardinality.
//
// Required env vars (set in Vercel project settings):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const KEY = 'mts_presence';

async function redis(cmd) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  const r = await fetch(
    `${url}/${cmd.map(p => encodeURIComponent(String(p))).join('/')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const json = await r.json();
  return json.result;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  // Graceful fallback when env vars not yet configured
  if (!process.env.UPSTASH_REDIS_REST_URL) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: 1 }));
    return;
  }

  const now = Date.now();

  // Parse body (Vercel may or may not pre-parse it)
  let sessionId = null;
  if (req.method === 'POST') {
    try {
      const raw = await new Promise(resolve => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      });
      const body = JSON.parse(raw || '{}');
      sessionId = body.sessionId || null;
    } catch (_) {}
  }

  try {
    // Register this session (or refresh its score)
    if (sessionId) {
      await redis(['ZADD', KEY, now, sessionId]);
    }

    // Prune sessions silent for more than 90 seconds
    await redis(['ZREMRANGEBYSCORE', KEY, '-inf', now - 90000]);

    // Live count
    const count = (await redis(['ZCARD', KEY])) || 0;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count }));
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count: 1 }));
  }
};
