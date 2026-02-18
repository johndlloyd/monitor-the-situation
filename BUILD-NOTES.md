# BUILD NOTES — Monitor the Situation (MTS)

> Reference document for future development. Covers architecture decisions, build log, bugs and fixes, API quirks, Vercel deployment lessons, and agent instructions.

---

## 1. Project Overview

**Monitor the Situation (MTS)** is a real-time UDOT traffic camera monitoring dashboard for the state of Utah. The name is a deliberately bureaucratic callback — it's a situation room for road conditions.

### What it does

- Fetches ~2,000+ traffic camera positions from UDOT's internal API
- Renders them on an interactive Leaflet map (Utah + surrounding region)
- Displays the camera feeds in a configurable N×N grid (default 5×5)
- Auto-refreshes feeds on a configurable timer (30s, 60s, 2m, 5m)
- Modal pop-out for any camera with keyboard nav, swipe nav, and fullscreen support
- Two-panel layout: map/filter sidebar on the left, camera grid on the right
- Mobile: collapses to a single-view toggle (MAP view vs FEEDS view)
- CLI tool for terminal/agent use: query cameras by area, route, or coordinates

### Stack

| Layer | Choice |
|---|---|
| Frontend | Vanilla HTML/CSS/JS — no framework, no build step |
| Map | Leaflet 1.9.4 via unpkg CDN |
| Map tiles | CartoDB Positron (inverted with CSS for dark mode) |
| Backend/proxy | Vercel serverless functions (Node.js) |
| Deployment | Vercel (hobby tier) |
| CLI | Plain Node.js, no dependencies |

### Deployment target

Vercel. The proxy function (`api/udot.js`) runs as a serverless function. Static files (`index.html`, `app.js`, `style.css`) are served as static assets. No build step is needed.

---

## 2. Architecture Decisions

### Why vanilla JS (no framework, no build)

- **Speed of iteration**: writing to a file and refreshing the browser is faster than any hot-reload setup when you're debugging API behavior
- **Zero dependencies**: no `node_modules`, no bundler config, no version conflicts — the repo is 8 files
- **Vercel static serving**: Vercel serves plain files without any configuration; a React/Vite project would require a build command and output directory config
- **No transpilation risk**: what you write is what runs, which matters when debugging obscure mobile browser behavior

The tradeoff is no module system in the browser, so all state lives in a single `state` object and all functions are module-level. This was fine for this project's scope.

### Why Leaflet

- Lightest full-featured mapping library available via CDN (no API key, no billing)
- `L.divIcon` lets you use raw SVG for custom camera markers with drop-shadow filter effects
- `map.fitBounds()` makes viewport-to-grid synchronization trivial
- `map.invalidateSize()` is needed after any layout change (resizer, mobile toggle) — easy to add

**Tile layer choice**: CartoDB Positron (`light_all`) was chosen because it's crisp black-on-white labels, and the entire map is inverted with CSS `filter: invert(1) hue-rotate(180deg)` to produce the dark command-center look. This avoids needing a dark tile layer with an API key.

### How the proxy works

UDOT's API has no public CORS headers. Direct browser fetches fail immediately. The proxy pattern:

```
Browser fetch → /api/proxy/map/mapIcons/Cameras
  ↓ (vercel.json rewrite)
Vercel function: api/udot.js?p=/map/mapIcons/Cameras
  ↓ (server-side https.request)
https://www.udottraffic.utah.gov/map/mapIcons/Cameras
  ↓ (response)
api/udot.js adds CORS headers, returns JSON or image bytes
  ↓
Browser
```

**The rewrite rule in `vercel.json`:**

```json
{
  "rewrites": [
    {
      "source": "/api/proxy/:path*",
      "destination": "/api/udot?p=/:path*"
    }
  ]
}
```

The path is passed as a query parameter (`p=`) rather than a path segment because Vercel serverless functions don't receive catch-all path parameters in a straightforward way — using a query string is simpler and more reliable.

