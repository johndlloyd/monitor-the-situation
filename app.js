/* ═══════════════════════════════════════════════
   MONITOR THE SITUATION — app.js
   UDOT Traffic Camera Monitor
   ═══════════════════════════════════════════════ */

// Always route through the server-side proxy (resolves CORS on UDOT API)
const PROXY_PFX = '/api/proxy';
const IMG_BASE  = `${PROXY_PFX}/map/Cctv`;

// Default home: Temple Square, SLC
const HOME = { lat: 40.7705, lng: -111.8910, zoom: 14, count: 25 };

// ── State ──────────────────────────────────────
const state = {
  cameras:      [],   // all cameras from UDOT
  filtered:     [],   // after filters applied
  map:          null,
  markers:      [],
  circle:       null,
  circleCenter: null,
  circleRadius:  10,  // miles
  useDefault:       true,  // show 25 closest to Temple Square until user navigates
  programmaticMove: false, // suppress moveend during setView calls we initiated
  fitAfterFilter:   false, // fit map bounds to grid results on next renderGrid call
  gridSize:         5,     // N in the current N×N display
  refreshTimer:  null,
  refreshRate:   60000,
  cols:          5,
  modalIdx:     -1,
  modalCam:     null,
  refreshCache: {},   // cameraId → timestamp
};

// ── Init ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);

async function init() {
  startClock();
  initMap();
  bindControls();
  await loadCameras();
  startRefreshCycle();
  startPresence();
}

// ── Clock ──────────────────────────────────────
function startClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    const d = new Date();
    el.textContent = d.toLocaleTimeString('en-US', {
      hour12: false, timeZone: 'America/Denver',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
  };
  tick();
  setInterval(tick, 1000);
}

// ── Map ────────────────────────────────────────
function initMap() {
  const map = L.map('map', {
    center: [HOME.lat, HOME.lng],
    zoom: HOME.zoom,
    zoomControl: true,
    attributionControl: false,
  });
  state.programmaticMove = true; // suppress the initial moveend on load

  // CartoDB Positron — pixel-crisp black labels on white.
  // CSS invert() flips it: pure white roads/labels on dark background.
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
  }).addTo(map);

  state.map = map;

  map.on('moveend zoomend', onMapChange);
  map.on('click', onMapClick);
}

function onMapChange() {
  if (state.programmaticMove) {
    state.programmaticMove = false;
    return; // ignore moveend fired by our own setView calls
  }
  if (state.cameras.length) {
    state.useDefault = false;
    applyFilters();
  }
}

function onMapClick(e) {
}

function placeCircle(lat, lng) {
  const radiusMiles = state.circleRadius;
  const radiusMeters = radiusMiles * 1609.34;

  if (state.circle) state.circle.remove();

  state.circleCenter = { lat, lng };
  state.circle = L.circle([lat, lng], {
    radius: radiusMeters,
    color: '#000000',
    fillColor: '#000000',
    fillOpacity: 0.08,
    weight: 1.5,
  }).addTo(state.map);

  state.map.fitBounds(state.circle.getBounds(), { padding: [20, 20] });
  applyFilters();
}

function clearCircle() {
  if (state.circle) { state.circle.remove(); state.circle = null; }
  state.circleCenter = null;
  applyFilters();
}

// ── Load Cameras ───────────────────────────────
async function loadCameras() {
  setStatus('FETCHING CAMERA MANIFEST...', 10);

  try {
    // First fetch all map icon positions (fast, has coords + IDs)
    const r1 = await fetch(`${PROXY_PFX}/map/mapIcons/Cameras`, {
      headers: { 'Accept': 'application/json' }
    });
    const iconData = await r1.json();
    const iconItems = iconData.item2 || [];

    setStatus(`PARSING ${iconItems.length} CAMERA POSITIONS...`, 40);

    // Convert to our format (fast path — just positions)
    const cameras = iconItems.map(item => ({
      id:       item.itemId,
      lat:      item.location[0],
      lng:      item.location[1],
      location: item.title || `CAM-${item.itemId}`,
      roadway:  '',
      imgUrl:   `${IMG_BASE}/${item.itemId}`,
    }));

    // Try to enrich with named data (secondary fetch, non-blocking)
    enrichCameraNames(cameras).catch(() => {});

    setStatus(`ESTABLISHING ${cameras.length} FEEDS...`, 70);
    state.cameras = cameras;

    // Add map markers
    addMapMarkers(cameras);

    // Initial render: apply viewport filter immediately
    // (avoids loading 2000+ images at once)
    state.filtered = [...cameras];
    applyFilters();

    setStatus('CAMERA NETWORK ONLINE', 100);
    setTimeout(hideLoading, 400);

    updateStats();
  } catch (err) {
    console.error('Camera load error:', err);
    setStatus('ERROR: FALLING BACK TO DEMO MODE', 100);
    loadDemoFallback();
    setTimeout(hideLoading, 600);
  }
}

