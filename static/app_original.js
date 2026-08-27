const APP_BASE = (() => {
  const path = window.location.pathname.replace(/\/index\.html$/, "");
  const staticIndex = path.indexOf("/static");
  if (staticIndex >= 0) return path.slice(0, staticIndex).replace(/\/$/, "");
  return path.replace(/\/$/, "");
})();

const API_BASE = (window.FLOOD_ROUTING_API_BASE || `${APP_BASE}/api`).replace(/\/$/, "");
const apiUrl = (path) => `${API_BASE}/${path.replace(/^\/+/, "")}`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_COLORS = {
  drowned:  '#d73027',
  close_to: '#fc8d59',
  at_risk:  '#fee090',
  safe:     '#1a9850'
};

const PASSABILITY_COLORS = {
  passable:      '#1a9850',
  passable_slow: '#fc8d59',
  impassable:    '#d73027'
};

const DEPTH_COLORS = {
  0.25: '#c6dbef',  // 0–0.5 m   — azul muy claro
  0.75: '#6baed6',  // 0.5–1.0 m — azul claro
  1.5:  '#2171b5',  // 1.0–2.0 m — azul medio
  3.0:  '#f16913',  // 2.0–4.0 m — naranja
  5.0:  '#d73027'   // >4.0 m    — rojo
};

const SLOT_COLORS = {
  drowned:  { border: '#d73027', bg: '#fff5f5' },
  close_to: { border: '#fc8d59', bg: '#fff8f5' },
  at_risk:  { border: '#e8c419', bg: '#fffbea' },
  safe:     { border: '#1a9850', bg: '#f0faf4' },
  default:  { border: '#e0e0e0', bg: '#f9f9f9' }
};

const DIRECTION_ICONS = {
  turn_right: '↱',
  turn_left:  '↰',
  arriving:   '📍',
  arrive:     '📍'
};

const HEADING_ARROWS = {
  'north':     '↑',
  'northeast': '↗',
  'east':      '→',
  'southeast': '↘',
  'south':     '↓',
  'southwest': '↙',
  'west':      '←',
  'northwest': '↖'
};

// Vehicle profile metadata — display-only. fordingDepth values are sourced
// externally (fire department chassis specs), not from any backend constant
// (app.py has no EMERGENCY_THRESHOLDS_M or equivalent — confirmed absent).
// color/dash/lineCap reused from the validated design reference, mapped
// onto the real API enum keys (_VEHICLE_PROFILES in app.py).
const VEHICLE_PROFILES = {
  emergencia_chasis_calle: { label: 'Street chassis', fordingDepth: '0.40 m', color: '#CC79A7', dash: null,     lineCap: 'butt'  },
  emergencia_hlf_4x4:      { label: 'HLF 4x4',         fordingDepth: '0.80 m', color: '#6A1B9A', dash: '10 7',  lineCap: 'butt'  },
  emergencia_unimog:       { label: 'Unimog',           fordingDepth: '1.00 m', color: '#0B525B', dash: '2 6',   lineCap: 'round' }
};
const VEHICLE_ORDER = ['emergencia_chasis_calle', 'emergencia_hlf_4x4', 'emergencia_unimog'];

// Pedestrian mode has no selectedVehicle a user consciously picked (the
// selector is hidden in that mode), so this reuses the flagship "Chasis
// de calle" hue rather than tying the pedestrian route's color to
// whatever vehicle was last selected.
// Pedestrian and vehicle mode are mutually exclusive on screen (the mode
// chooser modal forces one or the other), so this is a safe reuse, not a
// collision.
const PEDESTRIAN_ROUTE_COLOR = VEHICLE_PROFILES.emergencia_chasis_calle.color;

// ---------------------------------------------------------------------------
// Color math for the "Route detail" compare-mode intensity variation —
// each vehicle keeps its own hue at all times; only lightness/saturation
// shift with depth. No color
// library is loaded (index_original.html has none that does color math),
// so this is ~40 lines of standard hex<->HSL conversion instead of a new
// frontend dependency.
// ---------------------------------------------------------------------------

function hexToHsl(hex) {
  hex = hex.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) {
    h = s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

function hslToHex(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  const toHex = c => Math.round(c * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

// Bucket boundaries mirror the existing depth-color conventions already used
// elsewhere in this file (the raster pixelValuesToColorFn steps at
// 0.1/0.3/0.5/1.0/2.0 m — DEPTH_COLORS uses a different scale, 0.5/1/2/4 m,
// so it is NOT the same convention, despite an earlier comment here having
// claimed both matched).
//
// Each bucket is a "darken factor" in [0,1]: 0 = render at the exact
// verified, colorblind-tested base color (dry/near-dry — the majority of
// any route); 1 = maximum darkening for that color's own lightness
// headroom. Per spec §3.2, water only ever makes a vehicle's line darker/
// more saturated — never lighter than its verified base hex — so this
// never interpolates upward. A fixed absolute-lightness delta (the
// previous design) pushed every color toward the same absolute lightness
// regardless of where it started: a low-lightness color like Unimog
// (#0B525B, L≈20%) crushed to near-black at moderate depth, while a
// high-lightness color like Chasis (#CC79A7, L≈64%) washed out to
// near-white on dry segments, becoming nearly invisible against a white
// halo/light basemap. Scaling the darkening to each color's own headroom
// (relative to its own lightness, not a shared absolute floor) avoids both
// failure modes.
// This scale must never be extended past the most permissive vehicle's
// fording/blocking threshold (currently 1.00 m, Unimog) — the colorblindness
// safety of tintByDepth()'s output was verified with a real CVD simulation
// (colorspacious, Machado-Oliveira-Fairchild model) specifically within
// that range, not against greater depths.
// A segment deeper than a given vehicle's own threshold has cost_dist_<profile>
// = INF in the graph and is excluded from that vehicle's routing outright, so
// depth_m on any feature reaching tintByDepth() (compare-mode overlay only —
// the single-route overlay uses PASSABILITY_COLORS, not this function) can
// never exceed ~1.00 m in practice. The one exception ("Show route anyway",
// which can surface a blocked/deeper segment) never reaches this function —
// confirmed structurally: computeCompareRoutes() only ever populates
// lastCompareResults with found:true entries, and updateRouteDetailOverlay()'s
// compare-mode branch re-checks .found before calling tintByDepth() on any
// entry's features.
const DEPTH_TINT_BUCKETS = [
  { max: 0.10, factor: 0    },
  { max: 0.30, factor: 0.15 },
  { max: 0.50, factor: 0.35 },
  { max: 1.00, factor: 0.55 },
  { max: 2.00, factor: 0.8  },
  { max: Infinity, factor: 1 },
];

function tintByDepth(baseHex, depthM) {
  const [h, s, l] = hexToHsl(baseHex);
  const bucket = DEPTH_TINT_BUCKETS.find(b => depthM < b.max);
  // Floor is a proportion of the base's own lightness (never darker than
  // 35% of it, and never below an absolute 10) — this is why Unimog
  // (starts at L≈20%) and Chasis (starts at L≈64%) darken by comparable
  // *proportions* of their own headroom instead of both racing toward the
  // same absolute floor.
  const lFloor = Math.max(10, l * 0.35);
  const newL = l - bucket.factor * (l - lFloor);
  const newS = Math.min(100, s + bucket.factor * (100 - s) * 0.5);
  return hslToHex(h, newS, newL);
}

// ---------------------------------------------------------------------------
// Map initialisation
// ---------------------------------------------------------------------------

const map = L.map('map', { zoomControl: false }).setView([52.5, 13.4], 10);

L.control.zoom({ position: 'topright' }).addTo(map);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}' + (L.Browser.retina ? '@2x.png' : '.png'), {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 20
}).addTo(map);

