/* ═══════════════════════════════════════════════
   MONITOR THE SITUATION — app.js (Montana)
   MDT RWIS Traffic Camera Monitor
   ═══════════════════════════════════════════════ */

// All camera images route through cam-snapshot, which fetches + caches
// the image buffer server-side for 12 hours and always serves the last
// known-good snapshot rather than a blank or broken feed.
const IMG_API = '/api/cam-snapshot';

// Default home: Missoula, MT (western MT hub, near Snowbowl + ski corridor)
const HOME = { lat: 46.8721, lng: -113.9940, zoom: 10 };

// ── Build STATIC_CAMERAS from the resort registry (resorts.js) ─
// Each camera gets a resortId for ski-mode filtering.
// Cameras with url: null show a "Camera link needed" placeholder.
function buildStaticCameras() {
  return (window.RESORTS || []).flatMap(resort =>
    resort.cameras.map(cam => ({
      id:       cam.id,
      lat:      resort.lat,
      lng:      resort.lng,
      location: `${resort.name} — ${cam.name}`,
      type:     'ski',
      resortId: resort.id,
      imgUrl:   cam.url ? `${IMG_API}?url=${encodeURIComponent(cam.url)}` : null,
    }))
  );
}

// ── State ──────────────────────────────────────
const state = {
  cameras:      [],   // all cameras from MDT + static ski
  filtered:     [],   // after filters applied
  map:          null,
  markers:      [],
  useDefault:       false,
  skiOnly:          true,  // show only ski resort cameras
  selectedResort:   null,  // null = all resorts; string = resort id
  programmaticMove: false, // suppress moveend during setView calls we initiated
  fitAfterFilter:   false, // fit map bounds to grid results on next renderGrid call
  gridSize:         5,     // N in the current N×N display
  refreshTimer:  null,
  refreshRate:   60000,
  cols:          5,
  modalIdx:     -1,
  modalCam:     null,
  refreshCache: {},   // cameraId → timestamp
  snowData:     null, // { resorts, lastUpdated, note } from /api/snow
  snowLoading:  false,
  camHealth:    {},   // cameraId -> true (ok) | false (err) | undefined (pending)
  cardMetaTimer: null,
};

// ── Init ───────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);

