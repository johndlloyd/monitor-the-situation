// Diagnostic endpoint — visit /api/test in browser to see what's happening
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  const results = {};

  // Test 1: can we reach UDOT at all?
  try {
    const r = await fetch('https://www.udottraffic.utah.gov/map/mapIcons/Cameras', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.udottraffic.utah.gov/',
      },
    });
    const text = await r.text();
    results.udot_status  = r.status;
    results.udot_headers = Object.fromEntries(r.headers.entries());
    results.udot_body_preview = text.slice(0, 300);
    results.udot_body_length  = text.length;
  } catch (e) {
    results.udot_error = e.message;
  }

  // Test 2: check our own proxy path param parsing
  results.query = req.query;
  results.url   = req.url;

  res.end(JSON.stringify(results, null, 2));
};