map.on('click', async function(e) {
  if (!document.getElementById('toggle-depth').checked) return;
  if (!activeGeoRaster) return;

  // Reproyectar WGS84 → EPSG:25832 antes de identificar
  const wgs84 = 'EPSG:4326';
  const utm32 = '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';
  const [x, y] = proj4(wgs84, utm32, [e.latlng.lng, e.latlng.lat]);
  const values = await geoblaze.identify(activeGeoRaster, [x, y]);
  const v = values && values[0];

  const panel    = document.getElementById('depth-panel');
  const content  = document.getElementById('depth-panel-content');
  const closeBtn = document.getElementById('btn-close-depth-panel');

  if (v === null || v === undefined || v === 65535 || v < 5) {
    content.innerHTML = `<div style="font-size:13px;color:#666;">No water at this location</div>`;
  } else {
    const depthM = v / 100;
    let color = '#d73027';
    if (depthM < 0.1)      color = '#c6dbef';
    else if (depthM < 0.3) color = '#9ecae1';
    else if (depthM < 0.5) color = '#6baed6';
    else if (depthM < 1.0) color = '#3182bd';
    else if (depthM < 2.0) color = '#2171b5';
    const pct = Math.min(100, (depthM / 5.45) * 100).toFixed(1);
    const lat  = e.latlng.lat.toFixed(5);
    const lon  = e.latlng.lng.toFixed(5);
    content.innerHTML =
      `<div style="font-size:28px;font-weight:700;color:${color};margin-bottom:4px">${depthM.toFixed(2)} m</div>` +
      `<div style="font-size:11px;color:#999;margin-bottom:16px">water depth at click point</div>` +
      `<div style="background:#f5f5f5;border-radius:6px;overflow:hidden;height:8px;margin-bottom:4px">` +
      `  <div style="width:${pct}%;height:100%;background:${color};transition:width 0.3s"></div>` +
      `</div>` +
      `<div style="font-size:11px;color:#999;margin-bottom:20px">0 m <span style="float:right">5.45 m max</span></div>` +
      `<div style="font-size:11px;color:#666;margin-bottom:6px"><strong>Scenario</strong></div>` +
      `<div style="font-size:12px;color:#1a1a1a;margin-bottom:16px">SRI-12 — Extreme rainfall</div>` +
      `<div style="font-size:11px;color:#666;margin-bottom:4px"><strong>Coordinates</strong></div>` +
      `<div style="font-size:12px;color:#1a1a1a;font-family:monospace">${lat}, ${lon}</div>`;
  }

  document.getElementById('depth-panel-title').textContent = 'Water depth';
  panel.style.display = 'flex';

  closeBtn.onclick = function() {
    panel.style.display = 'none';
  };
});

// ---------------------------------------------------------------------------
// Application state
// ---------------------------------------------------------------------------

let currentDataset        = null;
let floodLayer            = null;   // L.geoJSON flood polygon layer
let depthLayer            = null;   // L.geoJSON water depth layer
let buildingsLayer        = null;   // L.geoJSON building polygon layer
let floodedSegmentsLayer  = null;   // L.geoJSON flooded road segments layer
let boundaryLayer         = null;   // L.geoJSON city boundary layer
let bezirkeLayer          = null;   // L.geoJSON Bezirke districts layer
let routePolylines        = [];     // array of active L.polyline instances
let compareActive          = false;
let compareRoutePolylines  = [];   // flat array of L.polyline layers (halo + colored line per
                                    // feature per vehicle) — same shape as routePolylines,
                                    // so clearing is a plain loop with no per-vehicle bookkeeping.
let compareGeneration      = 0;    // bumped by every computeCompareRoutes() start and every
                                    // clearCompareRoutes(); an in-flight compare whose generation
                                    // no longer matches must not paint over newer state.
let currentColorMode      = true;   // true = color by flood_status, false = uniform blue
let compareMode           = false;
let activeGeoRaster       = null;   // parsed georaster object when a COG depth layer is active

let selectionMode      = 'origin';  // 'origin' | 'dest' | null
let originBid          = null;
let destBid            = null;
let originHighlightBid = null;
let destHighlightBid   = null;

let lastRouteData      = null;   // full /api/route response for the currently-drawn single
                                  // route — cached so the "Route detail" toggle can
                                  // re-paint by depth/passability without a new fetch.
let routeDetailPolylines = [];   // overlay polylines drawn on top of the flat base route when
                                  // "Route detail" is on — cleared independently of routePolylines.
let compareDetailPolylines = [];   // "Route detail" overlay for compare mode — separate array
                                    // from compareRoutePolylines, same on-top-not-replace pattern.
let lastCompareResults     = [];   // the raw Promise.allSettled() result array from
                                    // computeCompareRoutes() — each entry is
                                    // {status: 'fulfilled', value: {key, data}} or
                                    // {status: 'rejected', reason}, not a flat {key, data} object;
                                    // empty when no compare is active.

// ---------------------------------------------------------------------------
// Mode chooser
// ---------------------------------------------------------------------------

let appMode = 'pedestrian';  // 'pedestrian' | 'vehicle' — see applyAppMode() for what this drives

function openModeChooser() {
  // #help-overlay is shown by default on load; without this the two modals
  // stack. Also covers reopening the chooser via "← Change mode" later
  // (harmless no-op if help was already dismissed).
  document.getElementById('help-overlay').style.display = 'none';
  document.getElementById('mode-chooser-overlay').style.display = 'flex';
}

function closeModeChooser() {
  document.getElementById('mode-chooser-overlay').style.display = 'none';
}

// Named functions (not anonymous) so a later change can redefine their
// BODIES in place — editing these exact declarations — instead of
// registering a second addEventListener on the same buttons, which
// would fire twice per click.
function handleChoosePedestrian() {
  closeModeChooser();
  appMode = 'pedestrian';
  applyAppMode();
}

function handleChooseVehicle() {
  closeModeChooser();
  appMode = 'vehicle';
  applyAppMode();
}

document.getElementById('btn-choose-pedestrian').addEventListener('click', handleChoosePedestrian);
document.getElementById('btn-choose-vehicle').addEventListener('click', handleChooseVehicle);

function applyAppMode() {
  const isVehicle = appMode === 'vehicle';
  // "← Change mode" stays visible in both modes — pedestrian mode had no
  // other way back to the mode-chooser modal short of reloading the page.
  document.getElementById('btn-change-mode-wrap').style.display = 'block';
  document.getElementById('vehicle-mode-only').style.display    = isVehicle ? 'block' : 'none';
  // Note: enterCompareMode()/exitCompareMode() (Hamburg flood-comparison
  // feature) also write .sidebar-badge's text. The two features are
  // mutually exclusive in practice (compare mode is Hamburg-only, vehicle
  // mode is Heimfeld-only), but if a future change makes them reachable
  // together, this write and theirs would race — out of scope to fix now.
  document.querySelector('.sidebar-badge').textContent = isVehicle
    ? 'Emergency vehicle mode'
    : 'Brandenburg · Jan 2024';  // restored value only meaningful in pedestrian mode; dataset-specific badges (Hamburg compare mode) already override this elsewhere and are untouched.
  if (isVehicle) {
    populateVehicleSelect();
    renderVehicleNote();
    renderAnalysisToggle();
  }
}

document.getElementById('btn-change-mode').addEventListener('click', openModeChooser);

// ---------------------------------------------------------------------------
// Vehicle selector + Analysis method toggle
// ---------------------------------------------------------------------------