// Cache for enriched camera names
const nameCache = {};

async function enrichCameraNames(cameras) {
  try {
    // When running locally: use the aggregated /api/camnames endpoint which
    // tries multiple UDOT list IDs and alternate endpoints server-side.
    // When remote (no proxy): fall back to a single GetUserCameras call.
    const url = '/api/camnames';

    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return;
    const json = await r.json();

    // /api/camnames returns { id: {location, roadway} } already merged
    // GetUserCameras returns an array — normalise both shapes
    if (Array.isArray(json) || Array.isArray(json.data)) {
      const data = Array.isArray(json) ? json : json.data;
      data.forEach(cam => {
        const id = String(cam.id || '');
        if (id) nameCache[id] = { location: cam.location || '', roadway: cam.roadway || '' };
      });
    } else {
      // Object map from /api/camnames
      Object.entries(json).forEach(([id, info]) => {
        nameCache[id] = info;
      });
    }

    // Apply to all cameras where we have data
    cameras.forEach(cam => {
      const info = nameCache[String(cam.id)];
      if (info && info.location) {
        cam.location = info.location;
        cam.roadway  = info.roadway || cam.roadway;
      }
    });

    // Refresh visible labels and tooltips in the grid
    document.querySelectorAll('.cam-cell').forEach(el => {
      const id  = el.dataset.id;
      const cam = cameras.find(c => String(c.id) === String(id));
      if (!cam) return;
      const name = cam.location && !cam.location.startsWith('CAM-') ? cam.location : `CAM-${id}`;
      const lbl = el.querySelector('.cam-label');
      if (lbl) lbl.textContent = name;
    });
  } catch (_) {}
}

// Fetch a single camera's description from image URL header or tooltip
async function fetchCameraName(camId) {
  if (nameCache[String(camId)]) return nameCache[String(camId)];
  // The image description is embedded in HTTP headers or alt text
  // Use the camera image URL and parse any available info
  // For now return null (name stays as CAM-id)
  return null;
}

// Icons defined at module scope so highlight/unhighlight can reference them
const camIconNormal = () => L.divIcon({
  className: '',
  html: `<svg width="11" height="11" viewBox="0 0 11 11" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible">
    <line x1="5.5" y1="0" x2="5.5" y2="4"   stroke="#000000" stroke-width="1.5"/>
    <line x1="5.5" y1="7" x2="5.5" y2="11"  stroke="#000000" stroke-width="1.5"/>
    <line x1="0"   y1="5.5" x2="4"   y2="5.5" stroke="#000000" stroke-width="1.5"/>
    <line x1="7"   y1="5.5" x2="11"  y2="5.5" stroke="#000000" stroke-width="1.5"/>
    <rect x="3.5" y="3.5" width="4" height="4" fill="#000000" fill-opacity="0.8"/>
  </svg>`,
  iconSize: [11, 11], iconAnchor: [5, 5],
});

const camIconHot = () => L.divIcon({
  className: '',
  html: `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible;filter:drop-shadow(0 0 5px #ff6b35) drop-shadow(0 0 10px #ff3300)">
    <line x1="11" y1="0"  x2="11" y2="7"  stroke="#ff6b35" stroke-width="2.5"/>
    <line x1="11" y1="15" x2="11" y2="22" stroke="#ff6b35" stroke-width="2.5"/>
    <line x1="0"  y1="11" x2="7"  y2="11" stroke="#ff6b35" stroke-width="2.5"/>
    <line x1="15" y1="11" x2="22" y2="11" stroke="#ff6b35" stroke-width="2.5"/>
    <rect x="6" y="6" width="10" height="10" fill="#ff6b35"/>
    <rect x="8" y="8" width="6"  height="6"  fill="#ffaa44"/>
  </svg>`,
  iconSize: [22, 22], iconAnchor: [11, 11],
});

function highlightMarker(camId) {
  const m = state.markers.find(m => String(m.camId) === String(camId));
  if (!m) return;
  m.setIcon(camIconHot());
  m.setZIndexOffset(1000);
}