async function init() {
  initDarkMode();
  initSkiMode();
  startClock();
  initMap();
  initResizer();
  initModalTouch();
  bindControls();
  updateScopeButtons();
  updateSkiSummary();
  if (window.innerWidth <= 600) setMobileView('feeds');
  if (window.innerWidth <= 600) state.gridSize = 2;
  if (!state.cardMetaTimer) state.cardMetaTimer = setInterval(updateVisibleCellMeta, 1000);
  await loadCameras();
  startRefreshCycle();
  // If ski mode was restored from localStorage, kick off snow fetch
  if (state.skiOnly) loadSnowData();
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

// ── Ski Mode Persistence ───────────────────────
function initSkiMode() {
  const savedMode   = localStorage.getItem('mts-mode');
  const savedResort = localStorage.getItem('mts-resort');
  if (savedMode === 'ski') {
    state.skiOnly    = true;
    state.useDefault = false;
  }
  if (savedResort) state.selectedResort = savedResort;
}

function enterSkiMode() {
  state.skiOnly        = true;
  state.useDefault     = false;
  localStorage.setItem('mts-mode', 'ski');
  renderResortChips();
  showSkiUI(true);
  applyFilters();
  fitToGrid(state.cameras.filter(c => c.type === 'ski'));
  if (!state.snowData && !state.snowLoading) loadSnowData();
  if (window.innerWidth <= 600) setMobileView('feeds');
}

function exitSkiMode() {
  state.skiOnly        = false;
  state.useDefault     = true;
  state.selectedResort = null;
  localStorage.setItem('mts-mode', 'default');
  localStorage.removeItem('mts-resort');
  showSkiUI(false);
  applyFilters();
}

function showSkiUI(on) {
  const chips = document.getElementById('resort-chips');
  const snow  = document.getElementById('snow-panel');
  chips.style.display = on ? 'flex' : 'none';
  snow.style.display  = on ? 'block' : 'none';
  document.getElementById('tab-all').classList.toggle('active', !on);
  document.getElementById('tab-ski').classList.toggle('active',  on);
  // Keep sidebar SKI CAMS button in sync
  const btnSki = document.getElementById('btn-ski-cams');
  if (btnSki) btnSki.classList.toggle('btn-ski-active', on);
}

// ── Resort Chip Bar ────────────────────────────
function renderResortChips() {
  const bar     = document.getElementById('resort-chips');
  const resorts = window.RESORTS || [];
  bar.innerHTML = '';

  const makeChip = (label, resortId, count) => {
    const btn = document.createElement('button');
    btn.className   = 'chip' + (state.selectedResort === resortId ? ' chip-active' : '');
    btn.dataset.resort = resortId || '';
    btn.textContent = label;
    if (count != null) btn.title = `${count} camera${count !== 1 ? 's' : ''}`;
    btn.addEventListener('click', () => selectResort(resortId));
    return btn;
  };

  bar.appendChild(makeChip('ALL RESORTS', null, null));

  resorts.forEach(resort => {
    const shortName = resort.name
      .replace(' Mountain Resort', '').replace(' Ski & Recreation Area', '')
      .replace(' Ski Area', '').replace(' Mountain', '')
      .replace(' Powder Mountain', ' Powder');
    bar.appendChild(makeChip(shortName, resort.id, resort.cameras.length));
  });
}

function selectResort(resortId) {
  state.selectedResort = resortId || null;
  localStorage.setItem('mts-resort', resortId || '');
  renderResortChips();
  applyFilters();
}

// ── Snow Data ──────────────────────────────────
async function loadSnowData() {
  state.snowLoading = true;
  renderSnowPanel();
  try {
    const r = await fetch('/api/snow', { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state.snowData = await r.json();
  } catch (err) {
    console.warn('[MTS] Snow data unavailable:', err.message);
    state.snowData = { error: true };
  } finally {
    state.snowLoading = false;
    renderSnowPanel();
  }
}

function renderSnowPanel() {
  const panel = document.getElementById('snow-panel');
  if (!state.skiOnly) return;

  if (state.snowLoading) {
    panel.innerHTML = '<div class="snow-loading">// LOADING SNOW DATA...</div>';
    return;
  }

  if (!state.snowData || state.snowData.error) {
    panel.innerHTML = '<div class="snow-unavail">// SNOW DATA UNAVAILABLE</div>';
    return;
  }

  const { resorts: snowResorts, lastUpdated, note } = state.snowData;
  const allResorts = window.RESORTS || [];

  // Build one card per resort
  const cards = allResorts.map(resort => {
    const d = (snowResorts || []).find(r => r.id === resort.id);
    let snowLine = '—';
    if (d && d.available) {
      if (d.snowfallLast6h != null) snowLine = `${d.snowfallLast6h}" / 6h`;
      else if (d.snowDepth != null)  snowLine = `${d.snowDepth}" depth`;
    }
    const tempLine = (d && d.available && d.tempF != null) ? `${d.tempF}°F` : '';
    const station  = (d && d.available && d.stationName) ? d.stationName : '';
    const shortName = resort.name
      .replace(' Mountain Resort', '').replace(' Ski & Recreation Area', '')
      .replace(' Ski Area', '').replace(' Mountain', '').replace(' Powder Mountain', '');
    return `<div class="snow-card" title="${station ? 'Station: ' + station : ''}">
      <div class="snow-resort">${shortName}</div>
      <div class="snow-value">${snowLine}</div>
      ${tempLine ? `<div class="snow-temp">${tempLine}</div>` : ''}
    </div>`;
  }).join('');

  const updStr = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Denver'
      }) + ' MST'
    : '--';

  panel.innerHTML = `
    <div class="snow-header">
      <span class="snow-label">⛄ SNOW — NEAREST NWS STATION</span>
      <span class="snow-updated">Updated ${updStr}</span>
    </div>
    <div class="snow-cards">${cards}</div>
  `;
}

// ── Sidebar Resizer ────────────────────────────
function initResizer() {
  const sidebar      = document.getElementById('sidebar');
  const mapResizer   = document.getElementById('map-resizer');
  const mapContainer = document.getElementById('map-container');

  mapResizer.addEventListener('mousedown', e => {
    e.preventDefault();
    e.stopPropagation();
    const startX      = e.clientX;
    const startY      = e.clientY;
    const startHeight = mapContainer.offsetHeight;
    const startWidth  = sidebar.offsetWidth;

    mapResizer.classList.add('dragging');
    document.body.style.cursor     = 'nwse-resize';
    document.body.style.userSelect = 'none';

    function onMove(e) {
      const h = Math.max(80,  Math.min(window.innerHeight * 0.75, startHeight + e.clientY - startY));
      const w = Math.max(160, Math.min(640,                        startWidth  + e.clientX - startX));
      mapContainer.style.height = h + 'px';
      sidebar.style.width = w + 'px';
      sidebar.style.flex  = `0 0 ${w}px`;
      if (state.map) state.map.invalidateSize();
    }
    function onUp() {
      mapResizer.classList.remove('dragging');
      document.body.style.cursor     = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      if (state.map) state.map.invalidateSize();
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  });
}

// ── Map ────────────────────────────────────────
function initMap() {
  const map = L.map('map', {
    center: [HOME.lat, HOME.lng],
    zoom: HOME.zoom,
    zoomControl: true,
    attributionControl: false,
  });
  state.programmaticMove = true;

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
  }).addTo(map);

  state.map = map;
  map.on('moveend zoomend', onMapChange);
}