let selectedVehicle  = 'emergencia_hlf_4x4';
let selectedAnalysis = 'distance';

function populateVehicleSelect() {
  const select = document.getElementById('vehicle-select');
  select.innerHTML = '';
  VEHICLE_ORDER.forEach(key => {
    const v = VEHICLE_PROFILES[key];
    select.appendChild(new Option(`${v.label} — ${v.fordingDepth} fording depth`, key));
  });
  select.value = selectedVehicle;
}

function renderAnalysisToggle() {
  const onStyle  = 'background:#E1F5EE; color:#0F6E56; font-weight:600;';
  const offStyle = 'background:#fafafa; color:#757575;';
  // Plain assignment, not += — cssText replaces the whole style attribute
  // each render, so re-toggling many times never accumulates stale text.
  document.getElementById('btn-analysis-distance').style.cssText = selectedAnalysis === 'distance' ? onStyle : offStyle;
  document.getElementById('btn-analysis-time').style.cssText     = selectedAnalysis === 'time'     ? onStyle : offStyle;
}

function renderVehicleNote() {
  const v = VEHICLE_PROFILES[selectedVehicle];
  document.getElementById('vehicle-note').textContent =
    `Maximum fording depth ${v.fordingDepth} — segments deeper than this are excluded from the route.`;
}

document.getElementById('vehicle-select').addEventListener('change', function () {
  selectedVehicle = this.value;
  renderVehicleNote();
});

document.getElementById('btn-analysis-distance').addEventListener('click', function () {
  selectedAnalysis = 'distance';
  renderAnalysisToggle();
});

document.getElementById('btn-analysis-time').addEventListener('click', function () {
  selectedAnalysis = 'time';
  renderAnalysisToggle();
});

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function _findBuildingLayer(bid) {
  if (!buildingsLayer) return null;
  let found = null;
  buildingsLayer.eachLayer(function(layer) {
    if (layer.feature && layer.feature.properties.bid === bid) {
      found = layer;
    }
  });
  return found;
}

function getBuildingCenter(bid) {
  const layer = _findBuildingLayer(bid);
  return layer ? layer.getBounds().getCenter() : null;
}

function highlightBuilding(bid, borderColor) {
  const layer = _findBuildingLayer(bid);
  if (!layer) return;
  if (borderColor) {
    layer.setStyle({ color: borderColor, weight: 2.5, opacity: 1 });
  } else {
    layer.setStyle(getBuildingStyle(layer.feature));
  }
}

/**
 * Turns "Flooded segments" off and hides its layer. Called explicitly at
 * two moments: when a route calculation starts, and when the user
 * explicitly clicks "Clear route" — never from inside clearRoute() itself,
 * because clearRoute() also runs on every dataset switch (loadDataset())
 * and on typing a new origin ID (handleManualBidEntry), neither of which
 * should disable this toggle.
 */
function disableFloodedSegmentsToggle() {
  const toggle = document.getElementById('toggle-flooded-segments');
  if (toggle) toggle.checked = false;
  if (floodedSegmentsLayer) map.removeLayer(floodedSegmentsLayer);
}

/** Remove all route polylines from the map and reset the list. */
function clearRoute() {
  for (const polyline of routePolylines) {
    map.removeLayer(polyline);
  }
  routePolylines = [];
  lastRouteData = null;
  const detailToggle = document.getElementById('toggle-route-detail');
  if (detailToggle) detailToggle.checked = false;   // resets every time the route is cleared or
                                                      // recalculated (computeRoute() calls
                                                      // clearRoute() first) — see plan's answer to
                                                      // question 3: no persistence across routes.
  updateRouteDetailOverlay();   // checkbox is now unchecked, so this just clears
                                  // routeDetailPolylines/compareDetailPolylines and returns —
                                  // reuses the one function that owns this teardown instead of
                                  // hand-rolling a second copy of it here.
  clearCompareRoutes();
  document.getElementById('btn-compare-vehicles-wrap').style.display = 'none';
  if (originHighlightBid) { highlightBuilding(originHighlightBid, null); originHighlightBid = null; }
  if (destHighlightBid)   { highlightBuilding(destHighlightBid,   null); destHighlightBid   = null; }
  updateSlotStyle('origin', 'default');
  updateSlotStyle('dest', 'default');
  document.getElementById('result-section').style.display = 'none';
  document.getElementById('directions-list').innerHTML = '';
  setRouteStatus('');
  setSelectionMode('origin');
  updatePanelState();
}

function setRouteStatus(html) {
  document.getElementById('route-status').innerHTML = html;
}

function _getInputEl(which) {
  return document.getElementById(which === 'origin' ? 'origin-input' : 'dest-input');
}

function _getInputErrorEl(which) {
  return document.getElementById(which === 'origin' ? 'origin-input-error' : 'dest-input-error');
}

function showInputError(which, message) {
  const el = _getInputErrorEl(which);
  el.textContent = message;
  el.style.display = 'block';
}

function clearInputError(which) {
  _getInputErrorEl(which).style.display = 'none';
}

function resetInput(which) {
  _getInputEl(which).value = '';
  clearInputError(which);
  if (which === 'origin') originBid = null;
  else destBid = null;
  updatePanelState();
}

function setInputFilled(which, bid) {
  _getInputEl(which).value = bid;
  clearInputError(which);
  if (which === 'origin') originBid = bid;
  else destBid = bid;
  updatePanelState();
}

function setSelectionMode(mode) {
  selectionMode = mode;
  map.getContainer().style.cursor = (mode === 'origin' || mode === 'dest') ? 'crosshair' : '';
  if (mode === 'origin') setRouteStatus('Click a building to set origin');
  else if (mode === 'dest') setRouteStatus('Click a building to set destination');
}

function updatePanelState() {
  const hasOrigin      = !!originBid;
  const hasDestination = !!destBid;
  // Vehicle mode ships with explicit origin→destination routing only — there is
  // no "find nearest safe building" equivalent, so this button stays hidden.
  document.getElementById('btn-emergency').style.display =
    (appMode !== 'vehicle' && hasOrigin && !hasDestination) ? 'block' : 'none';
  document.getElementById('btn-route').style.display =
    hasOrigin && hasDestination ? 'block' : 'none';
  document.getElementById('btn-clear').style.display =
    hasOrigin ? 'block' : 'none';
}

function updateSlotStyle(which, status) {
  const slot   = document.getElementById(which === 'origin' ? 'origin-slot' : 'dest-slot');
  const colors = SLOT_COLORS[status] || SLOT_COLORS.default;
  slot.style.borderLeftColor = colors.border;
  slot.style.background      = colors.bg;
  const dot = slot.querySelector('.slot-dot');
  if (dot) dot.style.background = colors.border;
}

function renderDirections(directions) {
  const list = document.getElementById('directions-list');
  list.innerHTML = '';
  directions.forEach((step, i) => {
    const icon = step.action === 'start'
      ? (HEADING_ARROWS[step.heading] || '↑')
      : (DIRECTION_ICONS[step.action] || '↑');
    let label = '';

    if (step.action === 'start') {
      label = `Head ${step.heading}`;
    } else if (step.action === 'turn_right') {
      label = `In ${step.distance_m} m, turn right`;
    } else if (step.action === 'turn_left') {
      label = `In ${step.distance_m} m, turn left`;
    } else if (step.action === 'arriving') {
      label = `In ${step.distance_m} m, you will arrive at your destination`;
    } else if (step.action === 'arrive') {
      const sideText = step.side ? ` — building is on your ${step.side}` : '';
      label = `You have arrived at your destination${sideText}`;
    }

    const item = document.createElement('div');
    item.className = 'turn-item' + (step.action === 'arrive' ? ' turn-arrive' : '');
    item.innerHTML = `
      <div class="turn-text">${label}</div>
      <div class="turn-icon">${icon}</div>`;

    list.appendChild(item);
  });
}

