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
let currentColorMode      = true;   // true = color by flood_status, false = uniform blue
let compareMode           = false;

let selectionMode      = 'origin';  // 'origin' | 'dest' | null
let originBid          = null;
let destBid            = null;
let originHighlightBid = null;
let destHighlightBid   = null;

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

/** Remove all route polylines from the map and reset the list. */
function clearRoute() {
  for (const polyline of routePolylines) {
    map.removeLayer(polyline);
  }
  routePolylines = [];
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

function resetInput(which) {
  _getInputEl(which).value = '';
  if (which === 'origin') originBid = null;
  else destBid = null;
  updatePanelState();
}

function setInputFilled(which, bid) {
  _getInputEl(which).value = bid;
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
  document.getElementById('btn-emergency').style.display =
    hasOrigin && !hasDestination ? 'block' : 'none';
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
  document.getElementById('result-section').style.display = 'block';

  document.getElementById('stat-distance').querySelector('.stat-val').textContent =
    Math.round(data.total_cost) + ' m';

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
      layer.on('click', function () {
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

    // Depth layer
    if (depthLayer) { map.removeLayer(depthLayer); depthLayer = null; }
    depthLayer = L.geoJSON(floodGeoJSON, {
      style: function(feature) {
        const depth = feature.properties.depth_m;
        const color = DEPTH_COLORS[depth] || '#2171b5';
        return {
          fillColor: color,
          fillOpacity: 0.7,
          color: color,
          weight: 0.3,
          opacity: 0.8
        };
      },
      interactive: false
    });
    if (document.getElementById('toggle-depth').checked) {
      depthLayer.addTo(map);
    }

    setRouteStatus('Loading buildings…');
    const buildingsGeoJSON = await fetchJson(apiUrl(`buildings?dataset=${encodeURIComponent(name)}`));

    renderBuildings(buildingsGeoJSON);

    // Load flooded road segments
    const floodedData = await fetchJson(apiUrl(`flooded_segments?dataset=${encodeURIComponent(name)}`));

    if (floodedSegmentsLayer) map.removeLayer(floodedSegmentsLayer);
    floodedSegmentsLayer = L.geoJSON(floodedData, {
      style: { color: '#d73027', weight: 2, opacity: 0.8 }
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
  } else {
    if (bid === originBid) return;
    setInputFilled('dest', bid);
    setSelectionMode(null);
    computeRoute(originBid, bid);
  }
  updatePanelState();
}

async function computeRoute(fromBid, toBid) {
  if (!currentDataset) return;
  clearRoute();
  setRouteStatus('Calculating route…');

  try {
    let url = apiUrl(`route?dataset=${encodeURIComponent(currentDataset)}&from=${encodeURIComponent(fromBid)}`);
    if (toBid) url += `&to=${encodeURIComponent(toBid)}`;

    const data = await fetchJson(url);

    if (!data.found) {
      setRouteStatus(`<strong>No route found</strong><br>${data.reason}`);
      return;
    }

    setRouteStatus('');
    renderResult(data);

    originHighlightBid = fromBid;
    destHighlightBid   = data.to;
    highlightBuilding(fromBid,  '#1a9850');
    highlightBuilding(data.to,  '#d73027');

    if (data.path_geojson && data.path_geojson.features.length > 0) {
      const features = data.path_geojson.features;

      for (const feature of features) {
        if (!feature.geometry || !feature.geometry.coordinates) continue;

        const latlngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
        const color   = feature.properties.flooded ? '#d73027' : '#2563eb';

        const polyline = L.polyline(latlngs, { color, weight: 4 }).addTo(map);
        routePolylines.push(polyline);
      }

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
              iconSize: [28, 28],
              iconAnchor: [14, 14]
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
              iconSize: [28, 28],
              iconAnchor: [14, 28]
            })
          }).addTo(map)
        );
      }

      // Auto-zoom to fit entire route and both buildings
      if (originCenter && destCenter) {
        let routeBounds = L.latLngBounds([originCenter, destCenter]);
        routePolylines.forEach(function(layer) {
          if (typeof layer.getBounds === 'function') {
            routeBounds.extend(layer.getBounds());
          }
        });
        map.fitBounds(routeBounds, { padding: [50, 50] });
      }
    }
  } catch (err) {
    setRouteStatus(`<span style="color:red">Error: ${err.message}</span>`);
  }
}

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
  resetInput('origin');
  resetInput('dest');
  updatePanelState();
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
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