function onMapChange() {
  if (state.programmaticMove) {
    state.programmaticMove = false;
    return;
  }
  if (state.cameras.length) {
    state.useDefault = false;
    applyFilters();
  }
}

// ── Load Cameras ───────────────────────────────
async function loadCameras(attempt) {
  attempt = attempt || 1;
  const MAX = 3;

  setStatus(
    attempt === 1 ? 'FETCHING CAMERA MANIFEST...' : `RETRYING... (${attempt}/${MAX})`,
    10 * attempt
  );

  try {
    const r    = await fetch('/api/mdt', { headers: { 'Accept': 'application/json' } });
    const text = await r.text();

    let cameras;
    try { cameras = JSON.parse(text); }
    catch (_) { throw new Error('MDT API returned non-JSON: ' + text.slice(0, 60)); }

    if (cameras.error) throw new Error(cameras.error);
    if (!Array.isArray(cameras)) throw new Error('Unexpected MDT API response shape');

    if (!cameras.length && attempt < MAX) {
      await new Promise(res => setTimeout(res, 1500 * attempt));
      return loadCameras(attempt + 1);
    }

    setStatus(`PARSING ${cameras.length} CAMERA POSITIONS...`, 40);

    // Attach the image URL — routes through our mdt-image function
    cameras = cameras.map(c => ({
      ...c,
      imgUrl: `${IMG_API}?id=${encodeURIComponent(c.id)}`,
    }));

    // Merge in static ski/scenic cameras from resort registry
    const staticCams = buildStaticCameras();
    cameras = cameras.concat(staticCams);

    setStatus(`ESTABLISHING ${cameras.length} FEEDS...`, 70);
    state.cameras = cameras;
    state.camHealth = Object.fromEntries(cameras.map((c) => [String(c.id), undefined]));

    addMapMarkers(cameras);
    state.filtered = [...cameras];

    // Restore ski mode chip bar if coming back to ski mode
    if (state.skiOnly) {
      renderResortChips();
      showSkiUI(true);
    }

    applyFilters();

    setStatus('CAMERA NETWORK ONLINE', 100);
    setTimeout(hideLoading, 400);
    updateStats();

  } catch (err) {
    console.error(`[MTS] Attempt ${attempt} failed:`, err.message);
    if (attempt < MAX) {
      setStatus(`RETRYING... (${attempt + 1}/${MAX})`, 20);
      await new Promise(res => setTimeout(res, 2000 * attempt));
      return loadCameras(attempt + 1);
    }
    setStatus('ERROR: FAILED TO CONNECT TO MDT', 100);
    loadDemoFallback(err.message);
    setTimeout(hideLoading, 600);
  }
}