function renderResult(data) {
  clearCompareRoutes();
  document.getElementById('btn-compare-vehicles-wrap').style.display =
    (appMode === 'vehicle' && destBid) ? 'block' : 'none';

  document.getElementById('result-section').style.display = 'block';

  const distCard = document.getElementById('stat-distance');
  if (appMode === 'vehicle' && selectedAnalysis === 'time') {
    distCard.querySelector('.stat-label').textContent = 'Total time';
    const totalSeconds = Math.round(data.total_cost);
    const mm = Math.floor(totalSeconds / 60);
    const ss = String(totalSeconds % 60).padStart(2, '0');
    distCard.querySelector('.stat-val').textContent = `${mm}:${ss}`;
  } else {
    distCard.querySelector('.stat-label').textContent = 'Total distance';
    distCard.querySelector('.stat-val').textContent = Math.round(data.total_cost) + ' m';
  }

  const floodedEl = document.getElementById('stat-flooded').querySelector('.stat-val');
  floodedEl.textContent  = data.flooded_segments;
  floodedEl.style.color  = data.flooded_segments === 0 ? '#1a9850' : '#d73027';

  document.getElementById('stat-segments').querySelector('.stat-val').textContent =
    data.road_segments;

  if (data.to_status) updateSlotStyle('dest', data.to_status);

  if (data.directions) renderDirections(data.directions);
}

/**
 * Fetch a URL, parse JSON, and throw a meaningful Error on HTTP failure.
 * Always reads the response body so the error message from the API is surfaced.
 */
async function fetchJson(url) {
  const res  = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Core rendering functions
// ---------------------------------------------------------------------------

function getBuildingStyle(feature) {
  const status = feature.properties.flood_status;
  const color  = currentColorMode ? (STATUS_COLORS[status] || '#3388ff') : '#3388ff';
  return {
    fillColor:   color,
    fillOpacity: 0.7,
    color:       color,
    weight:      0.5,
    opacity:     1,
  };
}

function renderBuildings(geojson) {
  if (buildingsLayer) {
    map.removeLayer(buildingsLayer);
  }
  buildingsLayer = L.geoJSON(geojson, {
    style:    getBuildingStyle,
    renderer: L.canvas(),
    onEachFeature: function (feature, layer) {
      layer.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        onBuildingSelected(feature.properties.bid, feature.properties.flood_status);
      });
    },
  }).addTo(map);
}

// ---------------------------------------------------------------------------
// Dataset loading
// ---------------------------------------------------------------------------

async function loadHamburgBoundaries() {
  try {
    if (!boundaryLayer || !bezirkeLayer) {
      const res = await fetch(`${APP_BASE}/static/data/hamburg_boundaries.geojson`);
      const geojson = await res.json();
      const cityFeatures   = geojson.features.filter(f => f.properties.type === 'city_boundary');
      const bezirkFeatures = geojson.features.filter(f => f.properties.type === 'bezirk');

      if (!boundaryLayer) {
        boundaryLayer = L.geoJSON({ type: 'FeatureCollection', features: cityFeatures }, {
          style: { color: '#1a1a1a', weight: 2, fillOpacity: 0, opacity: 0.8 },
          interactive: false
        });
      }

      if (!bezirkeLayer) {
        bezirkeLayer = L.geoJSON({ type: 'FeatureCollection', features: bezirkFeatures }, {
          style: { color: '#444444', weight: 1.5, fillOpacity: 0, opacity: 0.7, dashArray: '6,4' },
          onEachFeature: function(feature, layer) {
            const name = feature.properties && feature.properties.name;
            if (name) {
              layer.bindTooltip(name, { permanent: true, direction: 'center', className: 'bezirk-label' });
            }
          },
          interactive: false
        });
      }
    }

    if (document.getElementById('toggle-boundary').checked && !map.hasLayer(boundaryLayer)) {
      boundaryLayer.addTo(map);
    }
    if (document.getElementById('toggle-bezirke').checked && !map.hasLayer(bezirkeLayer)) {
      bezirkeLayer.addTo(map);
    }

  } catch (err) {
    console.warn('Could not load Hamburg boundaries:', err);
  }
}

const COMPARE_DATASETS = [
  { id: 'hamburg_river_flood_frequent', label: '10-year return period' },
  { id: 'hamburg_river_flood_medium',   label: '100-year return period' },
  { id: 'hamburg_river_flood_extreme',  label: '200-year return period' }
];

async function enterCompareMode() {
  compareMode = true;
  document.getElementById('btn-compare').style.display = 'none';
  document.getElementById('dataset-select').style.display = 'none';
  document.getElementById('route-panel').style.display = 'none';
  document.querySelector('.btn-section').style.display = 'none';
  document.getElementById('route-status').style.display = 'none';
  document.getElementById('result-section').style.display = 'none';
  document.getElementById('compare-panel').style.display = 'block';
  document.getElementById('toggle-boundary').checked = true;
  document.getElementById('toggle-bezirke').checked = true;
  document.querySelector('.sidebar-title').innerHTML = '<span class="title-icon">◈</span> Flood comparison';
  document.querySelector('.sidebar-badge').textContent = 'Hamburg · River Flood';
  document.getElementById('sidebar').style.background = '#1a2744';
  document.querySelector('.sidebar-title').style.color = '#ffffff';
  document.querySelector('.sidebar-badge').style.background = '#2a3f6f';
  document.querySelector('.sidebar-badge').style.color = '#a8c4e8';
  document.querySelectorAll('.section-label').forEach(el => el.style.color = '#7a9cc4');
  document.querySelectorAll('.toggle-row').forEach(el => el.style.color = '#c8d8ed');
  document.querySelectorAll('.legend-row').forEach(el => el.style.color = '#c8d8ed');
  document.getElementById('compare-slider').value = 0;
  document.getElementById('compare-slider-label').textContent = COMPARE_DATASETS[0].label;
  document.getElementById('dataset-select').value = 'hamburg_river_flood_frequent';
  map.setMaxBounds(null);
  map.setMinZoom(1);
  map.setView([53.55, 10.0], 11);
  await loadDataset('hamburg_river_flood_frequent');
}

async function exitCompareMode() {
  compareMode = false;
  document.getElementById('btn-compare').style.display = 'block';
  document.getElementById('dataset-select').style.display = 'block';
  document.getElementById('route-panel').style.display = 'block';
  document.querySelector('.btn-section').style.display = 'flex';
  document.getElementById('route-status').style.display = 'block';
  document.getElementById('compare-panel').style.display = 'none';
  document.querySelector('.sidebar-title').innerHTML = '<span class="title-icon">◈</span> Flood routing';
  document.querySelector('.sidebar-badge').textContent = 'Brandenburg · Jan 2024';
  document.getElementById('sidebar').style.background = '#ffffff';
  document.querySelector('.sidebar-title').style.color = '#1a1a1a';
  document.querySelector('.sidebar-badge').style.background = '#E1F5EE';
  document.querySelector('.sidebar-badge').style.color = '#0F6E56';
  document.querySelectorAll('.section-label').forEach(el => el.style.color = '#9e9e9e');
  document.querySelectorAll('.toggle-row').forEach(el => el.style.color = '#444');
  document.querySelectorAll('.legend-row').forEach(el => el.style.color = '#444');
  document.getElementById('dataset-select').value = 'brandenburg';
  await loadDataset('brandenburg');
}