function unhighlightMarker(camId) {
  const m = state.markers.find(m => String(m.camId) === String(camId));
  if (!m) return;
  m.setIcon(camIconNormal());
  m.setZIndexOffset(0);
}

function addMapMarkers(cameras) {
  state.markers.forEach(m => m.remove());
  state.markers = [];

  cameras.forEach(cam => {
    if (!cam.lat || !cam.lng) return;
    const m = L.marker([cam.lat, cam.lng], { icon: camIconNormal() })
      .addTo(state.map)
      .on('click', () => openModal(cam))
      .on('mouseover', () => {
        highlightMarker(cam.id);
        const cell = document.querySelector(`.cam-cell[data-id="${cam.id}"]`);
        if (cell) cell.classList.add('map-hover');
      })
      .on('mouseout', () => {
        unhighlightMarker(cam.id);
        const cell = document.querySelector(`.cam-cell[data-id="${cam.id}"]`);
        if (cell) cell.classList.remove('map-hover');
      });
    m.camId = cam.id;
    state.markers.push(m);
  });
}

// ── Filter / Render ────────────────────────────

function applyFilters() {
  state.gridSize = 5; // every new filter resets to 5×5 default
  let cams = [...state.cameras];

  // Default view: 25 closest cameras to Temple Square
  if (state.useDefault && !state.circleCenter) {
    cams = [...cams].sort((a, b) =>
      haversine(HOME.lat, HOME.lng, a.lat, a.lng) -
      haversine(HOME.lat, HOME.lng, b.lat, b.lng)
    );
    state.filtered = cams;
    renderGrid(cams);
    updateStats();
    return;
  }

  // Circle filter (always applies when active)
  if (state.circleCenter && state.circle) {
    const { lat, lng } = state.circleCenter;
    const r = state.circleRadius * 1609.34; // meters
    cams = cams.filter(c => haversine(lat, lng, c.lat, c.lng) <= r);
  } else {
    // Viewport filter
    const bounds = state.map.getBounds();
    if (bounds) {
      cams = cams.filter(c =>
        c.lat >= bounds.getSouth() &&
        c.lat <= bounds.getNorth() &&
        c.lng >= bounds.getWest() &&
        c.lng <= bounds.getEast()
      );
    }
  }

  state.filtered = cams;
  renderGrid(cams);
  updateStats();
}

function syncMarkerVisibility() {
  const shown = state.filtered.slice(0, state.gridSize * state.gridSize);
  const activeIds = new Set(shown.map(c => String(c.id)));
  state.markers.forEach(m => m.setOpacity(activeIds.has(String(m.camId)) ? 1 : 0.15));
}

function fitToGrid(cams) {
  if (!cams.length || !state.map) return;
  const bounds = L.latLngBounds(cams.map(c => [c.lat, c.lng]));
  state.programmaticMove = true;
  state.map.fitBounds(bounds, { padding: [20, 20], maxZoom: 16 });
}

function renderGrid(cameras) {
  const grid  = document.getElementById('camera-grid');
  const noRes = document.getElementById('no-results');

  if (!cameras.length) {
    grid.innerHTML = '';
    noRes.style.display = 'flex';
    applyAutoLayout();
    syncMarkerVisibility();
    return;
  }
  noRes.style.display = 'none';

  const maxShow = state.gridSize * state.gridSize;
  const slice   = cameras.slice(0, maxShow);

  const frag = document.createDocumentFragment();
  slice.forEach((cam, idx) => {
    frag.appendChild(makeCamCell(cam, idx));
  });

  grid.innerHTML = '';
  grid.appendChild(frag);
  applyAutoLayout();
  updateStats();
  syncMarkerVisibility();

  // Fit map to exactly the cameras shown in the grid when in default mode,
  // or whenever a region / filter change produces a new set of results
  if (state.useDefault || state.fitAfterFilter) {
    state.fitAfterFilter = false;
    fitToGrid(slice);
  }
}