**Local dev proxy**: `cli/mts-cli.js serve` runs an `http.createServer` that proxies `/api/proxy/*` to UDOT and serves static files from the project root. This mirrors the Vercel structure exactly, so the same `PROXY_PFX = '/api/proxy'` constant works in both environments.

---

## 3. Feature Build Log

### Phase 1: API Discovery

The project began by reverse-engineering the UDOT traffic website. Key findings from that exploration:

- `/api/v2/get/cameras` — requires an API key (`{"Message":"Invalid Key"}`)
- `/api/cameras` — returns 404 from ibi511.com backend
- `/Camera/GetUserCameras?listId=0` — works, returns named camera data per user-defined list
- `/map/mapIcons/Cameras` — the primary endpoint; returns all ~2,000 camera positions globally with coordinates. No auth required. **This is the key endpoint.**
- `/map/Cctv/{cameraId}` — returns a JPEG snapshot for a given camera ID. Updates every ~30 seconds.
- Camera JS bundle (`/bundles/myCctv`) revealed `/Camera/GetUserCameras` and `/Camera/SaveMyCameras` as the only authenticated camera management endpoints.
- Camera image URL pattern: `https://www.udottraffic.utah.gov/map/Cctv/{itemId}`

### Phase 2: Core Web App

- Created `monitor-the-situation/` directory at `/Users/scottwessman/projects/`
- Built `index.html` with the two-panel layout: sidebar (map) + main (camera grid)
- Set up CSS custom properties for the dark "situation room" aesthetic:
  - Background: near-black (`#0a0a0b`)
  - Accent: electric orange (`#ff6b35`) and dim green (`#39d353`)
  - Font: `JetBrains Mono` via Google Fonts CDN
  - Map tile inversion via CSS filter
