const STATIC_BASE = (() => {
  const p = window.location.pathname.replace(/\/index\.html$/, "");
  const idx = p.indexOf("/static");
  return idx >= 0 ? p.slice(0, idx + "/static".length) : "/static";
})();
const DATA_BASE = `${STATIC_BASE}/data`;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_COLORS = {
  drowned:  '#d73027',
  close_to: '#fc8d59',
  at_risk:  '#fee090',
  safe:     '#1a9850'
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

let floodLayer           = null;
let buildingsLayer       = null;
let floodedSegmentsLayer = null;
let currentColorMode     = true;

let safeRouteData        = null;
let directRouteData      = null;
let safeRoutePolylines   = [];
let directRoutePolylines = [];
let safeRouteVisible     = false;
let directRouteVisible   = false;

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

function setStatus(html) {
  document.getElementById('route-status').innerHTML = html;
}

function updateClearButton() {
  const anyVisible = safeRouteVisible || directRouteVisible;
  document.getElementById('btn-clear').style.display = anyVisible ? 'block' : 'none';
}

function clearRoutes() {
  if (safeRoutePolylines._animTimeout) {
    clearTimeout(safeRoutePolylines._animTimeout);
  }
  [...safeRoutePolylines, ...directRoutePolylines].forEach(p => {
    if (map.hasLayer(p)) map.removeLayer(p);
  });
  safeRoutePolylines = [];
  directRoutePolylines = [];
  safeRouteVisible = false;
  directRouteVisible = false;
  document.getElementById('result-safe').style.display   = 'none';
  document.getElementById('result-direct').style.display = 'none';
  updateClearButton();
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
      layer.on('click', function () {});
    },
  }).addTo(map);
}

function renderDirections(directions, container) {
  container.innerHTML = '';
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

    container.appendChild(item);
  });
}

function renderResult(data, resultId) {
  const section = document.getElementById(resultId);
  section.style.display = 'block';
  section.querySelector('.stat-distance .stat-val').textContent = Math.round(data.total_cost) + ' m';
  const flEl = section.querySelector('.stat-flooded .stat-val');
  flEl.textContent = data.flooded_segments;
  flEl.style.color = data.flooded_segments === 0 ? '#1a9850' : '#d73027';
  section.querySelector('.stat-segments .stat-val').textContent = data.road_segments;
  renderDirections(data.directions, section.querySelector('.directions-list'));
}

// ---------------------------------------------------------------------------
// Route toggling
// ---------------------------------------------------------------------------