function makeCamCell(cam, idx) {
  const cell = document.createElement('div');
  cell.className = 'cam-cell';
  cell.dataset.id  = cam.id;
  cell.dataset.idx = idx;

  const cacheBreak = state.refreshCache[cam.id] || Date.now();

  const name = cam.location && !cam.location.startsWith('CAM-')
    ? cam.location
    : `CAM-${cam.id}`;

  cell.innerHTML = `
    <img class="cam-img" src="${cam.imgUrl}?_t=${cacheBreak}"
         loading="lazy"
         alt="${name}"
         draggable="false">
    <div class="cam-status"></div>
  `;

  cell.addEventListener('mouseenter', () => highlightMarker(cam.id));
  cell.addEventListener('mouseleave', () => unhighlightMarker(cam.id));

  const img = cell.querySelector('.cam-img');
  const dot = cell.querySelector('.cam-status');

  img.onerror = () => {
    cell.classList.add('error');
    dot.classList.add('err');
  };
  img.onload = () => {
    cell.classList.remove('error');
    dot.classList.remove('err');
  };

  cell.addEventListener('click', () => openModal(cam));

  return cell;
}

// ── Modal ──────────────────────────────────────
function openModal(cam) {
  state.modalCam = cam;
  state.modalIdx = state.filtered.indexOf(cam);

  const overlay = document.getElementById('modal-overlay');
  const img     = document.getElementById('modal-img');
  const title   = document.getElementById('modal-title');
  const idEl    = document.getElementById('modal-id');
  const road    = document.getElementById('modal-road');
  const coords  = document.getElementById('modal-coords');
  const ts      = document.getElementById('modal-timestamp');

  const name = cam.location && !cam.location.startsWith('CAM-')
    ? cam.location : `CAM-${cam.id}`;
  title.textContent = name;
  idEl.textContent  = `#${cam.id}`;
  road.textContent  = cam.roadway || '';
  coords.textContent = cam.lat ? `${cam.lat.toFixed(5)}, ${cam.lng.toFixed(5)}` : '';

  showModalSpinner();
  img.src = `${cam.imgUrl}?_t=${Date.now()}`;
  img.onload  = () => { hideModalSpinner(); ts.textContent = new Date().toLocaleTimeString(); };
  img.onerror = () => { hideModalSpinner(); ts.textContent = 'FEED UNAVAILABLE'; };

  overlay.style.display = 'flex';
  document.addEventListener('keydown', onModalKey);
}

window.closeModal = function() {
  document.getElementById('modal-overlay').style.display = 'none';
  document.removeEventListener('keydown', onModalKey);
  state.modalCam = null;
};

window.refreshModal = function() {
  if (!state.modalCam) return;
  const img = document.getElementById('modal-img');
  const ts  = document.getElementById('modal-timestamp');
  showModalSpinner();
  img.src = `${state.modalCam.imgUrl}?_t=${Date.now()}`;
  img.onload  = () => { hideModalSpinner(); ts.textContent = new Date().toLocaleTimeString(); };
  img.onerror = () => { hideModalSpinner(); ts.textContent = 'FEED UNAVAILABLE'; };
};

window.gotoOnMap = function() {
  const cam = state.modalCam;
  if (!cam || !cam.lat) return;
  closeModal();
  state.map.setView([cam.lat, cam.lng], 14);
};

function navModal(dir) {
  if (!state.filtered.length) return;
  let idx = (state.modalIdx + dir + state.filtered.length) % state.filtered.length;
  openModal(state.filtered[idx]);
}

function onModalKey(e) {
  if (e.key === 'Escape')      closeModal();
  if (e.key === 'ArrowRight')  navModal(1);
  if (e.key === 'ArrowLeft')   navModal(-1);
  if (e.key === 'r')           refreshModal();
}

function showModalSpinner() {
  const s = document.getElementById('modal-spinner');
  s.style.display = 'flex';
}
function hideModalSpinner() {
  document.getElementById('modal-spinner').style.display = 'none';
}

// ── Refresh Cycle ──────────────────────────────
function startRefreshCycle() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  const rate = state.refreshRate;
  if (!rate) return;
  state.refreshTimer = setInterval(refreshAllVisible, rate);
}

function refreshAllVisible() {
  const now = Date.now();
  document.querySelectorAll('.cam-cell').forEach(cell => {
    const id  = cell.dataset.id;
    const img = cell.querySelector('.cam-img');
    if (!img) return;
    state.refreshCache[id] = now;
    const cam = state.cameras.find(c => String(c.id) === String(id));
    if (cam) {
      img.src = `${cam.imgUrl}?_t=${now}`;
    }
  });
}