async function loadDataset(name) {
  currentDataset = name;

  clearRoute();
  resetInput('origin');
  resetInput('dest');
  if (floodLayer) {
    try { map.removeLayer(floodLayer); } catch(e) {}
    try { floodLayer.remove(); } catch(e) {}
    floodLayer = null;
  }
  if (depthLayer)            { map.removeLayer(depthLayer);               depthLayer            = null; }
  activeGeoRaster = null;
  if (buildingsLayer)        { map.removeLayer(buildingsLayer);            buildingsLayer        = null; }
  if (floodedSegmentsLayer)  { map.removeLayer(floodedSegmentsLayer);      floodedSegmentsLayer  = null; }

  setRouteStatus('Loading flood polygons…');

  try {
    const [floodGeoJSON, bboxData] = await Promise.all([
      fetchJson(apiUrl(`flood?dataset=${encodeURIComponent(name)}`)),
      fetchJson(apiUrl(`bbox?dataset=${encodeURIComponent(name)}`))
    ]);

    const [minx, miny, maxx, maxy] = bboxData.bbox;
    if (!compareMode) {
      const pad = 0.5;
      map.setMaxBounds([[miny - pad, minx - pad], [maxy + pad, maxx + pad]]);
      map.setMinZoom(9);
      const centerLat = (miny + maxy) / 2;
      const centerLon = (minx + maxx) / 2;
      map.setView([centerLat, centerLon], 14);
    }

    floodLayer = L.vectorGrid.slicer(floodGeoJSON, {
      rendererFactory: L.svg.tile,
      vectorTileLayerStyles: {
        sliced: {
          fillColor: '#1E90FF',
          fillOpacity: 0.4,
          stroke: false,
          fill: true
        }
      },
      interactive: false,
      maxZoom: 20
    });
    if (document.getElementById('toggle-flood').checked) {
      floodLayer.addTo(map);
    }

    // Depth layer — GeoRasterLayer for COG datasets, L.geoJSON for classic datasets.
    // A COG dataset is detected when the flood GeoJSON has no features (empty placeholder)
    // or the dataset name contains 'raster'.
    if (depthLayer) { map.removeLayer(depthLayer); depthLayer = null; }
    activeGeoRaster = null;

    const _hasFloodPolygons = !!(floodGeoJSON.features && floodGeoJSON.features.length);
    const _useRasterDepth   = !_hasFloodPolygons || name.toLowerCase().includes('raster');

    if (_useRasterDepth && typeof parseGeoraster !== 'undefined') {
      try {
        const _rasterUrl = window.location.origin + apiUrl(`raster?dataset=${encodeURIComponent(name)}`);
        const _gr = await parseGeoraster(_rasterUrl);
        activeGeoRaster = _gr;
        depthLayer = new GeoRasterLayer({
          georaster: _gr,
          pixelValuesToColorFn: function(values) {
            const v = values[0];
            if (v === 65535 || v < 5) return null;   // nodata or < 5 cm → transparent
            const d = v / 100;                        // uint16 cm → metres
            if (d < 0.1) return '#c6dbef';
            if (d < 0.3) return '#9ecae1';
            if (d < 0.5) return '#6baed6';
            if (d < 1.0) return '#3182bd';
            if (d < 2.0) return '#2171b5';
            return '#d73027';
          },
          opacity: 0.7,
          resolution: 256,
          interactive: true
        });
      } catch (_err) {
        console.warn('[depth] Could not load COG raster:', _err);
      }
    } else if (_hasFloodPolygons) {
      depthLayer = L.geoJSON(floodGeoJSON, {
        style: function(feature) {
          const depth = feature.properties.depth_m;
          const color = DEPTH_COLORS[depth] || '#2171b5';
          return { fillColor: color, fillOpacity: 0.7, color: color, weight: 0.3, opacity: 0.8 };
        },
        interactive: false
      });
    }
    if (depthLayer && document.getElementById('toggle-depth').checked) {
      depthLayer.addTo(map);
    }

    setRouteStatus('Loading buildings…');
    const buildingsGeoJSON = await fetchJson(apiUrl(`buildings?dataset=${encodeURIComponent(name)}`));

    renderBuildings(buildingsGeoJSON);

    // Load flooded road segments
    const floodedData = await fetchJson(apiUrl(`flooded_segments?dataset=${encodeURIComponent(name)}`));

    if (floodedSegmentsLayer) map.removeLayer(floodedSegmentsLayer);
    floodedSegmentsLayer = L.geoJSON(floodedData, {
      style: function(feature) {
        const color = PASSABILITY_COLORS[feature.properties.passability] || '#d73027';
        return { color: color, weight: 2, opacity: 0.8 };
      }
    });
    if (document.getElementById('toggle-flooded-segments').checked) {
      floodedSegmentsLayer.addTo(map);
    }

    setSelectionMode('origin');

    if (name.toLowerCase().includes('hamburg')) {
      loadHamburgBoundaries();
    } else {
      if (boundaryLayer) { map.removeLayer(boundaryLayer); boundaryLayer = null; }
      document.getElementById('toggle-boundary').checked = false;
      if (bezirkeLayer) { map.removeLayer(bezirkeLayer); bezirkeLayer = null; }
      document.getElementById('toggle-bezirke').checked = false;
    }
  } catch (err) {
    setRouteStatus(`<span style="color:red">Error loading dataset: ${err.message}</span>`);
  }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function onBuildingSelected(bid, floodStatus) {
  const originVal = document.getElementById('origin-input').value.trim();
  if (!originVal) {
    setInputFilled('origin', bid);
    clearRoute();
    resetInput('dest');
    if (floodStatus) updateSlotStyle('origin', floodStatus);
    setSelectionMode('dest');
    _renderBuildingPanel(_getBuildingProps(bid), null, null);
  } else {
    if (bid === originBid) return;
    setInputFilled('dest', bid);
    setSelectionMode(null);
    _renderBuildingPanel(_getBuildingProps(originBid), _getBuildingProps(bid), null);
    computeRoute(originBid, bid);
  }
  updatePanelState();
}

/**
 * Fired on blur/Enter for the origin/dest text inputs — lets a building ID
 * be typed or pasted directly instead of only clicked on the map.
 *
 * onBuildingSelected() is deliberately NOT reused/shared here: its "decide
 * which slot based on whether origin is already filled" branching doesn't
 * apply when the user is typing into a specific, known slot, and the two
 * branches aren't parallel enough to extract a common helper without adding
 * more complexity than the few duplicated lines are worth — this reuses the
 * same lower-level primitives (setInputFilled, clearRoute, resetInput,
 * updateSlotStyle, setSelectionMode, _renderBuildingPanel, computeRoute)
 * that onBuildingSelected already calls, instead of a new shared abstraction.
 *
 * Known limitation: clearing the field by hand (deleting all text) does
 * nothing — there's no listener for the resulting empty value, so
 * originBid/destBid and any existing highlight/route are left as-is.
 */
function handleManualBidEntry(which) {
  const input = _getInputEl(which);
  const bid   = input.value.trim();
  if (!bid) return;

  const currentBid = which === 'origin' ? originBid : destBid;
  if (bid === currentBid) return;   // no-op on blur/Enter without an actual change

  const props = _getBuildingProps(bid);
  if (!props) {
    showInputError(which, `No building with ID "${bid}" in the current dataset.`);
    return;
  }
  clearInputError(which);

  if (which === 'origin') {
    setInputFilled('origin', bid);
    clearRoute();
    resetInput('dest');
    updateSlotStyle('origin', props.flood_status);
    setSelectionMode('dest');
    _renderBuildingPanel(props, null, null);
  } else {
    if (originBid && bid === originBid) return;   // same guard onBuildingSelected uses for its dest branch
    setInputFilled('dest', bid);
    updateSlotStyle('dest', props.flood_status);
    if (originBid) {
      setSelectionMode(null);
      _renderBuildingPanel(_getBuildingProps(originBid), props, null);
      computeRoute(originBid, bid);
    } else {
      // Destination typed before an origin exists — fill the slot and show
      // its info, but there's nothing to route yet (mirrors how btn-route
      // stays hidden until both slots are set; see updatePanelState()).
      _renderBuildingPanel(null, props, null);
    }
  }
  updatePanelState();
}

function _getBuildingProps(bid) {
  if (!buildingsLayer || !bid) return null;
  let props = null;
  buildingsLayer.eachLayer(function(layer) {
    if (!props && layer.feature && layer.feature.properties.bid === bid) {
      props = layer.feature.properties;
    }
  });
  return props;
}

function _escapeHtml(value) {
  // Building attributes (e.g. building_type) come from OSM tags, which are
  // free text anyone can edit — never trust them as HTML. This is used
  // wherever such a value is interpolated into an innerHTML template
  // string, so the browser always renders it as plain text.
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function _renderBuildingPanel(originData, destData, routeData) {
  const STATUS_CONFIG = {
    drowned:  { emoji: '🔴', label: 'Drowned',  color: '#d73027' },
    close_to: { emoji: '🟠', label: 'Close to', color: '#f46d43' },
    at_risk:  { emoji: '🟡', label: 'At risk',  color: '#b8860b' },
    safe:     { emoji: '🟢', label: 'Safe',     color: '#1a9850' },
  };

  function buildingCard(title, data) {
    if (!data) return '';
    const s = STATUS_CONFIG[data.flood_status] || { emoji: '⚪', label: data.flood_status || '—', color: '#999' };
    const depthRows = (data.flood_status === 'drowned' && data.depth_max_m != null)
      ? `<div style="display:flex;justify-content:space-between;margin-bottom:5px">` +
          `<span style="font-size:12px;color:#666">Max depth</span>` +
          `<span style="font-size:12px;color:#1a1a1a">${(+data.depth_max_m).toFixed(2)} m</span></div>` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:5px">` +
          `<span style="font-size:12px;color:#666">Mean depth</span>` +
          `<span style="font-size:12px;color:#1a1a1a">${(+data.depth_mean_m).toFixed(2)} m</span></div>`
      : '';
    return `<div style="margin-bottom:12px">` +
        `<div style="font-size:10px;font-weight:600;color:#999;letter-spacing:0.07em;text-transform:uppercase;margin-bottom:8px">${title}</div>` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:12px;color:#666">ID</span><span style="font-size:11px;color:#1a1a1a;font-family:monospace">${data.bid}</span></div>` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:12px;color:#666">Type</span><span style="font-size:12px;color:#1a1a1a">${_escapeHtml((data.building_type === 'yes' ? 'Unknown' : data.building_type) || '—')}</span></div>` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:12px;color:#666">Status</span><span style="font-size:12px;color:${s.color};font-weight:600">${s.emoji} ${s.label}</span></div>` +
        depthRows +
      `</div><div style="height:1px;background:#f0f0f0;margin-bottom:12px"></div>`;
  }

  const pendingDest = originData && !destData
    ? `<div style="font-size:12px;color:#aaa;margin-bottom:12px;font-style:italic">Select a destination building</div>`
    : '';

  let routeHtml = '';
  if (routeData) {
    const dist = routeData.total_cost != null ? `${Math.round(routeData.total_cost)} m` : '—';
    const floodColor  = routeData.flooded_segments > 0 ? '#d73027' : '#1a1a1a';
    const floodWeight = routeData.flooded_segments > 0 ? '600' : '400';
    routeHtml =
      `<div style="font-size:10px;font-weight:600;color:#999;letter-spacing:0.07em;text-transform:uppercase;margin-bottom:8px">Route summary</div>` +
      `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:12px;color:#666">Distance</span><span style="font-size:12px;color:#1a1a1a">${dist}</span></div>` +
      `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:12px;color:#666">Road segments</span><span style="font-size:12px;color:#1a1a1a">${routeData.road_segments}</span></div>` +
      `<div style="display:flex;justify-content:space-between;margin-bottom:5px"><span style="font-size:12px;color:#666">Flooded segments</span><span style="font-size:12px;color:${floodColor};font-weight:${floodWeight}">${routeData.flooded_segments}</span></div>`;
  }

  document.getElementById('depth-panel-content').innerHTML =
    buildingCard('Origin building', originData) + pendingDest +
    buildingCard('Destination building', destData) + routeHtml;

  const panel    = document.getElementById('depth-panel');
  const closeBtn = document.getElementById('btn-close-depth-panel');
  document.getElementById('depth-panel-title').textContent = 'Building info';
  panel.style.display = 'flex';
  closeBtn.onclick = function() { panel.style.display = 'none'; };
}

function _renderRouteGeometry(data, fromBid) {
  originHighlightBid = fromBid;
  destHighlightBid   = data.to;
  highlightBuilding(fromBid,  '#1a9850');
  highlightBuilding(data.to,  '#d73027');

  if (!data.path_geojson || !data.path_geojson.features.length) return;

  // Flat, single color per profile — no gradient, no reuse of the flood-status
  // palette. Depth/passability detail is opt-in via the "Route detail"
  // toggle, drawn as a separate overlay on top of this same geometry —
  // this loop never changes.
  const baseColor = appMode === 'vehicle'
    ? (VEHICLE_PROFILES[selectedVehicle] || {}).color || PEDESTRIAN_ROUTE_COLOR
    : PEDESTRIAN_ROUTE_COLOR;

  const features = data.path_geojson.features;
  for (const feature of features) {
    if (!feature.geometry || !feature.geometry.coordinates) continue;
    const latlngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    routePolylines.push(L.polyline(latlngs, { color: baseColor, weight: 4 }).addTo(map));
  }

  lastRouteData = data;

  const originCenter = getBuildingCenter(fromBid);
  const destCenter   = getBuildingCenter(data.to);

  // Yellow dashed access lines using backend-provided access node coordinates
  if (originCenter && data.access_from) {
    const accessFromPoint = [data.access_from.coordinates[1], data.access_from.coordinates[0]];
    routePolylines.push(
      L.polyline([originCenter, accessFromPoint], {
        color: '#f0c808', weight: 3, dashArray: '8, 8', opacity: 0.9
      }).addTo(map)
    );
  }
  if (destCenter && data.access_to) {
    const accessToPoint = [data.access_to.coordinates[1], data.access_to.coordinates[0]];
    routePolylines.push(
      L.polyline([accessToPoint, destCenter], {
        color: '#f0c808', weight: 3, dashArray: '8, 8', opacity: 0.9
      }).addTo(map)
    );
  }

  // Origin marker (green play)
  if (originCenter) {
    routePolylines.push(
      L.marker(originCenter, {
        icon: L.divIcon({
          className: 'route-marker-origin',
          html: '<div style="background:#1a9850;color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)">▶</div>',
          iconSize: [28, 28], iconAnchor: [14, 14]
        })
      }).addTo(map)
    );
  }

  // Destination marker (red pin)
  if (destCenter) {
    routePolylines.push(
      L.marker(destCenter, {
        icon: L.divIcon({
          className: 'route-marker-dest',
          html: '<div style="background:#d73027;color:white;border-radius:50% 50% 50% 0;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);transform:rotate(-45deg)"><span style="transform:rotate(45deg);display:block">📍</span></div>',
          iconSize: [28, 28], iconAnchor: [14, 28]
        })
      }).addTo(map)
    );
  }

  // Auto-zoom to fit entire route and both buildings
  if (originCenter && destCenter) {
    let routeBounds = L.latLngBounds([originCenter, destCenter]);
    routePolylines.forEach(function(layer) {
      if (typeof layer.getBounds === 'function') routeBounds.extend(layer.getBounds());
    });
    map.fitBounds(routeBounds, { padding: [50, 50] });
  }
}

async function computeRoute(fromBid, toBid) {
  if (!currentDataset) return;
  clearRoute();
  disableFloodedSegmentsToggle();
  setRouteStatus('Calculating route…');

  try {
    let url = apiUrl(`route?dataset=${encodeURIComponent(currentDataset)}&from=${encodeURIComponent(fromBid)}`);
    if (toBid) url += `&to=${encodeURIComponent(toBid)}`;
    if (appMode === 'vehicle') {
      url += `&vehicle=${encodeURIComponent(selectedVehicle)}&optimize=${encodeURIComponent(selectedAnalysis)}`;
    }

    const data = await fetchJson(url);

    if (!data.found) {
      if (data.has_wet_route) {
        setRouteStatus(
          `<div style="text-align:center">` +
          `<strong>No dry route found</strong><br>${data.reason}` +
          `<br><button id="btn-show-wet-route" style="margin-top:8px;padding:5px 12px;` +
          `background:#d73027;color:white;border:none;border-radius:6px;font-size:12px;` +
          `font-family:inherit;cursor:pointer;">Show route anyway</button>` +
          `</div>`
        );
        document.getElementById('btn-show-wet-route').addEventListener('click', function() {
          this.remove();
          renderResult(data);
          _renderRouteGeometry(data, fromBid);
        });
      } else {
        setRouteStatus(`<strong>No route found</strong><br>${data.reason}`);
      }
      return;
    }

    setRouteStatus('');
    renderResult(data);
    _renderRouteGeometry(data, fromBid);
    _renderBuildingPanel(_getBuildingProps(fromBid), _getBuildingProps(data.to), data);
  } catch (err) {
    if (appMode === 'vehicle' && /vehicle routing not available/i.test(err.message)) {
      setRouteStatus(`<span style="color:#d73027">Vehicle routing isn't available for this dataset.</span>`);
    } else {
      setRouteStatus(`<span style="color:red">Error: ${err.message}</span>`);
    }
  }
}

// ---------------------------------------------------------------------------
// Compare with the other 2 vehicles
// ---------------------------------------------------------------------------

function clearCompareRoutes() {
  // Invalidate any compare request still in flight — including the clear that
  // renderResult() does for a fresh single-route calculation.
  compareGeneration++;
  for (const layer of compareRoutePolylines) {
    map.removeLayer(layer);
  }
  compareRoutePolylines = [];
  for (const layer of compareDetailPolylines) {
    map.removeLayer(layer);
  }
  compareDetailPolylines = [];
  lastCompareResults = [];
  compareActive = false;
  document.getElementById('compare-vehicles-section').style.display = 'none';
  document.getElementById('compare-legend').style.display = 'none';
  document.getElementById('btn-compare-vehicles').textContent = 'Compare with the other 2 vehicles';
}

async function computeCompareRoutes(fromBid, toBid) {
  const myGeneration = ++compareGeneration;

  const results = await Promise.allSettled(
    VEHICLE_ORDER.map(key => {
      const url = apiUrl(
        `route?dataset=${encodeURIComponent(currentDataset)}&from=${encodeURIComponent(fromBid)}` +
        `&to=${encodeURIComponent(toBid)}&vehicle=${encodeURIComponent(key)}&optimize=${encodeURIComponent(selectedAnalysis)}`
      );
      return fetchJson(url).then(data => ({ key, data }));
    })
  );

  // A newer compare (or a route clear / fresh single-route calculation) started
  // while these requests were in flight — drop this stale result set untouched.
  if (myGeneration !== compareGeneration) return;

  clearCompareRoutes();
  compareActive = true;
  lastCompareResults = results;
  document.getElementById('btn-compare-vehicles').textContent = 'Hide comparison';

  const legendRows = document.getElementById('compare-legend-rows');
  const cards       = document.getElementById('compare-vehicles-cards');
  legendRows.innerHTML = '';
  cards.innerHTML = '';

  results.forEach((settled, i) => {
    const key = VEHICLE_ORDER[i];
    const v   = VEHICLE_PROFILES[key];

    // Legend entry — always shown, even for a failed/unreachable vehicle,
    // so the 3 vehicles compared are never silently reduced to fewer.
    legendRows.insertAdjacentHTML('beforeend', `
      <div style="display:flex; align-items:center; gap:7px;">
        <svg width="26" height="4" viewBox="0 0 26 4"><line x1="0" y1="2" x2="26" y2="2" stroke="${v.color}" stroke-width="3" stroke-dasharray="${v.dash || '0'}"></line></svg>
        <span style="font-size:11.5px; color:#424242;">${v.label}</span>
      </div>`);

    // A found:true response with no usable geometry would draw nothing and
    // silently skip its card — mirror _renderRouteGeometry()'s own guard and
    // treat it as a failure so it still gets a card.
    const ok = settled.status === 'fulfilled' && settled.value.data.found &&
      settled.value.data.path_geojson &&
      settled.value.data.path_geojson.features.length > 0;

    if (ok) {
      const { data } = settled.value;
      // Same per-feature extraction and guard as the existing single-route
      // drawing in _renderRouteGeometry() (static/app_original.js:679-687) —
      // one halo+colored-line pair per feature, never a flattened
      // whole-route polyline. A flattened array would draw a spurious
      // straight line across any feature api_route() skipped for missing
      // geometry (access edges); per-feature drawing skips it correctly,
      // same as the pedestrian route already does.
      for (const feature of data.path_geojson.features) {
        if (!feature.geometry || !feature.geometry.coordinates) continue;
        const latlngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
        compareRoutePolylines.push(
          L.polyline(latlngs, { color: '#fff', weight: 8, opacity: 0.75 }).addTo(map)
        );
        compareRoutePolylines.push(
          L.polyline(latlngs, {
            color: v.color, weight: 4, opacity: 0.95,
            dashArray: v.dash, lineCap: v.lineCap
          }).addTo(map)
        );
      }

      const costLabel = selectedAnalysis === 'time' ? 'Time' : 'Dist.';
      const costValue = selectedAnalysis === 'time'
        ? (() => { const s = Math.round(data.total_cost); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; })()
        : `${Math.round(data.total_cost)} m`;

      cards.insertAdjacentHTML('beforeend', `
        <div style="background:#fafafa; border:1px solid #eeeeee; border-left:4px solid ${v.color}; border-radius:0 4px 4px 0; padding:8px 9px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <span style="font-size:12px; font-weight:600; color:#212121;">${v.label}</span>
            <span style="font-size:10.5px; color:#9e9e9e;">${v.fordingDepth} fording</span>
          </div>
          <div style="margin-top:6px; display:flex; gap:14px;">
            <div><div style="font-size:10px; text-transform:uppercase; color:#9e9e9e;">${costLabel}</div><div style="font-size:13.5px; font-weight:600;">${costValue}</div></div>
            <div><div style="font-size:10px; text-transform:uppercase; color:#9e9e9e;">Flooded seg.</div><div style="font-size:13.5px; font-weight:600;">${data.flooded_segments}</div></div>
          </div>
        </div>`);
    } else {
      const reason = settled.status === 'rejected' ? settled.reason.message : settled.value.data.reason;
      cards.insertAdjacentHTML('beforeend', `
        <div style="background:#fafafa; border:1px solid #eeeeee; border-left:4px solid #bdbdbd; border-radius:0 4px 4px 0; padding:8px 9px;">
          <div style="font-size:12px; font-weight:600; color:#212121;">${v.label}</div>
          <div style="margin-top:4px; font-size:11px; color:#9e9e9e;">${reason || 'No route'}</div>
        </div>`);
    }
  });

  document.getElementById('compare-vehicles-section').style.display = 'block';
  document.getElementById('compare-legend').style.display = 'block';
}

/**
 * Draws or clears the "Route detail" overlay on top of whatever route
 * geometry is currently on the map — single route or vehicle comparison,
 * whichever is active. Never fetches; only reads cached state from the last
 * successful computeRoute()/computeCompareRoutes() call. Safe to call at any
 * time (e.g. right after entering/leaving compare mode) — it always clears
 * its own previous overlay layers first.
 */
function updateRouteDetailOverlay() {
  for (const layer of routeDetailPolylines)   map.removeLayer(layer);
  for (const layer of compareDetailPolylines) map.removeLayer(layer);
  routeDetailPolylines   = [];
  compareDetailPolylines = [];

  if (!document.getElementById('toggle-route-detail').checked) return;

  if (compareActive && lastCompareResults.length) {
    for (const settled of lastCompareResults) {
      const ok = settled.status === 'fulfilled' && settled.value.data.found &&
        settled.value.data.path_geojson && settled.value.data.path_geojson.features.length > 0;
      if (!ok) continue;
      const { key, data } = settled.value;
      const v = VEHICLE_PROFILES[key];
      for (const feature of data.path_geojson.features) {
        if (!feature.geometry || !feature.geometry.coordinates) continue;
        const latlngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
        const color   = tintByDepth(v.color, feature.properties.depth_m || 0);
        compareDetailPolylines.push(
          L.polyline(latlngs, {
            color, weight: 4, opacity: 0.95, dashArray: v.dash, lineCap: v.lineCap
          }).addTo(map)
        );
      }
    }
  } else if (lastRouteData && lastRouteData.path_geojson) {
    for (const feature of lastRouteData.path_geojson.features) {
      if (!feature.geometry || !feature.geometry.coordinates) continue;
      const latlngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      const color   = PASSABILITY_COLORS[feature.properties.passability] || '#d73027';
      routeDetailPolylines.push(L.polyline(latlngs, { color, weight: 4 }).addTo(map));
    }
  }
}

document.getElementById('toggle-route-detail').addEventListener('change', updateRouteDetailOverlay);

document.getElementById('btn-compare-vehicles').addEventListener('click', function () {
  if (compareActive) {
    clearCompareRoutes();
    updateRouteDetailOverlay();   // was showing the compare-mode overlay; re-evaluate for the
                                   // single route now that compare is gone (still respects
                                   // whatever the checkbox is currently set to).
  } else {
    computeCompareRoutes(originBid, destBid).then(() => {
      updateRouteDetailOverlay();   // if "Route detail" was already checked, extend it to the
                                     // freshly-drawn compare routes immediately — no separate
                                     // click needed.
    }).catch(err => {
      clearCompareRoutes();
      setRouteStatus(`<span style="color:red">Error comparing vehicles: ${err.message}</span>`);
    });
  }
});

// Help popup
document.getElementById('btn-got-it').addEventListener('click', function() {
  document.getElementById('help-overlay').style.display = 'none';
});
document.getElementById('btn-how-to-use').addEventListener('click', function() {
  document.getElementById('help-overlay').style.display = 'flex';
});

// ---------------------------------------------------------------------------
// Event listeners — layer toggles
// ---------------------------------------------------------------------------

document.getElementById('toggle-flood').addEventListener('change', function () {
  if (!floodLayer) return;
  this.checked ? floodLayer.addTo(map) : map.removeLayer(floodLayer);
});

document.getElementById('toggle-buildings').addEventListener('change', function () {
  if (!buildingsLayer) return;
  this.checked ? buildingsLayer.addTo(map) : map.removeLayer(buildingsLayer);
});

document.getElementById('toggle-colors').addEventListener('change', function () {
  currentColorMode = this.checked;
  if (buildingsLayer) buildingsLayer.setStyle(getBuildingStyle);
});

document.getElementById('toggle-flooded-segments').addEventListener('change', function () {
  if (this.checked) floodedSegmentsLayer?.addTo(map);
  else if (floodedSegmentsLayer) map.removeLayer(floodedSegmentsLayer);
});

document.getElementById('toggle-depth').addEventListener('change', function () {
  if (!depthLayer) return;
  this.checked ? depthLayer.addTo(map) : map.removeLayer(depthLayer);
});

document.getElementById('toggle-boundary').addEventListener('change', function() {
  if (!boundaryLayer) return;
  this.checked ? boundaryLayer.addTo(map) : map.removeLayer(boundaryLayer);
});

document.getElementById('toggle-bezirke').addEventListener('change', function() {
  if (!bezirkeLayer) return;
  this.checked ? bezirkeLayer.addTo(map) : map.removeLayer(bezirkeLayer);
});

document.getElementById('btn-compare').addEventListener('click', enterCompareMode);
document.getElementById('btn-exit-compare').addEventListener('click', exitCompareMode);

document.getElementById('compare-slider').addEventListener('input', async function() {
  const idx = parseInt(this.value);
  const dataset = COMPARE_DATASETS[idx];
  document.getElementById('compare-slider-label').textContent = dataset.label;
  await loadDataset(dataset.id);
});

document.getElementById('dataset-select').addEventListener('change', function () {
  if (this.value) loadDataset(this.value);
});

// ---------------------------------------------------------------------------
// Event listeners — route panel
// ---------------------------------------------------------------------------

document.getElementById('btn-route').addEventListener('click', function () {
  const fromVal = document.getElementById('origin-input').value.trim();
  const toVal   = document.getElementById('dest-input').value.trim();
  if (!fromVal) { setRouteStatus('Enter an origin building ID.'); return; }
  originBid = fromVal;
  destBid   = toVal || null;
  computeRoute(originBid, destBid);
});

document.getElementById('btn-emergency').addEventListener('click', function () {
  if (!originBid || !currentDataset) return;
  computeRoute(originBid, null);
});

document.getElementById('btn-clear').addEventListener('click', function () {
  clearRoute();
  disableFloodedSegmentsToggle();
  resetInput('origin');
  resetInput('dest');
  updatePanelState();
  document.getElementById('depth-panel').style.display = 'none';
});

document.getElementById('origin-input').addEventListener('blur', function () {
  handleManualBidEntry('origin');
});
document.getElementById('origin-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') handleManualBidEntry('origin');
});
document.getElementById('dest-input').addEventListener('blur', function () {
  handleManualBidEntry('dest');
});
document.getElementById('dest-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') handleManualBidEntry('dest');
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  openModeChooser();
  try {
    const data   = await fetchJson(apiUrl('datasets'));
    const select = document.getElementById('dataset-select');

    for (const name of data.datasets) {
      select.appendChild(new Option(name, name));
    }

    if (data.datasets.length > 0) {
      const defaultDataset = data.datasets.includes('brandenburg')
        ? 'brandenburg'
        : data.datasets[0];
      select.value = defaultDataset;
      await loadDataset(defaultDataset);
    } else {
      setRouteStatus('No datasets available.');
    }
  } catch (err) {
    setRouteStatus(`<span style="color:red">Failed to load datasets: ${err.message}</span>`);
  }
}

init();
