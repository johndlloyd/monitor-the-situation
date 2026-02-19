#!/usr/bin/env node
/* ═══════════════════════════════════════════════
   MTS — MONITOR THE SITUATION CLI (Montana)
   For use standalone or as an openclaw agent tool

   Usage:
     mts cameras [--area missoula] [--route I-90] [--lat LAT --lng LNG --radius MILES]
     mts weather [--area missoula]
     mts show <camera-id>
     mts serve [--port 8080]
   ═══════════════════════════════════════════════ */

'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');

const MDT_ATMS_HOST = 'app.mdt.mt.gov';
const MDT_FTP_HOST  = 'ftp.mdt.mt.gov';
const MDT_IMG_HOST  = 'mdt.mt.gov';

// Montana geographic bounds
const MT_BOUNDS = { north: 49.1, south: 44.2, west: -116.2, east: -103.9 };

// ── ANSI Colors ────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  white:  '\x1b[97m',
  gray:   '\x1b[90m',
};

const c = (color, str) => `${C[color]}${str}${C.reset}`;

// ── Known regions ──────────────────────────────
const REGIONS = {
  'missoula':   { lat: 46.8721, lng: -113.9940, radius: 30,  name: 'Missoula'         },
  'helena':     { lat: 46.5958, lng: -112.0270, radius: 25,  name: 'Helena'           },
  'butte':      { lat: 46.0038, lng: -112.5348, radius: 25,  name: 'Butte'            },
  'kalispell':  { lat: 48.1950, lng: -114.3160, radius: 25,  name: 'Kalispell'        },
  'billings':   { lat: 45.7833, lng: -108.5007, radius: 25,  name: 'Billings'         },
  'bozeman':    { lat: 45.9163, lng: -112.5296, radius: 25,  name: 'Bozeman'          },
  'greatfalls': { lat: 47.5268, lng: -111.2972, radius: 25,  name: 'Great Falls'      },
  'havre':      { lat: 48.5553, lng: -109.6839, radius: 25,  name: 'Havre'            },
  'lewistown':  { lat: 47.0527, lng: -109.4309, radius: 25,  name: 'Lewistown'        },
  'milescity':  { lat: 46.4082, lng: -105.8406, radius: 25,  name: 'Miles City'       },
  'glendive':   { lat: 47.1053, lng: -104.7114, radius: 25,  name: 'Glendive'         },
  'wolfpoint':  { lat: 48.1225, lng: -106.6251, radius: 25,  name: 'Wolf Point'       },
  'livingston': { lat: 45.6770, lng: -111.0429, radius: 20,  name: 'Livingston'       },
  'i90':        { route: 'I-90',                              name: 'I-90 Corridor'    },
  'i15':        { route: 'I-15',                              name: 'I-15 Corridor'    },
  'i94':        { route: 'I-94',                              name: 'I-94 Corridor'    },
  'montana':    { lat: 46.8797, lng: -110.3626, radius: 700, name: 'All Montana'      },
};