// ── Controls ───────────────────────────────────
function bindControls() {


  // Region buttons
  document.querySelectorAll('.btn-region').forEach(btn => {
    btn.addEventListener('click', () => {
      const lat  = parseFloat(btn.dataset.lat);
      const lng  = parseFloat(btn.dataset.lng);
      const zoom = parseInt(btn.dataset.zoom);
      state.map.setView([lat, lng], zoom);
    });
  });

  // More / Fewer cameras
  document.getElementById('btn-more').addEventListener('click', () => {
    state.gridSize = Math.min(20, state.gridSize + 1);
    renderGrid(state.filtered);
  });
  document.getElementById('btn-fewer').addEventListener('click', () => {
    state.gridSize = Math.max(1, state.gridSize - 1);
    renderGrid(state.filtered);
  });

  // Re-apply layout on panel resize (keeps cols correct, CSS handles cell size)
  new ResizeObserver(() => {
    if (state.filtered.length) applyAutoLayout();
  }).observe(document.getElementById('grid-panel'));

  // Refresh rate
  document.getElementById('refresh-rate').addEventListener('change', e => {
    state.refreshRate = parseInt(e.target.value);
    startRefreshCycle();
  });
  document.getElementById('btn-refresh-now').addEventListener('click', refreshAllVisible);

  // Modal nav
  document.getElementById('btn-modal-prev').addEventListener('click', () => navModal(-1));
  document.getElementById('btn-modal-next').addEventListener('click', () => navModal(1));

  // Keyboard global shortcuts
  document.addEventListener('keydown', e => {
    if (document.getElementById('modal-overlay').style.display !== 'none') return;
    if (e.key === 'Escape') { resetFilters(); }
    if (e.key === 'r')      { refreshAllVisible(); }
  });
}


// ── Auto Layout ────────────────────────────────
// Columns = state.gridSize (N×N square). CSS aspect-ratio handles height.
function applyAutoLayout() {
  const n    = state.gridSize;
  const grid = document.getElementById('camera-grid');
  grid.style.gridTemplateColumns = `repeat(${n}, 1fr)`;

  const total = state.filtered.length;
  const shown = Math.min(n * n, total);
  const info  = document.getElementById('grid-info');
  if (info) {
    info.textContent = total > shown
      ? `${n}×${n}  ·  ${shown} of ${total}`
      : `${n}×${n}`;
  }
}

function resetFilters() {
  if (state.circle) { state.circle.remove(); state.circle = null; }
  state.circleCenter = null;
  state.useDefault       = true;
  state.programmaticMove = true;
  state.gridSize         = 5;
  state.map.setView([HOME.lat, HOME.lng], HOME.zoom, { animate: true });
  applyFilters();
}

// ── Loading / Stats ────────────────────────────
function setStatus(msg, pct) {
  document.getElementById('loading-status').textContent = msg;
  document.getElementById('loading-bar').style.width = `${pct}%`;
}

function hideLoading() {
  const ls = document.getElementById('loading-screen');
  ls.style.opacity = '0';
  ls.style.transition = 'opacity .3s';
  setTimeout(() => ls.remove(), 300);
}

function updateStats() {
  document.getElementById('stat-total').textContent    = state.cameras.length;
  document.getElementById('stat-active').textContent   = state.filtered.length;
}

// ── Helpers ────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000; // Earth radius in meters
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Presence counter ───────────────────────────
function startPresence() {
  const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const el = document.getElementById('presence-count');

  async function heartbeat() {
    try {
      const r = await fetch('/api/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const { count } = await r.json();
      if (el) el.textContent = count;
    } catch (_) {}
  }

  heartbeat();
  setInterval(heartbeat, 30000);
}

// ── Demo fallback (if CORS blocks) ────────────
function loadDemoFallback() {
  // Show a note that this needs to be served via proxy or same-origin
  const grid = document.getElementById('camera-grid');
  const noRes = document.getElementById('no-results');
  noRes.style.display = 'none';

  const note = document.createElement('div');
  note.style.cssText = `
    grid-column: 1 / -1;
    padding: 40px;
    text-align: center;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 2;
    letter-spacing: .08em;
  `;
  note.innerHTML = `
    <div style="color:var(--accent);font-size:14px;margin-bottom:12px">// CORS RESTRICTION DETECTED</div>
    <div>UDOT API requires a proxy server for browser access.</div>
    <div>Run the CLI tool or deploy with the included proxy:</div>
    <div style="margin-top:12px;color:var(--accent2)">node cli/mts-cli.js serve --port 8080</div>
    <div style="margin-top:8px">Then open: <span style="color:var(--accent)">http://localhost:8080</span></div>
  `;
  grid.appendChild(note);
}