async function toggleRoute(type) {
  const isVisible = type === 'safe' ? safeRouteVisible  : directRouteVisible;
  const polylines = type === 'safe' ? safeRoutePolylines : directRoutePolylines;
  const color     = type === 'safe' ? '#2563eb' : '#1a1a1a';
  const jsonFile  = type === 'safe' ? 'route_safe.json' : 'route_direct.json';
  const resultId  = type === 'safe' ? 'result-safe' : 'result-direct';

  if (isVisible) {
    if (type === 'safe' && safeRoutePolylines._animTimeout) {
      clearTimeout(safeRoutePolylines._animTimeout);
    }
    polylines.forEach(p => { if (map.hasLayer(p)) map.removeLayer(p); });
    if (type === 'safe') { safeRoutePolylines = []; safeRouteVisible = false; }
    else                 { directRoutePolylines = []; directRouteVisible = false; }
    document.getElementById(resultId).style.display = 'none';
    updateClearButton();
    return;
  }

  let data = type === 'safe' ? safeRouteData : directRouteData;
  if (!data) {
    setStatus(`Loading ${type} route…`);
    data = await fetch(`${DATA_BASE}/${jsonFile}`).then(r => r.json());
    if (type === 'safe') safeRouteData = data;
    else                 directRouteData = data;
    setStatus('');
  }

  const newPolylines = [];
  const srcCenter = getBuildingCenter(data.from);
  const dstCenter = getBuildingCenter(data.to);

  if (type === 'safe') {
    // Paso 1 — extraer segmentos como arrays de [lat,lon]
    const segments = [];
    for (const feature of data.path_geojson.features) {
      if (!feature.geometry?.coordinates) continue;
      const coords = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      if (coords.length >= 2) segments.push(coords);
    }

    // Paso 2 — orientar cada segmento para que empiece donde termina el anterior
    for (let i = 1; i < segments.length; i++) {
      const prevEnd   = segments[i-1].at(-1);
      const currStart = segments[i][0];
      const currEnd   = segments[i].at(-1);
      const distStart = Math.abs(currStart[0]-prevEnd[0]) + Math.abs(currStart[1]-prevEnd[1]);
      const distEnd   = Math.abs(currEnd[0]-prevEnd[0])   + Math.abs(currEnd[1]-prevEnd[1]);
      if (distEnd < distStart) segments[i] = [...segments[i]].reverse();
    }

    // Paso 3 — concatenar en un único array continuo
    const allCoords = segments.flat();

    // Paso 2 — fase 1: dibujado progresivo con L.motion.polyline (0–3000ms)
    const motionLine = L.motion.polyline(
      allCoords,
      { color: '#2563eb', weight: 5, opacity: 0.9 },
      { auto: true, duration: 3000, easing: L.Motion.Ease.easeInOutQuart },
      { removeOnEnd: false, showMarker: false }
    ).addTo(map);
    newPolylines.push(motionLine);

    // Líneas amarillas punteadas de acceso
    if (srcCenter && data.access_from) {
      const af = [data.access_from.coordinates[1], data.access_from.coordinates[0]];
      newPolylines.push(L.polyline([srcCenter, af], { color: '#f0c808', weight: 3, dashArray: '8,8', opacity: 0.9 }).addTo(map));
    }
    if (dstCenter && data.access_to) {
      const at = [data.access_to.coordinates[1], data.access_to.coordinates[0]];
      newPolylines.push(L.polyline([at, dstCenter], { color: '#f0c808', weight: 3, dashArray: '8,8', opacity: 0.9 }).addTo(map));
    }

    // Marcador origen (▶ verde)
    if (srcCenter) newPolylines.push(L.marker(srcCenter, { icon: L.divIcon({
      className: 'route-marker-origin',
      html: '<div style="background:#1a9850;color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)">▶</div>',
      iconSize: [28, 28], iconAnchor: [14, 14]
    })}).addTo(map));

    // Zoom automático usando allCoords
    if (allCoords.length > 0) {
      let bounds = L.latLngBounds(allCoords);
      if (srcCenter) bounds.extend(srcCenter);
      if (dstCenter) bounds.extend(dstCenter);
      map.fitBounds(bounds, { padding: [50, 50] });
    }

    // Paso 3 — fase 2 y 3: al terminar los 3000ms
    const safeAnimTimeout = setTimeout(() => {
      if (map.hasLayer(motionLine)) map.removeLayer(motionLine);
      const idx = newPolylines.indexOf(motionLine);
      if (idx > -1) newPolylines.splice(idx, 1);

      // Fase 2 — antPath con flujo animado
      const antLine = L.polyline.antPath(allCoords, {
        delay: 800,
        dashArray: [10, 20],
        weight: 5,
        color: '#2563eb',
        pulseColor: '#ffffff',
        opacity: 0.9,
        hardwareAccelerated: true,
      }).addTo(map);
      newPolylines.push(antLine);

      // Fase 3 — pin destino con círculo pulsante
      if (dstCenter) {
        const pulseIcon = L.divIcon({
          className: '',
          html: `
            <div style="position:relative;width:40px;height:40px;">
              <div class="pulse-ring"></div>
              <div style="position:absolute;top:50%;left:50%;
                   background:#d73027;color:white;border-radius:50% 50% 50% 0;
                   width:28px;height:28px;display:flex;align-items:center;justify-content:center;
                   font-size:12px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);
                   transform:translate(-50%,-50%) rotate(-45deg);">
                <span style="transform:rotate(45deg);display:block">📍</span>
              </div>
            </div>`,
          iconSize: [40, 40],
          iconAnchor: [20, 36]
        });
        const destMarker = L.marker(dstCenter, { icon: pulseIcon }).addTo(map);
        newPolylines.push(destMarker);
      }
    }, 3000);

    safeRoutePolylines = newPolylines;
    safeRoutePolylines._animTimeout = safeAnimTimeout;
    safeRouteVisible = true;

  } else {
    // type === 'direct' — sin cambios
    for (const feature of data.path_geojson.features) {
      if (!feature.geometry?.coordinates) continue;
      const latlngs = feature.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
      const segColor = feature.properties.flooded ? '#d73027' : color;
      newPolylines.push(L.polyline(latlngs, { color: segColor, weight: 5 }).addTo(map));
    }

    if (srcCenter && data.access_from) {
      const af = [data.access_from.coordinates[1], data.access_from.coordinates[0]];
      newPolylines.push(L.polyline([srcCenter, af], { color: '#f0c808', weight: 3, dashArray: '8,8', opacity: 0.9 }).addTo(map));
    }
    if (dstCenter && data.access_to) {
      const at = [data.access_to.coordinates[1], data.access_to.coordinates[0]];
      newPolylines.push(L.polyline([at, dstCenter], { color: '#f0c808', weight: 3, dashArray: '8,8', opacity: 0.9 }).addTo(map));
    }

    if (srcCenter) newPolylines.push(L.marker(srcCenter, { icon: L.divIcon({
      className: 'route-marker-origin',
      html: '<div style="background:#1a9850;color:white;border-radius:50%;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:14px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3)">▶</div>',
      iconSize: [28, 28], iconAnchor: [14, 14]
    })}).addTo(map));

    if (dstCenter) newPolylines.push(L.marker(dstCenter, { icon: L.divIcon({
      className: 'route-marker-dest',
      html: '<div style="background:#d73027;color:white;border-radius:50% 50% 50% 0;width:28px;height:28px;display:flex;align-items:center;justify-content:center;font-size:12px;border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.3);transform:rotate(-45deg)"><span style="transform:rotate(45deg);display:block">📍</span></div>',
      iconSize: [28, 28], iconAnchor: [14, 28]
    })}).addTo(map));

    const boundsArr = newPolylines
      .filter(l => typeof l.getBounds === 'function')
      .map(l => l.getBounds());
    let bounds = boundsArr.length > 0
      ? boundsArr.slice(1).reduce((acc, b) => acc.extend(b), boundsArr[0])
      : null;
    if (srcCenter) bounds = bounds ? bounds.extend(srcCenter) : L.latLngBounds([srcCenter, srcCenter]);
    if (dstCenter) bounds = bounds ? bounds.extend(dstCenter) : L.latLngBounds([dstCenter, dstCenter]);
    if (bounds) map.fitBounds(bounds, { padding: [50, 50] });

    directRoutePolylines = newPolylines;
    directRouteVisible = true;
  }

  renderResult(data, resultId);
  updateClearButton();
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

async function init() {
  setStatus('Loading map data…');
  const [buildingsGeoJSON, floodGeoJSON, floodedData, routeMeta] = await Promise.all([
    fetch(`${DATA_BASE}/buildings.geojson`).then(r => r.json()),
    fetch(`${DATA_BASE}/flood.geojson`).then(r => r.json()),
    fetch(`${DATA_BASE}/flooded_segments.geojson`).then(r => r.json()),
    fetch(`${DATA_BASE}/route_safe.json`).then(r => r.json()),
  ]);

  const [minx, miny, maxx, maxy] = routeMeta.bbox;
  map.fitBounds([[miny, minx], [maxy, maxx]]);

  renderBuildings(buildingsGeoJSON);

  floodLayer = L.vectorGrid.slicer(floodGeoJSON, {
    rendererFactory: L.svg.tile,
    vectorTileLayerStyles: { sliced: { fillColor: '#1E90FF', fillOpacity: 0.4, stroke: false, fill: true } },
    interactive: false, maxZoom: 20
  });
  if (document.getElementById('toggle-flood').checked) floodLayer.addTo(map);

  floodedSegmentsLayer = L.geoJSON(floodedData, {
    style: { color: '#d73027', weight: 2, opacity: 0.8 }
  });
  if (document.getElementById('toggle-flooded-segments').checked) floodedSegmentsLayer.addTo(map);

  setStatus('');
}

// Help popup
document.getElementById('btn-got-it').addEventListener('click', function() {
  document.getElementById('help-overlay').style.display = 'none';
});
document.getElementById('btn-how-to-use').addEventListener('click', function() {
  document.getElementById('help-overlay').style.display = 'flex';
});

// ---------------------------------------------------------------------------
// Event listeners — route buttons
// ---------------------------------------------------------------------------

document.getElementById('btn-safe-route').addEventListener('click',   () => toggleRoute('safe'));
document.getElementById('btn-direct-route').addEventListener('click', () => toggleRoute('direct'));
document.getElementById('btn-clear').addEventListener('click', clearRoutes);

// ---------------------------------------------------------------------------
// Event listeners — layer toggles
// ---------------------------------------------------------------------------

document.getElementById('toggle-flood').addEventListener('change', function() {
  if (!floodLayer) return;
  this.checked ? floodLayer.addTo(map) : map.removeLayer(floodLayer);
});
document.getElementById('toggle-buildings').addEventListener('change', function() {
  if (!buildingsLayer) return;
  this.checked ? buildingsLayer.addTo(map) : map.removeLayer(buildingsLayer);
});
document.getElementById('toggle-colors').addEventListener('change', function() {
  currentColorMode = this.checked;
  if (buildingsLayer) buildingsLayer.setStyle(getBuildingStyle);
});
document.getElementById('toggle-flooded-segments').addEventListener('change', function() {
  if (this.checked) floodedSegmentsLayer?.addTo(map);
  else if (floodedSegmentsLayer) map.removeLayer(floodedSegmentsLayer);
});

init();