- Initialized Leaflet map centered on Temple Square, SLC (the geographic centroid of Utah's camera density)
- Built `loadCameras()` to fetch `mapIcons/Cameras` via proxy, parse `item2` array, and render grid
- Built the initial N×N grid renderer with `grid-template-columns: repeat(N, 1fr)` auto-layout
- Added camera image refresh with cache-busting query parameter `?_t={timestamp}`

### Phase 3: Map Integration

- Added SVG crosshair markers as `L.divIcon` (11×11px normal, 22×22px highlighted)
- Highlight state: hovering a grid cell lights up the corresponding map marker and vice versa
- Viewport filter: on `moveend`/`zoomend`, filter cameras to those within `map.getBounds()`
- `programmaticMove` flag to suppress `moveend` events fired by our own `map.setView()` calls (prevents infinite filter loops)
- `fitToGrid()` called after initial load and region changes to snap the map viewport to the visible cameras
- Circle filter via `L.circle` — draws a radius overlay and filters cameras within it via haversine distance

### Phase 4: Modal

- Click any grid cell or map marker → full-screen overlay with the camera feed enlarged
- Modal metadata: camera name, ID, roadway, coordinates, timestamp of last refresh
- Keyboard navigation: `←`/`→` to prev/next, `Esc` to close, `r` to refresh
- Spinner shown while the image loads
- "Go to Map" button: closes modal and calls `map.setView()` to center on the camera

### Phase 5: Sidebar Resizer

- Drag handle at the bottom-right corner of the map panel
- Drag horizontally: adjusts sidebar width (160px–640px)
- Drag vertically: adjusts map container height (80px–75vh)
- `map.invalidateSize()` called on drag move and drag end to prevent Leaflet tile gaps

### Phase 6: Quick Region Buttons

- 50+ named region buttons covering all major Utah cities and metro areas
- Each button is `data-lat`, `data-lng`, `data-zoom` — calls `map.setView()` on click
- On mobile, clicking a region button auto-switches to FEEDS view

### Phase 7: Camera Name Enrichment

- `/map/mapIcons/Cameras` returns `item2[].title` fields that are almost always empty strings
- Secondary fetch to `/Camera/GetUserCameras?listId=0` provides named data (location, roadway)
- `enrichCameraNames()` is called non-blocking after initial render — updates labels in the already-rendered grid if names arrive
- `api/camnames.js` serverless function tries listIds 0–19 in parallel plus alternate endpoints, merges results into a name map, and caches it for 5 minutes
- Name cache is an object `{ cameraId: { location, roadway } }` — both the Vercel function and CLI use the same shape

### Phase 8: CLI Tool

- `cli/mts-cli.js` — single-file Node.js CLI, no dependencies beyond stdlib
- Commands: `cameras`, `weather`, `show`, `serve`, `ask`
- Filters: `--area`, `--route`, `--lat/--lng/--radius`, `--search`, `--limit`, `--json`
- `serve` command starts a local HTTP server that proxies UDOT and serves the static web app
- `ask` command: natural language parsing for openclaw agent integration — detects routes (regex), area names (dictionary lookup), weather intent (keyword regex)
- `weather` command: lists camera image URLs for visual weather assessment
- ANSI color output using escape codes (no chalk dependency)
- Table output with Unicode box-drawing characters

### Phase 9: Mobile Layout

- Below 600px: sidebar and grid-panel stack but only one is visible at a time
- `setMobileView('map')` / `setMobileView('feeds')` toggle CSS classes `mobile-hidden` / `mobile-visible`
- Initial mobile state: MAP view visible, button reads "FEEDS"
- After pressing a region button: auto-switches to FEEDS view
- Grid defaults to 2×2 on mobile (vs 5×5 on desktop)
- Map toggle button in header, always visible

### Phase 10: Touch Gestures + Fullscreen

- Swipe detection on modal image: touchstart/touchend with thresholds
  - `dt < 400ms` (quick gesture)
  - `|dx| > 50px` (meaningful horizontal travel)
  - `|dx| > |dy| * 1.5` (primarily horizontal, not a scroll attempt)
- Left swipe → next camera, right swipe → previous camera
- Brief "swipe to navigate" hint shown for 2.1 seconds on first open (touch devices only)
- Fullscreen: `overlay.requestFullscreen()` with webkit prefix fallback
- CSS fallback (`.fs-active` class): sets modal overlay to `position: fixed; inset: 0; z-index: 9999` for browsers that block the Fullscreen API
- Orientation lock: `screen.orientation.lock('landscape')` attempted on fullscreen, silently ignored if browser refuses

### Phase 11: Vercel Deployment

- Added `vercel.json` with the proxy rewrite and function timeout (30s)
- `api/udot.js`: module-level cache survives warm Lambda invocations (10-min fresh TTL, 60-min stale)
- `api/camnames.js`: separate function for camera name aggregation, 5-min TTL
- Presence counter (`api/presence.js`) built but disabled by default (commented out in `app.js` and `index.html`) — requires a persistent store for multi-instance correctness

---

## 4. Problems Encountered and Fixes

### CORS on UDOT API

**Problem**: Direct browser requests to `www.udottraffic.utah.gov` fail with CORS errors on every endpoint. The API has no public CORS headers.

**Fix**: Server-side proxy. All fetches go through `/api/proxy/*` which the Vercel function fetches server-to-server. Added `Access-Control-Allow-Origin: *` to all proxy responses.

**Key detail**: The proxy must send a realistic browser `User-Agent` and `Referer` header, or UDOT's WAF may block the request (see WAF section below).

---

### UDOT WAF (Web Application Firewall) Returning HTML Instead of JSON

**Problem**: Periodically, instead of JSON, the UDOT API returns an HTML page — a WAF challenge or bot-detection response. This causes `JSON.parse()` to throw and the app to show an error.

**Symptoms**:
- Response body starts with `<!DOCTYPE` or `<html`
- HTTP status is still 200
- Happens intermittently, more likely with non-browser User-Agents

**Fix (in `api/udot.js`)**:
```javascript
const text = buf.toString('utf8').trimStart();
if (text.startsWith('{') || text.startsWith('[')) {
  // Valid JSON — cache and serve
} else {
  // WAF response — serve stale cache if available
  console.error('[udot] Non-JSON from UDOT:', text.slice(0, 120));
  if (hit && Date.now() - hit.at < CACHE_STALE) {
    // Return cached data with STALE header
  }
}
```

The proxy uses a realistic browser header set including `Referer`, `Origin`, `sec-fetch-*` headers.

**Fix (in `app.js`)**:
```javascript
const r1 = await fetch(...);
const text = await r1.text();
let iconData;
try { iconData = JSON.parse(text); }
catch (_) { throw new Error('UDOT returned non-JSON: ' + text.slice(0, 60)); }
```

Parse as text first, then JSON, so the error message is useful rather than a generic parse failure.

---

### `item2` Array Sometimes Empty

**Problem**: The `/map/mapIcons/Cameras` endpoint occasionally returns valid JSON with an empty `item2` array. This is not a permanent failure — it's a transient UDOT backend issue.

**Response shape when working**:
```json
{
  "item1": "...",
  "item2": [
    { "itemId": 55982, "location": [40.7608, -111.8910], "title": "" },
    ...
  ]
}
```

**Response shape when failing**:
```json
{ "item1": "...", "item2": [] }
```

**Fix**: Up to 3 retry attempts with exponential backoff:
```javascript
if (!iconItems.length && attempt < MAX) {
  await new Promise(r => setTimeout(r, 1500 * attempt));
  return loadCameras(attempt + 1);
}
```

---

### `title` Field Always Empty

**Problem**: `item2[].title` in the mapIcons response is almost always an empty string. This means all cameras show as `CAM-{id}` without human-readable names.

**Workaround**: Secondary fetch to `/Camera/GetUserCameras?listId=0` which returns named camera data. This is non-blocking — the grid renders with ID-only names first, then updates labels when names arrive.

```javascript
enrichCameraNames(cameras).catch(() => {});
```

The name enrichment is fire-and-forget. If it fails, the app still works with numeric IDs.

---

### Vercel Proxy Rewrite: Path Parameter vs Query String

**Problem (attempted first)**: Using Vercel's path rewrite to pass the target path as a path segment:
```json
{ "source": "/api/proxy/:path*", "destination": "/api/udot/:path*" }
```
The serverless function cannot easily reconstruct the full path from `req.params` in this form.

**Fix**: Pass the target path as a query parameter:
```json
{ "source": "/api/proxy/:path*", "destination": "/api/udot?p=/:path*" }
```
The function reads `req.query.p` and uses it as the UDOT request path. Simple and reliable.

---

### Vercel Function Timeout

**Problem**: The camera name aggregation function (`api/camnames.js`) fires 20+ parallel HTTP requests to UDOT (listIds 0–19 plus alternates). Default Vercel function timeout is 10 seconds which is sometimes not enough.

**Fix**: Set timeout to 30 seconds in `vercel.json`:
```json
{
  "functions": {
    "api/*.js": { "maxDuration": 30 }
  }
}
```

---

### Module-Level Cache in Vercel Functions

**Problem**: Each serverless function invocation is a fresh process — module-level variables don't persist.

**Reality**: Vercel (and Lambda in general) reuses warm function instances for some period. Module-level variables **do** survive across warm invocations. This is intentionally exploited for caching:

```javascript
// Module-level cache — survives warm invocations
const cache = {};
const CACHE_TTL = 10 * 60 * 1000;
```

This is documented behavior, but it means the cache is per-instance. Under high load with multiple instances, each instance has its own cache. This is acceptable for this use case.

---

### Map `moveend` Infinite Loop

**Problem**: When the app calls `map.setView()` or `map.fitBounds()`, Leaflet fires a `moveend` event. The `moveend` handler calls `applyFilters()` which can call `fitToGrid()` which calls `map.fitBounds()` again — infinite loop.

**Fix**: `programmaticMove` flag. Set it to `true` before any programmatic map move; the `moveend` handler checks it and returns early, then clears the flag.

```javascript
state.programmaticMove = true;
state.map.fitBounds(bounds, { padding: [20, 20] });
// ...
function onMapChange() {
  if (state.programmaticMove) {
    state.programmaticMove = false;
    return;
  }
  // ...
}
```

Also suppress the initial `moveend` on map creation:
```javascript
state.programmaticMove = true; // suppress initial moveend
const map = L.map('map', { ... });
```

---

### Mobile: Map Tiles Go Blank After Layout Change

**Problem**: Switching between MAP and FEEDS view on mobile (toggling CSS display/visibility) causes Leaflet to lose track of its container size. Tiles stop loading; the map renders partially or blank.

**Fix**: Call `map.invalidateSize()` after any layout change, with a small delay to let CSS transitions complete:
```javascript
if (state.map) setTimeout(() => state.map.invalidateSize(), 50);
```

This is needed after:
- Toggling mobile MAP/FEEDS view
- Drag-resizing the map panel
- Any CSS transition that changes the map container dimensions

---

### Image Cache Busting

**Problem**: Camera JPEG images are served with aggressive caching headers. The browser caches the first image and never fetches a fresh one, even on explicit refresh.

**Fix**: Append a `?_t={timestamp}` parameter to all image `src` attributes:
```javascript
img.src = `${cam.imgUrl}?_t=${Date.now()}`;
```

For the auto-refresh cycle, a per-camera `refreshCache[cameraId]` timestamp is stored so only images that need refreshing get updated. The proxy returns `Cache-Control: public, max-age=30` for images.

---

### Swipe vs Scroll Conflict in Modal

**Problem**: On mobile, a vertical scroll gesture on the modal image was sometimes triggering horizontal swipe navigation.

**Fix**: Require the gesture to be primarily horizontal:
```javascript
if (dt < 400 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
  // navigate
}
```

The `1.5` ratio means the gesture must be at least 1.5× more horizontal than vertical. `passive: true` on the touchstart listener avoids blocking scroll.

---

### Demo Fallback Messaging

**Problem**: When the proxy isn't running (direct file:// or HTTP without proxy), all fetches fail with CORS errors and the user sees a broken blank grid.

**Fix**: `loadDemoFallback()` detects whether it's running locally or remotely and shows appropriate messaging:
- **Local**: "Run `node cli/mts-cli.js serve --port 8080` then open http://localhost:8080"
- **Remote**: "Failed to connect to UDOT API — service may be temporarily unavailable" with a Retry button

---

## 5. UDOT API Reference

### Confirmed Working Endpoints

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /map/mapIcons/Cameras` | None | All camera positions (the primary manifest) |
| `GET /map/Cctv/{cameraId}` | None | JPEG image (~30s old snapshot) |
| `GET /Camera/GetUserCameras?listId={n}` | Session cookie (but sometimes open) | Named camera list |

### `GET /map/mapIcons/Cameras`

The primary data source. Returns all cameras statewide.

**Response shape**:
```json
{
  "item1": "some metadata string",
  "item2": [
    {
      "itemId": 55982,
      "location": [40.7608, -111.8910],
      "title": "",
      "typeId": 1
    }
  ]
}
```

**Gotchas**:
- `item2` is the array you want — the name `item2` is a serialization artifact of the .NET backend (tuple serialization)
- `title` is almost always `""` — do not rely on it for camera names
- `location` is `[latitude, longitude]` — note lat before lng (GeoJSON convention)
- Can return valid JSON with empty `item2` transiently — retry with backoff
- No pagination — all cameras returned in one response (~100–200KB JSON)
- Can return HTML WAF page instead of JSON — detect with `text.startsWith('{')` check

### `GET /map/Cctv/{cameraId}`

Returns a JPEG image of the current camera view.

**Gotchas**:
- Images update approximately every 30 seconds server-side
- Some cameras return a placeholder or error image (not HTTP 404) — detect via `img.onerror`
- Some camera IDs exist in the manifest but have no active feed
- The proxy sets `Cache-Control: public, max-age=30` — browser may cache for 30 seconds

### `GET /Camera/GetUserCameras?listId={n}`

Returns a named list of cameras. Works with session cookie or sometimes without.

**Response shape**:
```json
{
  "data": [
    {
      "id": 55982,
      "location": "I-15 NB @ 600 S",
      "roadway": "I-15",
      "images": [...]
    }
  ],
  "myCameras": [...]
}
```

**Gotchas**:
- `listId=0` seems to return a global/default list
- Lists 0–19 exist; beyond that returns empty
- The `data` array contains the cameras with names — `myCameras` is user-specific saved lists
- Response varies — sometimes it's an array directly, sometimes wrapped in `{ data: [...] }` — handle both

### Endpoints That Don't Work

| Endpoint | Result |
|---|---|
| `GET /api/v2/get/cameras` | `{"Message":"Invalid Key"}` — requires API key |
| `GET /api/cameras` | 404 |
| `GET /api/v1/cameras` | 404 |
| `GET /Camera/GetAllCameras` | 404 or auth required |
| `GET /map/mapData/Cameras` | 404 |

### WAF Behavior

UDOT's infrastructure (CloudFront + backend) includes WAF rules. Key observations:

- Requests with no `User-Agent` or `curl`-default UA are more likely to be blocked
- The site uses a Maze analytics snippet and Google Analytics — the WAF may use JS challenge detection
- Server-side proxy with a Chrome-mimicking `User-Agent` and proper `Referer`/`Origin` headers reliably gets through
- The WAF sometimes returns HTTP 200 with an HTML body (challenge page) rather than a proper 4xx — always check response body content type

**Required headers for reliable access**:
```javascript
{
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ...',
  'Accept': 'application/json, */*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'identity',
  'Referer': 'https://www.udottraffic.utah.gov/map',
  'Origin': 'https://www.udottraffic.utah.gov',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  'Cache-Control': 'no-cache',
}
```

---

## 6. Vercel Deployment Lessons

### Proxy Pattern That Works

```json
{
  "rewrites": [
    {
      "source": "/api/proxy/:path*",
      "destination": "/api/udot?p=/:path*"
    }
  ]
}
```

The `/:path*` in the destination becomes the literal value of the `p` query parameter. In `api/udot.js`:
```javascript
const targetPath = req.query.p || '/';
```

### Proxy Pattern That Doesn't Work (Avoid)

Trying to use path segments in the function route:
```json
{ "destination": "/api/udot/:path*" }
```
Vercel doesn't expose path params in `req.query` this way — you'd need to parse `req.url` manually, which is fragile.

### Static File Serving

Vercel automatically serves everything in the project root that isn't in `api/` as static files. No special configuration needed. `index.html`, `app.js`, `style.css`, `favicon.svg` are all served automatically.

### Function Timeout

Default is 10 seconds (Hobby plan). Set to 30 seconds for functions that make parallel external requests:
```json
{
  "functions": {
    "api/*.js": { "maxDuration": 30 }
  }
}
```

### Module-Level Caching Strategy

Works on Vercel because warm instances persist:
- Module-level `cache` object with `{ path: { buf, at } }` structure
- Fresh TTL: 10 minutes — serve immediately without hitting UDOT
- Stale TTL: 60 minutes — serve stale on UDOT failure (WAF block or network error)
- Separate TTL for JSON manifests vs image bytes (images are not cached — they change every 30s)

### Cache Headers

- JSON responses: `public, s-maxage=300, stale-while-revalidate=600`
- Image responses: `public, max-age=30`
- Stale fallback: `public, s-maxage=60`
- Add `X-Cache: HIT | MISS | STALE` for debuggability

### Image Proxy

Images are proxied directly (no in-memory caching) because:
- They change every ~30 seconds
- They're typically 20–80KB each — caching 2000+ would exhaust function memory
- The browser handles its own 30-second image cache via the response header

```javascript
const isImage = /\/Cctv\//i.test(targetPath);
if (isImage) {
  // proxy directly, no cache
}
```

---

## 7. Mobile Implementation Notes

### Two-View Layout Pattern

Desktop: sidebar and grid-panel are side-by-side (`display: flex` on `#main`).

Mobile (≤600px): only one panel is visible at a time. CSS:
```css
@media (max-width: 600px) {
  #sidebar    { display: block; }  /* MAP view */
  #grid-panel { display: none;  }  /* hidden by default */

  #sidebar.mobile-hidden    { display: none;  }
  #grid-panel.mobile-visible { display: flex; }
}
```

Toggle function:
```javascript
function setMobileView(view) {
  if (window.innerWidth > 600) return; // no-op on desktop
  const sidebar   = document.getElementById('sidebar');
  const gridPanel = document.getElementById('grid-panel');
  if (view === 'feeds') {
    sidebar.classList.add('mobile-hidden');
    gridPanel.classList.add('mobile-visible');
  } else {
    sidebar.classList.remove('mobile-hidden');
    gridPanel.classList.remove('mobile-visible');
    if (state.map) setTimeout(() => state.map.invalidateSize(), 50);
  }
}
```

The `setTimeout(..., 50)` on map view restore is required — the CSS display change needs one paint cycle before Leaflet can measure the container size.

### Fullscreen API + CSS Fallback

**Preferred**: Web Fullscreen API
```javascript
overlay.requestFullscreen()
  .then(lockLandscape)
  .catch(() => enableCssFs(overlay));
```

**Fallback** (Safari, some embedded browsers):
```javascript
function enableCssFs(overlay) {
  overlay.classList.add('fs-active');
  lockLandscape();
}
```

```css
.fs-active {
  position: fixed !important;
  inset: 0 !important;
  z-index: 9999 !important;
  background: #000;
}
```

Handle the `fullscreenchange` event to sync `_fsActive` state if the user exits fullscreen with the browser UI (Escape key, system gesture):
```javascript
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && _fsActive) exitFsMode();
});
document.addEventListener('webkitfullscreenchange', () => {
  if (!document.webkitFullscreenElement && _fsActive) exitFsMode();
});
```

### Swipe Gesture Thresholds

```javascript
// touchstart
_touchStartX = e.touches[0].clientX;
_touchStartY = e.touches[0].clientY;
_touchStartT = Date.now();

// touchend
const dx = e.changedTouches[0].clientX - _touchStartX;
const dy = e.changedTouches[0].clientY - _touchStartY;
const dt = Date.now() - _touchStartT;

if (dt < 400 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
  // valid horizontal swipe
}
```

- `dt < 400`: must complete in under 400ms (a deliberate swipe, not a held drag)
- `Math.abs(dx) > 50`: at least 50px of horizontal travel
- `Math.abs(dx) > Math.abs(dy) * 1.5`: must be more horizontal than vertical (prevents scroll-to-navigate conflict)
- Use `passive: true` on both event listeners — do not call `preventDefault()` on passive listeners

---

## 8. Future Agent Instructions

### Start Here: API Discovery

Don't guess API paths. The UDOT site is a .NET MVC application. The real endpoints are revealed in the JavaScript bundles on the page:

```bash
# Get the bundle list from the page source
curl -s "https://www.udottraffic.utah.gov/" | grep -o 'src="/bundles/[^"]*"'

# Extract camera-related endpoints from a bundle
curl -s "https://www.udottraffic.utah.gov/bundles/myCctv?v=..." | grep -o '/Camera/[^"]*'
```

The two endpoints that work without auth:
- `GET /map/mapIcons/Cameras` — the manifest (all cameras + positions)
- `GET /map/Cctv/{id}` — the JPEG feed for a camera

### Do This First: Build the Proxy

Do not attempt to use the UDOT API directly from the browser. CORS will block everything. Build the server-side proxy on day one.

**Vercel setup (copy exactly)**:

`vercel.json`:
```json
{
  "rewrites": [
    { "source": "/api/proxy/:path*", "destination": "/api/udot?p=/:path*" }
  ],
  "functions": { "api/*.js": { "maxDuration": 30 } }
}
```

`api/udot.js`: the proxy function must:
1. Parse `req.query.p` as the target UDOT path
2. Send a full browser-like header set (User-Agent, Referer, Origin, sec-fetch-*)
3. Check `text.startsWith('{') || text.startsWith('[')` before trying `JSON.parse`
4. Return a cached stale response if UDOT sends HTML (WAF block)
5. Handle images separately: detect `/Cctv/` in the path, proxy directly without caching

### Pitfalls to Avoid

1. **Do not parse `item2[].title` for camera names.** It is always empty. Use the separate `/Camera/GetUserCameras` endpoint.

2. **Do not cache images server-side.** Camera images are ~30–80KB and update every 30 seconds. Cache 2000 of them and you'll exhaust function memory.

3. **Do not skip the `programmaticMove` flag on the Leaflet map.** Every `setView`/`fitBounds` call fires `moveend`. Without the flag, you'll get an infinite loop of filter → fit → filter → fit.

4. **Always call `map.invalidateSize()` after any layout change.** This includes CSS transitions, panel resizes, and display toggles. Add a 50ms delay when the DOM layout is changing due to a CSS transition.

5. **Do not trust UDOT HTTP status codes for JSON detection.** The WAF returns HTTP 200 with HTML body. Always check `text.trimStart().startsWith('{')`.

6. **Handle the empty `item2` case with retries.** The manifest endpoint occasionally returns valid JSON with zero cameras. Retry up to 3 times with exponential backoff (1.5s, 3s).

7. **Do not use `loading="eager"` on camera images.** With 25+ images loading simultaneously, this will saturate the browser's connection pool. Use `loading="lazy"` and let the browser manage it.

8. **The `sec-fetch-*` headers matter.** UDOT's WAF distinguishes same-origin from cross-origin requests. Set `sec-fetch-site: same-origin` in the proxy to mimic a same-origin browser request.

9. **On mobile, account for the 50ms delay when restoring the map view.** `map.invalidateSize()` must be called *after* the CSS display change takes effect, not synchronously.

10. **Use `haversine()` for distance filtering, not bounding box only.** A bounding box is a rectangle, not a circle. If you advertise a radius filter, implement it correctly.

### Building a Similar Data Dashboard (Step-by-Step)

1. **Explore the target website** — fetch the HTML, identify JS bundle URLs, grep bundles for endpoint patterns
2. **Test endpoints from curl/Node** (not browser) — CORS won't block server-side requests
3. **Identify the minimal endpoints** — usually one manifest endpoint + one resource endpoint
4. **Build the proxy first** — Vercel rewrite + serverless function, test locally with `mts serve`
5. **Build the loading flow** — splash screen with progress bar, retry logic, error fallback messaging
6. **Render incrementally** — show data as soon as the manifest loads; enrich with secondary data in background
7. **Add the map** — Leaflet on CartoDB Positron, inverted with CSS for dark theme
8. **Add viewport filtering** — `map.getBounds()` on `moveend`/`zoomend`, suppressed for programmatic moves
9. **Build the modal** — overlay with keyboard nav, close on Escape, refresh button
10. **Add mobile layout** — two-view toggle pattern, swipe gestures, fullscreen with CSS fallback
11. **Deploy to Vercel** — `vercel deploy`, verify proxy routes work, check function logs for WAF hits

### What Makes This Architecture Work Well

- **No build step**: iterate by editing files and refreshing the browser
- **Proxy doubles as local dev server**: `mts serve` replicates Vercel routing locally — no environment differences
- **Stale-while-revalidate on the proxy**: users always get fast responses; UDOT WAF blocks degrade gracefully
- **Fire-and-forget enrichment**: the grid is never blocked waiting for camera names — they update in the background
- **CSS filter inversion for dark tiles**: no dark tile API key needed; CartoDB Positron + `filter: invert(1) hue-rotate(180deg)` is visually indistinguishable from a native dark tile layer