// Icons defined at module scope so highlight/unhighlight can reference them
const camIconNormal = () => L.divIcon({
  className: 'cam-marker',
  html: `<svg width="11" height="11" viewBox="0 0 11 11" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible">
    <line x1="5.5" y1="0" x2="5.5" y2="4"   stroke="#000000" stroke-width="1.5"/>
    <line x1="5.5" y1="7" x2="5.5" y2="11"  stroke="#000000" stroke-width="1.5"/>
    <line x1="0"   y1="5.5" x2="4"   y2="5.5" stroke="#000000" stroke-width="1.5"/>
    <line x1="7"   y1="5.5" x2="11"  y2="5.5" stroke="#000000" stroke-width="1.5"/>
    <rect x="3.5" y="3.5" width="4" height="4" fill="#000000" fill-opacity="0.8"/>
  </svg>`,
  iconSize: [11, 11], iconAnchor: [5, 5],
});

// Ski resort marker — blue/white snowflake crosshair
const skiIconNormal = () => L.divIcon({
  className: 'cam-marker',
  html: `<svg width="11" height="11" viewBox="0 0 11 11" xmlns="http://www.w3.org/2000/svg" style="display:block;overflow:visible">
    <line x1="5.5" y1="0" x2="5.5" y2="4"   stroke="#4fc3f7" stroke-width="1.5"/>
    <line x1="5.5" y1="7" x2="5.5" y2="11"  stroke="#4fc3f7" stroke-width="1.5"/>
    <line x1="0"   y1="5.5" x2="4"   y2="5.5" stroke="#4fc3f7" stroke-width="1.5"/>
    <line x1="7"   y1="5.5" x2="11"  y2="5.5" stroke="#4fc3f7" stroke-width="1.5"/>
    <rect x="3.5" y="3.5" width="4" height="4" fill="#4fc3f7" fill-opacity="0.9"/>
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
  m.setIcon(m.isSki ? skiIconNormal() : camIconNormal());
  m.setZIndexOffset(0);
}

function addMapMarkers(cameras) {
  state.markers.forEach(m => m.remove());
  state.markers = [];

  cameras.forEach(cam => {
    if (!cam.lat || !cam.lng) return;
    const isSki = cam.type === 'ski';
    const m = L.marker([cam.lat, cam.lng], { icon: isSki ? skiIconNormal() : camIconNormal() })
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
    m.isSki = isSki;
    state.markers.push(m);
  });
}

// ── Filter / Render ────────────────────────────

function applyFilters() {
  const all = [...state.cameras];
  let cams = [];
  if (state.skiOnly) {
    let ski = all.filter(c => c.type === 'ski');
    if (state.selectedResort) {
      ski = ski.filter(c => c.resortId === state.selectedResort);
    }
    cams = ski;
    renderSnowPanel();
  } else {
    const bounds = state.map.getBounds();
    cams = bounds
      ? all.filter(c =>
          c.lat >= bounds.getSouth() &&
          c.lat <= bounds.getNorth() &&
          c.lng >= bounds.getWest() &&
          c.lng <= bounds.getEast()
        )
      : all;
  }

  state.filtered = cams;
  updateScopeButtons();
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

  state.markers.forEach(m => {
    m.setIcon(m.isSki ? skiIconNormal() : camIconNormal());
    m.setZIndexOffset(0);
  });

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

  if (state.fitAfterFilter) {
    state.fitAfterFilter = false;
    fitToGrid(slice);
  } else if (state.skiOnly) {
    fitToGrid(slice);
  }
}

function makeCamCell(cam, idx) {
  const cell = document.createElement('div');
  cell.className = 'cam-cell';
  if (cam.type === 'ski') cell.classList.add('ski-cam');
  cell.dataset.id  = cam.id;
  cell.dataset.idx = idx;
  const camId = String(cam.id);
  if (!state.refreshCache[camId]) state.refreshCache[camId] = Date.now();
  const name = cam.location && !cam.location.startsWith('CAM-')
    ? cam.location
    : `CAM-${cam.id}`;
  const roadLabel = cam.type === 'ski'
    ? getResortName(cam)
    : (cam.roadway || 'MDT RWIS');

  // Cameras with no URL — show "Camera link needed" placeholder
  if (!cam.imgUrl) {
    cell.classList.add('no-feed');
    cell.title = name;
    cell.innerHTML = `
      <div class="no-feed-label">${name}</div>
      <div class="cam-status err"></div>
    `;
    return cell;
  }

  cell.innerHTML = `
    <img class="cam-img" src="${cam.imgUrl}"
         loading="lazy"
         alt="${esc(name)}"
         draggable="false">
    <div class="cam-overlay-top">
      <div class="cam-title">${esc(name)}</div>
      <div class="cam-tags">
        <span class="cam-tag ${cam.type === 'ski' ? 'ski' : 'traffic'}">${cam.type === 'ski' ? 'SKI' : 'TRAFFIC'}</span>
        <span class="cam-tag route">${esc(roadLabel)}</span>
      </div>
    </div>
    <div class="cam-overlay-bottom">
      <span class="cam-feed-state pending">CHECKING</span>
      <span class="cam-freshness">updated now</span>
    </div>
    <div class="cam-status"></div>
  `;

  cell.addEventListener('mouseenter', () => highlightMarker(cam.id));
  cell.addEventListener('mouseleave', () => unhighlightMarker(cam.id));

  const img = cell.querySelector('.cam-img');
  const dot = cell.querySelector('.cam-status');
  const feedState = cell.querySelector('.cam-feed-state');
  const freshness = cell.querySelector('.cam-freshness');

  if (freshness) freshness.textContent = `updated ${formatAge(Date.now() - state.refreshCache[camId])}`;
  applyCamHealthUi(cell, dot, feedState, state.camHealth[camId]);

  img.onerror = () => {
    cell.classList.add('error');
    state.camHealth[camId] = false;
    applyCamHealthUi(cell, dot, feedState, false);
    updateSkiSummary();
  };
  img.onload = () => {
    cell.classList.remove('error');
    state.refreshCache[camId] = Date.now();
    state.camHealth[camId] = true;
    applyCamHealthUi(cell, dot, feedState, true);
    if (freshness) freshness.textContent = 'updated now';
    updateSkiSummary();
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

  if (!cam.imgUrl) {
    img.src = '';
    hideModalSpinner();
    ts.textContent = 'CAMERA LINK NEEDED';
    overlay.style.display = 'flex';
    document.addEventListener('keydown', onModalKey);
    return;
  }

  showModalSpinner();
  img.src = cam.imgUrl;
  img.onload  = () => { hideModalSpinner(); ts.textContent = new Date().toLocaleTimeString(); };
  img.onerror = () => { hideModalSpinner(); ts.textContent = 'FEED UNAVAILABLE'; };

  overlay.style.display = 'flex';
  document.addEventListener('keydown', onModalKey);

  if ('ontouchstart' in window) {
    const wrap = document.getElementById('modal-img-wrap');
    const old  = wrap.querySelector('.swipe-hint');
    if (old) old.remove();
    const hint = document.createElement('div');
    hint.className = 'swipe-hint';
    hint.textContent = '◀  swipe to navigate  ▶';
    wrap.appendChild(hint);
    setTimeout(() => hint.remove(), 2100);
  }
}

window.closeModal = function() {
  if (_fsActive) exitFsMode();
  document.getElementById('modal-overlay').style.display = 'none';
  document.removeEventListener('keydown', onModalKey);
  state.modalCam = null;
};

window.refreshModal = function() {
  if (!state.modalCam) return;
  const cam = state.modalCam;
  if (!cam.imgUrl) return;
  const img = document.getElementById('modal-img');
  const ts  = document.getElementById('modal-timestamp');
  showModalSpinner();
  img.src = cam.imgUrl;
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

function showModalSpinner() { document.getElementById('modal-spinner').style.display = 'flex'; }
function hideModalSpinner() { document.getElementById('modal-spinner').style.display = 'none'; }

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
    const dot = cell.querySelector('.cam-status');
    const feedState = cell.querySelector('.cam-feed-state');
    if (!img) return;
    state.refreshCache[id] = now;
    state.camHealth[String(id)] = undefined;
    applyCamHealthUi(cell, dot, feedState, undefined);
    const cam = state.cameras.find(c => String(c.id) === String(id));
    if (cam && cam.imgUrl) {
      img.src = cam.imgUrl;
    }
  });
  updateVisibleCellMeta();
  updateSkiSummary();
}

// ── Controls ───────────────────────────────────
function bindControls() {
  const mapToggleBtn = document.getElementById('btn-map-toggle');
  if (mapToggleBtn) {
    if (window.innerWidth <= 600) {
      mapToggleBtn.textContent = '← MAP';
      mapToggleBtn.title = 'View map and quick regions';
    }
    mapToggleBtn.addEventListener('click', () => setMobileView(
      document.getElementById('grid-panel').classList.contains('mobile-hidden') ? 'feeds' : 'map'
    ));
  }

  // Mode tabs — ALL | SKI MODE
  document.getElementById('tab-all').addEventListener('click', () => {
    if (!state.skiOnly) return;
    exitSkiMode();
  });
  document.getElementById('tab-ski').addEventListener('click', () => {
    if (state.skiOnly) return;
    enterSkiMode();
  });

  const skiScopeBtn = document.getElementById('btn-scope-ski');
  const allScopeBtn = document.getElementById('btn-scope-all');
  if (skiScopeBtn) {
    skiScopeBtn.addEventListener('click', () => {
      enterSkiMode();
      if (window.innerWidth <= 600) setMobileView('feeds');
    });
  }
  if (allScopeBtn) {
    allScopeBtn.addEventListener('click', () => {
      exitSkiMode();
      if (window.innerWidth <= 600) setMobileView('feeds');
    });
  }
  document.getElementById('btn-ski-cams').addEventListener('click', () => {
    if (state.skiOnly) {
      exitSkiMode();
    } else {
      enterSkiMode();
    }
  });

  // Region buttons — clear ski-only mode before panning
  document.querySelectorAll('.btn-region').forEach(btn => {
    if (btn.id === 'btn-ski-cams') return;
    btn.addEventListener('click', () => {
      state.skiOnly    = false;
      state.useDefault = false;
      showSkiUI(false);
      const lat  = parseFloat(btn.dataset.lat);
      const lng  = parseFloat(btn.dataset.lng);
      const zoom = parseInt(btn.dataset.zoom);
      state.map.setView([lat, lng], zoom);
      if (window.innerWidth <= 600) setMobileView('feeds');
    });
  });

  document.getElementById('btn-more').addEventListener('click', () => {
    state.gridSize = Math.min(20, state.gridSize + 1);
    renderGrid(state.filtered);
  });
  document.getElementById('btn-fewer').addEventListener('click', () => {
    state.gridSize = Math.max(1, state.gridSize - 1);
    renderGrid(state.filtered);
  });

  document.getElementById('btn-view-all').addEventListener('click', () => {
    const total = state.filtered.length;
    if (!total) return;
    state.gridSize = Math.min(20, Math.ceil(Math.sqrt(total)));
    renderGrid(state.filtered);
  });

  new ResizeObserver(() => {
    if (state.filtered.length) applyAutoLayout();
  }).observe(document.getElementById('grid-panel'));

  document.getElementById('refresh-rate').addEventListener('change', e => {
    state.refreshRate = parseInt(e.target.value);
    startRefreshCycle();
  });
  document.getElementById('btn-refresh-now').addEventListener('click', refreshAllVisible);

  document.getElementById('btn-modal-prev').addEventListener('click', () => navModal(-1));
  document.getElementById('btn-modal-next').addEventListener('click', () => navModal(1));
  document.getElementById('btn-fullscreen').addEventListener('click', toggleFullscreen);
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && _fsActive) exitFsMode();
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (!document.webkitFullscreenElement && _fsActive) exitFsMode();
  });

  document.addEventListener('keydown', e => {
    if (document.getElementById('modal-overlay').style.display !== 'none') return;
    if (e.key === 'Escape') { resetFilters(); }
    if (e.key === 'r')      { refreshAllVisible(); }
  });
}

// ── Auto Layout ────────────────────────────────
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
  state.useDefault       = false;
  state.skiOnly          = true;
  state.selectedResort   = null;
  state.programmaticMove = true;
  state.gridSize         = 5;
  localStorage.setItem('mts-mode', 'ski');
  localStorage.setItem('mts-resort', '');
  showSkiUI(true);
  renderResortChips();
  state.map.setView([HOME.lat, HOME.lng], HOME.zoom, { animate: true });
  applyFilters();
  fitToGrid(state.filtered);
  if (window.innerWidth <= 600) setMobileView('feeds');
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
  document.getElementById('stat-total').textContent  = state.cameras.length;
  document.getElementById('stat-active').textContent = state.filtered.length;
}

function applyCamHealthUi(cell, dot, feedStateEl, health) {
  if (!dot || !feedStateEl) return;
  dot.classList.toggle('err', health === false);
  dot.classList.toggle('pending', health === undefined);

  feedStateEl.classList.remove('ok', 'bad', 'pending');
  if (health === true) {
    feedStateEl.classList.add('ok');
    feedStateEl.textContent = 'LIVE';
    cell.classList.remove('is-pending');
  } else if (health === false) {
    feedStateEl.classList.add('bad');
    feedStateEl.textContent = 'OFFLINE';
    cell.classList.remove('is-pending');
  } else {
    feedStateEl.classList.add('pending');
    feedStateEl.textContent = 'CHECKING';
    cell.classList.add('is-pending');
  }
}

function updateVisibleCellMeta() {
  const now = Date.now();
  document.querySelectorAll('.cam-cell').forEach((cell) => {
    const id = cell.dataset.id;
    const freshness = cell.querySelector('.cam-freshness');
    if (!freshness) return;
    const ts = state.refreshCache[id];
    freshness.textContent = ts ? `updated ${formatAge(now - ts)}` : 'updating...';
  });
}

function updateScopeButtons() {
  const skiBtn = document.getElementById('btn-scope-ski');
  const allBtn = document.getElementById('btn-scope-all');
  if (!skiBtn || !allBtn) return;
  skiBtn.classList.toggle('active', state.skiOnly);
  allBtn.classList.toggle('active', !state.skiOnly);
}

function getResortName(cam) {
  if (!cam || cam.type !== 'ski') return 'Unknown';
  const raw = (cam.location || 'Unknown').split('—')[0].trim();
  return raw || 'Unknown';
}

function updateSkiSummary() {
  const totalEl = document.getElementById('ski-total');
  const onlineEl = document.getElementById('ski-online');
  const offlineEl = document.getElementById('ski-offline');
  const updatedEl = document.getElementById('ski-summary-updated');
  const resortListEl = document.getElementById('ski-resort-list');
  if (!totalEl || !onlineEl || !offlineEl || !updatedEl || !resortListEl) return;

  const skiCams = state.cameras.filter((c) => c.type === 'ski');
  const total = skiCams.length;
  let online = 0;
  let offline = 0;
  let unknown = 0;
  const resortCounts = new Map();

  skiCams.forEach((cam) => {
    const key = String(cam.id);
    const health = state.camHealth[key];
    if (health === true) online += 1;
    else if (health === false) offline += 1;
    else unknown += 1;

    const resort = getResortName(cam);
    const curr = resortCounts.get(resort) || { total: 0, online: 0, offline: 0 };
    curr.total += 1;
    if (health === true) curr.online += 1;
    if (health === false) curr.offline += 1;
    resortCounts.set(resort, curr);
  });

  totalEl.textContent = String(total);
  onlineEl.textContent = String(online);
  offlineEl.textContent = String(offline);

  const t = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'America/Denver',
  });
  updatedEl.textContent = unknown ? `UPDATED ${t} · ${unknown} CHECKING` : `UPDATED ${t}`;

  const sorted = [...resortCounts.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]));
  resortListEl.innerHTML = sorted
    .map(([name, stat]) => {
      return `<span class="ski-resort-pill"><strong>${name}</strong> ${stat.online}/${stat.total} online</span>`;
    })
    .join('');
}

// ── Helpers ────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = lat1 * Math.PI / 180;
  const φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(Δφ/2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatAge(ms) {
  if (ms < 2000) return 'now';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Dark mode ──────────────────────────────────
function initDarkMode() {
  if (localStorage.getItem('mts-dark') === '1') applyDark(true);
  document.getElementById('btn-dark-toggle')
    .addEventListener('click', () => applyDark(!document.body.classList.contains('dark')));
}

function applyDark(on) {
  document.body.classList.toggle('dark', on);
  localStorage.setItem('mts-dark', on ? '1' : '0');
  if (state.map) state.map.invalidateSize();
}

// ── Mobile two-view layout ─────────────────────
function setMobileView(view) {
  if (window.innerWidth > 600) return;
  const sidebar   = document.getElementById('sidebar');
  const gridPanel = document.getElementById('grid-panel');
  const btn       = document.getElementById('btn-map-toggle');

  if (view === 'map') {
    sidebar.classList.add('mobile-visible');
    gridPanel.classList.add('mobile-hidden');
    if (btn) { btn.textContent = '⊞ FEEDS'; btn.classList.add('active'); }
    if (state.map) setTimeout(() => state.map.invalidateSize(), 50);
  } else {
    sidebar.classList.remove('mobile-visible');
    gridPanel.classList.remove('mobile-hidden');
    if (btn) { btn.textContent = '← MAP'; btn.classList.remove('active'); }
  }
}

// ── Modal touch: swipe + fullscreen ───────────
let _touchStartX = 0;
let _touchStartY = 0;
let _touchStartT = 0;
let _fsActive    = false;

function initModalTouch() {
  const wrap = document.getElementById('modal-img-wrap');

  wrap.addEventListener('touchstart', e => {
    _touchStartX = e.touches[0].clientX;
    _touchStartY = e.touches[0].clientY;
    _touchStartT = Date.now();
  }, { passive: true });

  wrap.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - _touchStartX;
    const dy = e.changedTouches[0].clientY - _touchStartY;
    const dt = Date.now() - _touchStartT;
    if (dt < 400 && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) navModal(1);
      else        navModal(-1);
    }
  }, { passive: true });
}

function toggleFullscreen() { _fsActive ? exitFsMode() : enterFsMode(); }

function enterFsMode() {
  const overlay = document.getElementById('modal-overlay');
  const req = overlay.requestFullscreen
            || overlay.webkitRequestFullscreen
            || overlay.mozRequestFullScreen;

  if (req) {
    req.call(overlay).then(lockLandscape).catch(() => enableCssFs(overlay));
  } else {
    enableCssFs(overlay);
  }
  _fsActive = true;
  document.getElementById('btn-fullscreen').classList.add('active');
}

function enableCssFs(overlay) {
  overlay.classList.add('fs-active');
  lockLandscape();
}

function exitFsMode() {
  const overlay = document.getElementById('modal-overlay');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
  }
  overlay.classList.remove('fs-active');
  unlockOrientation();
  _fsActive = false;
  const btn = document.getElementById('btn-fullscreen');
  if (btn) btn.classList.remove('active');
}

function lockLandscape() {
  try {
    if (screen.orientation && typeof screen.orientation.lock === 'function') {
      screen.orientation.lock('landscape').catch(function() {});
    }
  } catch (_) {}
}

function unlockOrientation() {
  try {
    if (screen.orientation && typeof screen.orientation.unlock === 'function') {
      screen.orientation.unlock();
    }
  } catch (_) {}
}

// ── Demo fallback ──────────────────────────────
function loadDemoFallback(errMsg) {
  const grid  = document.getElementById('camera-grid');
  const noRes = document.getElementById('no-results');
  noRes.style.display = 'none';

  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';

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

  if (isLocal) {
    note.innerHTML = `
      <div style="color:var(--accent);font-size:14px;margin-bottom:12px">// PROXY SERVER REQUIRED</div>
      <div>Run the CLI tool to start the local proxy:</div>
      <div style="margin-top:12px;color:var(--accent2)">node cli/mts-cli.js serve --port 8080</div>
      <div style="margin-top:8px">Then open: <span style="color:var(--accent)">http://localhost:8080</span></div>
    `;
  } else {
    note.innerHTML = `
      <div style="color:var(--accent);font-size:14px;margin-bottom:12px">// FAILED TO CONNECT TO MDT API</div>
      <div>Could not load camera data. The service may be temporarily unavailable.</div>
      <div style="margin-top:12px">
        <button onclick="location.reload()" style="
          background:transparent;border:1px solid var(--border);color:var(--text-dim);
          font-family:var(--font-mono);font-size:10px;padding:6px 16px;
          border-radius:2px;cursor:pointer;letter-spacing:.08em;">
          ↺ RETRY
        </button>
      </div>
      ${errMsg ? `<div style="margin-top:12px;color:var(--text-meta);font-size:9px">${errMsg}</div>` : ''}
    `;
  }

  grid.appendChild(note);
}