// ── HTTP helpers ───────────────────────────────
function fetchUrl(url, accept) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': accept || '*/*',
      },
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8'),
        buf:  Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

function fetchJson(url) {
  return fetchUrl(url, 'application/json').then(r => JSON.parse(r.text));
}

function fetchBuffer(endpoint) {
  return new Promise((resolve, reject) => {
    const fullUrl = endpoint.startsWith('http') ? endpoint : `https://${MDT_IMG_HOST}${endpoint}`;
    https.get(fullUrl, {
      headers: { 'User-Agent': 'MTS-CLI/1.0' }
    }, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        buffer: Buffer.concat(chunks),
        type: res.headers['content-type'] || 'image/jpeg',
        status: res.statusCode,
      }));
    }).on('error', reject);
  });
}

// ── Haversine distance (meters) ────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Camera Data (MDT) ──────────────────────────
function parseRwisXml(xml) {
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
    if (lat < MT_BOUNDS.south || lat > MT_BOUNDS.north) continue;
    if (lng < MT_BOUNDS.west  || lng > MT_BOUNDS.east)  continue;
    cameras.push({ id, lat, lng, location: get('label') || `CAM-${id}` });
  }
  return cameras;
}

async function getAllCameras() {
  process.stderr.write(c('dim', 'Fetching MDT camera manifest...\n'));
  const r = await fetchUrl('https://ftp.mdt.mt.gov/travinfo/weather/rwis.xml', 'text/xml');
  if (r.status !== 200) throw new Error(`MDT XML HTTP ${r.status}`);
  const cameras = parseRwisXml(r.text);
  return cameras.map(cam => ({
    ...cam,
    roadway: '',
    imgUrl:  `https://${MDT_ATMS_HOST}/atms/public/camera/lastFiveImages/${cam.id}`,
  }));
}

function filterByArea(cameras, opts) {
  let out = [...cameras];

  // By lat/lng radius
  if (opts.lat !== undefined && opts.lng !== undefined) {
    const r = (opts.radius || 20) * 1609.34;
    out = out.filter(c => haversine(opts.lat, opts.lng, c.lat, c.lng) <= r);
  }

  // By route
  if (opts.route) {
    const q = opts.route.toLowerCase();
    out = out.filter(c =>
      c.roadway.toLowerCase().includes(q) ||
      c.location.toLowerCase().includes(q)
    );
  }

  // By area name
  if (opts.area) {
    const key = opts.area.toLowerCase().replace(/[\s-]/g, '');
    const region = REGIONS[key];
    if (region) {
      if (region.lat !== undefined) {
        const r = (region.radius || 20) * 1609.34;
        out = out.filter(c => haversine(region.lat, region.lng, c.lat, c.lng) <= r);
      }
      if (region.route) {
        const q = region.route.toLowerCase();
        out = out.filter(c =>
          c.roadway.toLowerCase().includes(q) ||
          c.location.toLowerCase().includes(q)
        );
      }
    } else {
      // Free-text match
      const q = opts.area.toLowerCase();
      out = out.filter(c => c.location.toLowerCase().includes(q));
    }
  }

  // By search
  if (opts.search) {
    const q = opts.search.toLowerCase();
    out = out.filter(c =>
      c.location.toLowerCase().includes(q) ||
      c.roadway.toLowerCase().includes(q)
    );
  }

  return out;
}

// ── Print helpers ──────────────────────────────
function printCameraTable(cameras, opts = {}) {
  const limit = opts.limit || 20;
  const show  = cameras.slice(0, limit);

  console.log(c('cyan', '┌─────────────────────────────────────────────────────────────┐'));
  console.log(c('cyan', '│') + c('bold', '  MONITOR THE SITUATION — MDT CAMERA RESULTS') + c('cyan', '                  │'));
  console.log(c('cyan', '├──────────┬──────────────────────────────┬──────────┬─────────┤'));
  console.log(
    c('cyan', '│') + c('gray', '  CAM ID  ') +
    c('cyan', '│') + c('gray', '  LOCATION                    ') +
    c('cyan', '│') + c('gray', '  ROAD    ') +
    c('cyan', '│') + c('gray', '  COORDS ') +
    c('cyan', '│')
  );
  console.log(c('cyan', '├──────────┼──────────────────────────────┼──────────┼─────────┤'));

  show.forEach((cam, i) => {
    const id   = String(cam.id).padEnd(8);
    const loc  = (cam.location || '').slice(0, 28).padEnd(28);
    const road = (cam.roadway  || '').slice(0, 8).padEnd(8);
    const lat  = cam.lat ? cam.lat.toFixed(3) : '?';
    const lng  = cam.lng ? cam.lng.toFixed(3) : '?';
    const coords = `${lat},${lng}`.slice(0, 9).padEnd(9);

    console.log(
      c('cyan', '│') + c('green',  `  ${id}`) +
      c('cyan', '│') + c('white',  `  ${loc}`) +
      c('cyan', '│') + c('yellow', `  ${road}`) +
      c('cyan', '│') + c('dim',    `  ${coords}`) +
      c('cyan', '│')
    );
  });

  console.log(c('cyan', '└──────────┴──────────────────────────────┴──────────┴─────────┘'));
  console.log(c('dim', `  Showing ${show.length} of ${cameras.length} cameras`));
  if (cameras.length > limit) {
    console.log(c('dim', `  Use --limit ${cameras.length} to see all`));
  }
  console.log('');
  console.log(c('dim', '  Image URLs:'));
  show.slice(0, 5).forEach(cam => {
    console.log(c('dim', '    ') + c('cyan', `${cam.imgUrl}`));
  });
}

function printCameraJson(cameras, opts = {}) {
  const limit = opts.limit || cameras.length;
  console.log(JSON.stringify(cameras.slice(0, limit), null, 2));
}

// ── Commands ───────────────────────────────────

async function cmdCameras(args) {
  const opts  = parseArgs(args);
  const all   = await getAllCameras();
  let cameras = filterByArea(all, opts);

  if (opts.json) {
    printCameraJson(cameras, opts);
  } else {
    printCameraTable(cameras, opts);
  }
}

async function cmdWeather(args) {
  // Weather context via visual inspection of camera feeds
  const opts  = parseArgs(args);
  const all   = await getAllCameras();
  let cameras = filterByArea(all, opts);

  if (!cameras.length) {
    console.log(c('yellow', 'No cameras found for this area.'));
    return;
  }

  console.log(c('cyan', '\n[MTS] WEBCAM WEATHER REPORT'));
  console.log(c('dim', `Area: ${opts.area || 'all Montana'} | Cameras found: ${cameras.length}`));
  console.log(c('dim', '─'.repeat(60)));
  console.log('');
  console.log(c('yellow', 'Camera feeds for visual weather assessment:'));
  console.log('');

  const show = cameras.slice(0, 10);
  show.forEach((cam, i) => {
    console.log(
      c('green',  `  [${String(i+1).padStart(2)}]`) + ' ' +
      c('white',  (cam.location || `CAM-${cam.id}`).padEnd(40)) +
      c('cyan',   cam.imgUrl)
    );
  });

  if (!opts.json) {
    console.log('');
    console.log(c('dim', '  Open these URLs in a browser for live visual conditions.'));
    console.log(c('dim', '  Run with --open to launch in browser.'));
  }

  if (opts.open) {
    const urls = show.map(c => c.imgUrl);
    try {
      execSync(`open "${show[0].imgUrl}"`); // macOS
    } catch (_) {
      try { execSync(`xdg-open "${show[0].imgUrl}"`); } catch (_) {}
    }
  }

  if (opts.json) {
    console.log(JSON.stringify({ cameras: show.map(c => ({
      id: c.id, location: c.location, roadway: c.roadway,
      lat: c.lat, lng: c.lng, imgUrl: c.imgUrl,
    }))}, null, 2));
  }
}

async function cmdShow(args) {
  const [cameraId, ...rest] = args;
  const opts = parseArgs(rest);

  if (!cameraId) {
    console.error(c('red', 'Usage: mts show <camera-id>'));
    process.exit(1);
  }

  // Resolve the latest image URL from MDT ATMS API
  let imgUrl;
  try {
    const apiUrl = `https://${MDT_ATMS_HOST}/atms/public/camera/lastFiveImages/${cameraId}`;
    const json   = await fetchJson(apiUrl);
    const imgs   = json.data && json.data.lastFivePolledImages;
    if (imgs && imgs.length) {
      imgUrl = imgs[0].publicSharePath;
    } else {
      throw new Error('No images returned');
    }
  } catch (e) {
    console.error(c('red', `Could not get image for camera ${cameraId}: ${e.message}`));
    process.exit(1);
  }

  console.log(c('cyan', `[MTS] Camera ${cameraId}`));
  console.log(c('dim', `Feed: ${imgUrl}`));

  if (opts.save) {
    const outPath = opts.save === true ? `cam-${cameraId}.jpg` : opts.save;
    process.stderr.write(c('dim', `Saving image to ${outPath}...\n`));
    const { buf: buffer, status } = await fetchUrl(imgUrl);
    if (status === 200) {
      fs.writeFileSync(outPath, buffer);
      console.log(c('green', `  Saved: ${outPath} (${buffer.length} bytes)`));
    } else {
      console.error(c('red', `  HTTP ${status}: Feed unavailable`));
    }
  } else {
    if (opts.open || !opts.json) {
      try {
        execSync(`open "${imgUrl}"`);
      } catch (_) {
        try { execSync(`xdg-open "${imgUrl}"`); } catch (_) {}
      }
      console.log(c('green', `  Opened in browser.`));
    }
    if (opts.json) {
      console.log(JSON.stringify({ id: cameraId, imgUrl }, null, 2));
    }
  }
}

// ── MDT manifest cache (for serve mode) ────────
let _mdtCamerasCache   = null;
let _mdtCamerasFetched = 0;
const MDT_CACHE_TTL = 10 * 60 * 1000;

async function serveMdtCameras(res) {
  const now = Date.now();
  if (!_mdtCamerasCache || (now - _mdtCamerasFetched) > MDT_CACHE_TTL) {
    process.stderr.write('[MTS] Fetching MDT RWIS XML...\n');
    try {
      const r = await fetchUrl('https://ftp.mdt.mt.gov/travinfo/weather/rwis.xml', 'text/xml');
      const cameras = parseRwisXml(r.text);
      _mdtCamerasCache = JSON.stringify(cameras);
      _mdtCamerasFetched = now;
      process.stderr.write(`[MTS] ${cameras.length} Montana cameras loaded\n`);
    } catch (e) {
      if (!_mdtCamerasCache) {
        res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
    }
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'max-age=300',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(_mdtCamerasCache);
}

// MDT image URL cache (short TTL — image URLs are time-stamped)
const _imgUrlCache = {}; // positionId → { url, at }
const IMG_CACHE_TTL = 30 * 1000;

async function serveMdtImage(positionId, res) {
  const cached = _imgUrlCache[positionId];
  if (cached && (Date.now() - cached.at) < IMG_CACHE_TTL) {
    res.writeHead(302, { 'Location': cached.url, 'Cache-Control': 'max-age=30', 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  try {
    const apiUrl = `https://${MDT_ATMS_HOST}/atms/public/camera/lastFiveImages/${positionId}`;
    const json   = await fetchJson(apiUrl);
    const imgs   = json.data && json.data.lastFivePolledImages;
    if (!imgs || !imgs.length) throw new Error('No images');
    const url = imgs[0].publicSharePath;
    _imgUrlCache[positionId] = { url, at: Date.now() };
    res.writeHead(302, { 'Location': url, 'Cache-Control': 'max-age=30', 'Access-Control-Allow-Origin': '*' });
    res.end();
  } catch (e) {
    if (cached) {
      res.writeHead(302, { 'Location': cached.url, 'Cache-Control': 'max-age=10', 'Access-Control-Allow-Origin': '*' });
    } else {
      // Transparent 1x1 GIF fallback
      const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end(GIF);
    }
  }
}

// ── Proxy/Serve Mode ───────────────────────────
// Serves the web app + proxies MDT API to solve CORS
function cmdServe(args) {
  const opts = parseArgs(args);
  const PORT = opts.port ? parseInt(opts.port) : 8080;
  const WEB_DIR = path.join(__dirname, '..');

  const server = http.createServer((req, res) => {
    const parsed   = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = parsed.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // MDT camera manifest
    if (pathname === '/api/mdt') {
      serveMdtCameras(res);
      return;
    }

    // MDT image redirect
    if (pathname === '/api/mdt-image') {
      const positionId = parsed.searchParams.get('id');
      if (!positionId || !/^\d+$/.test(positionId)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid id' }));
        return;
      }
      serveMdtImage(positionId, res);
      return;
    }

    // Serve static files
    let filePath = pathname === '/' ? '/index.html' : pathname;
    const fullPath = path.join(WEB_DIR, filePath);

    fs.readFile(fullPath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(fullPath);
      const types = {
        '.html': 'text/html',
        '.css':  'text/css',
        '.js':   'application/javascript',
        '.png':  'image/png',
        '.jpg':  'image/jpeg',
        '.svg':  'image/svg+xml',
        '.json': 'application/json',
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(data);
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log(c('cyan', '┌─────────────────────────────────────────────┐'));
    console.log(c('cyan', '│') + c('bold', '  MONITOR THE SITUATION — SERVER ONLINE') + c('cyan', '       │'));
    console.log(c('cyan', '├─────────────────────────────────────────────┤'));
    console.log(c('cyan', '│') + c('green', `  http://localhost:${PORT}`) + ' '.repeat(27 - String(PORT).length) + c('cyan', '│'));
    console.log(c('cyan', '│') + c('dim',   '  MDT proxy: /api/mdt  /api/mdt-image') + '        ' + c('cyan', '│'));
    console.log(c('cyan', '│') + c('dim',   '  Press Ctrl+C to stop') + '                       ' + c('cyan', '│'));
    console.log(c('cyan', '└─────────────────────────────────────────────┘'));
    console.log('');

    if (!process.env.NO_OPEN) {
      try { execSync(`open http://localhost:${PORT}`); }
      catch (_) {
        try { execSync(`xdg-open http://localhost:${PORT}`); } catch (_) {}
      }
    }
  });
}

// ── openclaw Agent Integration ─────────────────
// When invoked as an openclaw tool, parse the NL query
async function cmdAgent(args) {
  const query = args.join(' ').toLowerCase();

  // Route to appropriate command
  const opts = {};

  // Detect route mentions first (takes priority over area)
  const routeMatch = query.match(/\b(i-?\d+|sr-?\d+|us-?\d+|hwy\s?\d+)\b/i);
  if (routeMatch) {
    opts.route = routeMatch[0];
  } else {
    // Detect area mentions only if no route
    for (const [key, region] of Object.entries(REGIONS)) {
      if (query.includes(key) || query.includes(region.name.toLowerCase())) {
        opts.area = key;
        break;
      }
    }
  }

  // Detect weather intent
  const isWeather = /weather|condition|snow|fog|visibility|road\s?condition|icy|wet/i.test(query);

  // Detect specific camera
  const camMatch = query.match(/camera\s*#?(\d+)/i);
  if (camMatch) {
    await cmdShow([camMatch[1], '--json']);
    return;
  }

  if (isWeather) {
    await cmdWeather(['--json', ...Object.entries(opts).map(([k, v]) => `--${k}=${v}`)]);
  } else {
    await cmdCameras(['--json', ...Object.entries(opts).map(([k, v]) => `--${k}=${v}`)]);
  }
}

// ── Arg Parser ─────────────────────────────────
function parseArgs(args) {
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [key, ...val] = a.slice(2).split('=');
      if (val.length) {
        opts[key] = val.join('=');
      } else if (args[i+1] && !args[i+1].startsWith('--')) {
        opts[key] = args[++i];
      } else {
        opts[key] = true;
      }
    }
  }
  return opts;
}

// ── Help ───────────────────────────────────────
function printHelp() {
  console.log(`
${c('cyan', '[MTS]')} ${c('bold', 'MDT Traffic Camera CLI — Montana')}

${c('dim', 'COMMANDS')}

  ${c('green', 'cameras')}  ${c('dim', '[options]')}
    List traffic cameras. Filter by area, route, or coordinates.

  ${c('green', 'weather')}  ${c('dim', '[options]')}
    Show webcam feeds for visual weather assessment.

  ${c('green', 'show')}  ${c('yellow', '<camera-id>')}  ${c('dim', '[options]')}
    Show a specific camera. --save <file> to save image.

  ${c('green', 'serve')}  ${c('dim', '[--port 8080]')}
    Launch web UI with MDT CORS proxy at http://localhost:8080

  ${c('green', 'ask')}  ${c('yellow', '"<natural language query>"')}
    Agent mode: parse a natural language request.

${c('dim', 'OPTIONS')}

  ${c('yellow', '--area')}       Area name: missoula, helena, butte, kalispell, billings,
                bozeman, greatfalls, havre, lewistown, milescity,
                glendive, wolfpoint, livingston, i90, i15, i94, montana
  ${c('yellow', '--route')}      Road/highway: I-90, I-15, I-94, US-2, US-93, etc.
  ${c('yellow', '--lat')}        Latitude (decimal)
  ${c('yellow', '--lng')}        Longitude (decimal)
  ${c('yellow', '--radius')}     Search radius in miles (default: 20)
  ${c('yellow', '--search')}     Free-text location search
  ${c('yellow', '--limit')}      Max cameras to show (default: 20)
  ${c('yellow', '--json')}       Output as JSON (for agent/script use)
  ${c('yellow', '--open')}       Open images in browser
  ${c('yellow', '--save')} FILE  Save camera image to file

${c('dim', 'EXAMPLES')}

  mts cameras --area missoula
  mts cameras --area billings --route I-90 --limit 10
  mts weather --area bozeman
  mts cameras --lat 46.87 --lng -113.99 --radius 15
  mts show 150000 --open
  mts ask "show me cameras on I-90 near Missoula"
  mts serve --port 8080

${c('dim', 'OPENCLAW AGENT USE')}

  When invoked by an openclaw agent, use the 'ask' command with
  the user's natural language query. The CLI will parse it and
  return structured JSON output.

  Example tool call from agent:
    mts ask "what does road conditions look like on I-90 right now"
`);
}

// ── Main ───────────────────────────────────────
async function main() {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case 'cameras': await cmdCameras(args); break;
    case 'weather': await cmdWeather(args); break;
    case 'show':    await cmdShow(args);    break;
    case 'serve':   cmdServe(args);         break;
    case 'ask':     await cmdAgent(args);   break;
    case 'help':
    case '--help':
    case '-h':
    default:
      printHelp();
  }
}

main().catch(err => {
  console.error(c('red', `[ERROR] ${err.message}`));
  process.exit(1);
});
