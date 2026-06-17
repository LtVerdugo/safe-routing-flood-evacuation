# Flood Evacuation Routing — CLAUDE.md

## 1. Descripción general del proyecto

Aplicación web de routing de evacuación de inundaciones. Dados edificios clasificados por exposición al agua (`drowned` / `close_to` / `at_risk` / `safe`) y una red viaria con cortes quirúrgicos en los tramos anegados, calcula la ruta peatonal más segura entre dos edificios o hacia el edificio seguro más cercano mediante A*.

El proyecto existe en dos modos de operación:

- **Modo Flask** (backend dinámico): el grafo NetworkX completo se carga en RAM al arranque; los endpoints `/api/route`, `/api/buildings`, etc. responden a peticiones del cliente con routing calculado en tiempo real. Requiere Python, los datasets procesados en `datasets/` y un proceso gunicorn. Interfaz: `static/app_original.js` + `static/index_original.html`.
- **Modo demo estático**: cinco ficheros JSON/GeoJSON precalculados se sirven directamente desde `static/data/` sin ningún servidor Python. El frontend carga las rutas ya computadas y las anima. Interfaz: `static/app.js` + `static/index.html`. Desplegable en cualquier hosting estático (GitHub Pages, Nginx, etc.).

La documentación de arquitectura interna detallada (diseño del grafo, surgical flood cut, heurística A*, decisiones de diseño del frontend) está en `documentation.md`.

---

## 2. Stack tecnológico

### Backend (modo Flask)
| Librería | Uso |
|---|---|
| Flask | Servidor HTTP, endpoints API |
| NetworkX | Grafo de routing, A*, Dijkstra |
| GeoPandas / Shapely | Spatial joins, cortes de flood en fronteras exactas, clasificación de edificios |
| pyproj | Reproyección EPSG:25832 → WGS84 en tiempo de respuesta |
| scipy KDTree | Búsqueda del edificio seguro más próximo (emergency routing) |
| numpy | Operaciones vectoriales sobre coordenadas |
| gunicorn | Servidor WSGI de producción |
| pyarrow | Serialización GeoParquet (dependencia de GeoPandas) |

### Pipeline Hamburg (adicional)
| Librería | Uso |
|---|---|
| rasterio | Vectorización de GeoTIFF HWRM por bloques — no tiene alternativa directa en GeoPandas |

### Frontend
| Librería | Versión | Uso |
|---|---|---|
| Leaflet | 1.7.1 | Mapa base, capas GeoJSON, marcadores |
| Leaflet.VectorGrid | latest | Renderizado de flood polygons como vector tiles |
| leaflet-ant-path | 1.3.0 | Animación de flujo (fase 2 ruta segura) |
| leaflet.motion | 0.3.2 | Dibujado progresivo (fase 1 ruta segura) |

Sin bundler, sin framework JS. Vanilla HTML/CSS/JS servido desde `static/`.

---

## 3. Estructura de archivos y carpetas

```
flood_web_app/
│
├── app.py                  # Servidor Flask: endpoints API, lógica de routing y directions
├── cache.py                # Carga y serialización en RAM de los datasets al arranque
├── wsgi.py                 # Entry point para gunicorn (production)
├── requirements.txt        # Dependencias Python
├── documentation.md        # Arquitectura interna detallada (no modificar como docs de código)
│
├── static/
│   ├── index.html          # Frontend demo estático (sin API Flask)
│   ├── app.js              # Lógica demo estático: carga static/data/, animación de rutas
│   ├── index_original.html # Backup local del frontend modo Flask (no trackeado por git)
│   ├── app_original.js     # Backup local de la lógica modo Flask (no trackeado por git)
│   └── data/               # Ficheros precalculados para el demo estático
│       ├── buildings.geojson       # Polígonos de edificios con flood_status
│       ├── flood.geojson           # Polígonos de inundación (simplificados)
│       ├── flooded_segments.geojson # Tramos de calle anegados
│       ├── route_safe.json         # Ruta segura precalculada (evita flood)
│       └── route_direct.json       # Ruta directa precalculada (cruza flood)
│
├── datasets/               # Datasets para el modo Flask (excluido del repo — demasiado grande)
│   └── <nombre>/
│       ├── G.pkl           # Grafo NetworkX serializado (pickle)
│       ├── buildings.geojson
│       └── flood.geojson
│
├── templates/              # Carpeta vacía (.gitkeep) — reservada para Jinja2 si se necesita
├── .gitignore
├── README.md
├── README_deploy.md        # Instrucciones de despliegue con reverse proxy y PUBLIC_BASE_PATH
└── CLAUDE.md               # Este archivo
```

**Ficheros no trackeados por git (presentes en disco, ignorados):**
- `datasets/` — demasiado grandes para GitHub
- `static/app_original.js` y `static/index_original.html` — backups locales de referencia

---

## 4. Flujo de datos — desde la fuente hasta la visualización

### Modo Flask (backend dinámico)

```
prepare_datasets.py (externo al repo)
    ↓ genera
datasets/<nombre>/G.pkl + buildings.geojson + flood.geojson
    ↓ carga al arranque (cache.py)
RAM: CACHE dict con G, bbox, buildings_geojson (str), flood_geojson (str), safe_kdtree
    ↓ endpoints Flask (app.py)
/api/buildings  → devuelve buildings_geojson string pre-serializado (0 work en request)
/api/flood      → devuelve flood_geojson string pre-serializado (0 work en request)
/api/route      → A* sobre G → path_geojson + directions + stats
    ↓ fetch() en app_original.js
Leaflet renderiza capas + polilínea de ruta con colores por flood status
```

### Modo demo estático

```
static/data/buildings.geojson + flood.geojson + flooded_segments.geojson
static/data/route_safe.json + route_direct.json
    ↓ fetch() en app.js (init())
Leaflet renderiza edificios y flood polygons
    ↓ usuario pulsa botón de ruta
toggleRoute('safe' | 'direct') carga el JSON correspondiente
    → safe: L.motion.polyline (0–3 s) → L.polyline.antPath + pin pulsante
    → direct: polilíneas estáticas segmento a segmento con color por flood status
```

### Estructura de `route_safe.json` / `route_direct.json`

Estos ficheros deben tener exactamente estos campos para ser compatibles con `app.js`:

```json
{
  "found": true,
  "from": "B_11490",
  "to": "B_10796",
  "total_cost": 4821.3,
  "road_segments": 23,
  "flooded_segments": 0,
  "from_status": "drowned",
  "to_status": "safe",
  "bbox": [13.21, 52.48, 13.35, 52.56],
  "path_geojson": {
    "type": "FeatureCollection",
    "features": [
      {
        "type": "Feature",
        "geometry": { "type": "LineString", "coordinates": [[lon, lat], ...] },
        "properties": { "flooded": false, "length": 143.2 }
      }
    ]
  },
  "directions": [
    { "action": "start", "heading": "north" },
    { "action": "turn_right", "distance_m": 320 },
    { "action": "arriving", "distance_m": 85 },
    { "action": "arrive", "side": "left" }
  ],
  "access_from": { "node": "R123456", "coordinates": [lon, lat] },
  "access_to":   { "node": "R654321", "coordinates": [lon, lat] }
}
```

El campo `bbox` es específico del modo demo (no lo devuelve la API Flask). Se usa en `init()` para centrar el mapa.

---

## 5. Datasets actuales y su origen

### Brandenburg — enero 2024 (activo)

| Capa | Fuente | Tamaño original | Notas |
|---|---|---|---|
| Flood mask | Copernicus EMS EMSN068 | ~109 MB GeoJSON | Simplificado a 0.00001° (~8 m) → ~13 MB para frontend |
| Edificios | Geofabrik OSM Brandenburg | 76.950 polígonos | Clipeados al bounding box del flood |
| Red viaria | Geofabrik `.osm.pbf` + osmium/OSMnx | — | Extraída al bounding box del evento |

**Demo estático**: bounding box reducido a la ruta Stolpe → Oranienburg (`B_11490` → `B_10796`).

---

### Hamburg HWRM — Küstenhochwasser y Binnenhochwasser

Fuente: Geoportal Hamburg, Hochwasserrisikomanagement 3er ciclo 2025.
URL: https://geoportal-hamburg.de/hochwasserrisikomanagement/

El CRS nativo de todos los datos Hamburg es EPSG:25832 — no requiere reproyección antes del procesamiento. A diferencia de Brandenburg (observación SAR real Copernicus EMS), los datos Hamburg son modelos hidráulicos HWRM — no representan un evento ocurrido sino escenarios de riesgo proyectados.

Tabla de nomenclatura de escenarios:

| Tipo | Escenario | Código GeoTIFF | Descripción |
|---|---|---|---|
| Küstenhochwasser | Extrem E | `wt_cw_l.tif` | Sin diques, nivel 7.68 m NHN en St. Pauli |
| Küstenhochwasser | Mittel M | `wt_cw_m.tif` | Período de retorno ~100 años |
| Küstenhochwasser | Häufig H | `wt_cw_h.tif` | Período de retorno ~20 años |
| Binnenhochwasser | Extrem E | `wt_rw_l.tif` | — |
| Binnenhochwasser | Mittel M | `wt_rw_m.tif` | — |
| Binnenhochwasser | Häufig HQ10 | `wt_rw_h.tif` | Período de retorno ~10 años |

#### Datasets Hamburg activos

**`hamburg_harburg_test`** — Küstenhochwasser Extrem E, área Harburg (activo)

| Capa | Fuente | Notas |
|---|---|---|
| Flood mask | GeoTIFF `wt_cw_l.tif` vectorizado con rasterio | bbox EPSG:25832: `(556000, 5924000, 566000, 5932000)` |
| Flood polygons | 2094 polígonos tras vectorización | `depth_m` values: 0.25 / 0.75 / 1.5 / 3.0 / 5.0 m |
| Edificios | OSM Hamburg filtrado con STRtree buffer 500m | 42758 edificios |
| Red viaria | osmium polygon buffer 1km sobre bbox flood | Extraída por polígono, no bbox rectangular |

**`hamburg_river_flood_frequent`** — Binnenhochwasser Häufig HQ10, toda Hamburg (activo)

| Capa | Fuente | Notas |
|---|---|---|
| Flood mask | GeoTIFF `wt_rw_h.tif` vectorizado con rasterio | Cubre toda Hamburg |
| Flood polygons | 1156 polígonos | `depth_m` values: 0.25 / 0.75 / 1.5 / 3.0 / 5.0 m |
| Edificios | OSM Hamburg filtrado con STRtree buffer 500m | 58993 edificios |
| Red viaria | osmium polygon buffer 1km | Extraída por polígono |

#### Datasets Hamburg pendientes

| Nombre previsto | GeoTIFF | Estado |
|---|---|---|
| `hamburg_river_flood_medium` | `wt_rw_m.tif` | Pendiente |
| `hamburg_river_flood_extreme` | `wt_rw_l.tif` | Pendiente |
| `hamburg_coastal_frequent` | `wt_cw_h.tif` | Pendiente |
| `hamburg_coastal_medium` | `wt_cw_m.tif` | Pendiente |

---

## 6. Cómo añadir un nuevo dataset

### Modo Flask (flujo clásico — shapefile o GeoJSON)

1. Ejecutar `prepare_datasets.py` (externo al repo) con los inputs del nuevo evento: flood shapefile, bounding box, y fuente OSM. El script genera `G.pkl`, `buildings.geojson` y `flood.geojson`.
2. Copiar la carpeta resultante a `datasets/<nombre>/`.
3. Reiniciar el servidor — `cache.py` escanea `datasets/` al arranque y carga todo lo que encuentre.
4. Alternativa sin reinicio: `POST /api/add_dataset` (prototipo) — ejecuta el pipeline completo síncronamente en el request thread (~15 min), bloquea el proceso durante ese tiempo.

### Pipeline Hamburg (flujo GeoTIFF HWRM)

Los datos Hamburg llegan como GeoTIFF de profundidad de agua, no como vectores. El pipeline adaptado tiene estos pasos:

1. **Descargar GeoTIFF** desde Geoportal Hamburg HWRM (descarga manual desde el geoportal — URL en §5). Fichero de entrada: `wt_*.tif`.
2. **Subir a Colab** manualmente (Google Drive o upload directo). Colab gratuito dispone de ~12GB RAM — no intentar cargar el OSM de toda Hamburg en memoria a la vez; el kernel colapsa. Usar siempre extracción por polígono.
3. **Vectorizar con rasterio** por bloques (`block_size=5000`) para controlar el uso de RAM. Cada píxel no-nulo del raster se convierte en un polígono con su valor de `depth_class`.
4. **Mapear `depth_class → depth_m`** con `DEPTH_MAP`:

   | depth_class | depth_m | Rango |
   |---|---|---|
   | 11 | 0.25 | 0 – 0.5 m |
   | 12 | 0.75 | 0.5 – 1.0 m |
   | 13 | 1.5 | 1.0 – 2.0 m |
   | 14 | 3.0 | 2.0 – 4.0 m |
   | 15 | 5.0 | > 4.0 m |

5. **Reparar topología** con `buffer(0)` (corrige geometrías inválidas del raster) y `simplify(5)` (5m en EPSG:25832). Esto reduce el número de vértices manteniendo ~5m de precisión.
6. **Filtrar edificios** con STRtree buffer 500m sobre el área de inundación — garantiza cobertura sin cargar todos los edificios de Hamburg.
7. **Extraer red viaria** con osmium usando el polígono del flood con buffer 1km — extracción por polígono, no por bbox rectangular, para seguir la forma real del área inundada.
8. **Pipeline estándar** desde aquí: spatial joins de clasificación de edificios, surgical flood cut, serialización a `G.pkl` + GeoJSONs, copiar a `datasets/<nombre>/`.

### Modo demo estático

1. Con el modo Flask activo para el dataset objetivo, hacer las peticiones a la API y guardar las respuestas como JSON:
   - `GET /api/buildings?dataset=<nombre>` → `static/data/buildings.geojson`
   - `GET /api/flood?dataset=<nombre>` → `static/data/flood.geojson`
   - `GET /api/flooded_segments?dataset=<nombre>` → `static/data/flooded_segments.geojson`
   - `GET /api/route?dataset=<nombre>&from=<bid_origen>&to=<bid_destino>` (×2) → `route_safe.json` y `route_direct.json`
2. Añadir el campo `"bbox": [minx, miny, maxx, maxy]` manualmente a cada JSON de ruta (la API no lo incluye; está en `/api/bbox`).
3. Actualizar el subtítulo del header en `static/index.html`:
   ```html
   <div style="font-size:11px;color:#888;margin-top:4px;">Demo: NombreOrigen → NombreDestino</div>
   ```
4. No es necesario tocar `app.js` salvo que cambie la estructura del JSON.

---

## 7. Convenciones y reglas del proyecto

### Identificadores de nodos

| Prefijo | Tipo | Ejemplo |
|---|---|---|
| `B_` | Building node | `B_11490` |
| `R` | Road node (OSM original) | `R123456789` |
| `CUT_` | Nodo de corte en frontera de flood | `CUT_R123_R456_0` |
| `F_` | Flood polygon node (metadata, sin edges) | `F_42` |

### CRS y unidades

- Datos internos del grafo: **EPSG:25832** (metros). Los atributos `x`/`y` de los nodos de calle están en esta proyección.
- Todo lo que sale al frontend: **EPSG:4326** (WGS84, grados). La reproyección la hace `_transformer` en `app.py` usando pyproj.
- El CRS nativo de los datos Hamburg HWRM es EPSG:25832 — no requiere reproyección antes del procesamiento en el pipeline.
- Distancias de routing: metros. `routing_cost = length` en metros para segmentos secos; `routing_cost = INF` para anegados o longitud desconocida.

### Reglas del backend

- Los endpoints Flask nunca hacen I/O en tiempo de request: solo leen de RAM (`CACHE` dict).
- El grafo `G` es un `networkx.Graph` no dirigido — las edges pueden estar almacenadas en cualquier dirección; el routing maneja esto correctamente.
- La clasificación de edificios es mutuamente excluyente y se asigna por severidad creciente: `drowned` > `close_to` > `at_risk` > `safe`.
- `rasterio` está justificado como única librería adicional del pipeline Hamburg — vectoriza GeoTIFF por bloques sin alternativa directa en GeoPandas.
- Precisión de polígonos Hamburg: GeoTIFF 1m/píxel + `simplify(5)` = ~5m de precisión geométrica. Suficiente para routing y visualización.
- Los datos Hamburg son modelos hidráulicos HWRM 3er ciclo 2025, no observaciones reales. Brandenburg usa Copernicus EMS EMSN068 (SAR real). Esta diferencia es relevante para interpretar la cobertura y la fiabilidad de los datos.
- STRtree buffer 500m para edificios + osmium polygon buffer 1km para red viaria — garantiza cobertura completa del área de inundación sin cargar datasets de toda Hamburg en RAM.
- Colab gratuito tiene ~12GB RAM. El fichero `.osm.pbf` de Hamburg completa pesa ~850MB y colapsa el kernel al procesarlo en memoria. Usar siempre extracción por polígono con osmium.

### Reglas del frontend

- El frontend demo (`app.js`) no tiene estado de selección de edificios — no hay `originBid`, `destBid` ni `selectionMode`. Solo toggle de rutas precalculadas.
- Las rutas safe y direct tienen estado independiente: se pueden mostrar simultáneamente.
- El timeout de animación de la ruta segura (`safeRoutePolylines._animTimeout`) debe cancelarse explícitamente antes de limpiar el mapa — está implementado en `clearRoutes()` y en el toggle-off de la ruta.
- No añadir librerías nuevas al frontend sin justificación explícita — cada librería nueva es una dependencia CDN que puede fallar o cambiar de versión.

### Reglas de git

- `datasets/` nunca va al repositorio (ficheros demasiado grandes).
- `static/app_original.js` y `static/index_original.html` son backups locales — no deben trackearse. Añadir al `.gitignore` si se regeneran.
- Los ficheros en `static/data/` sí van al repositorio (son los datos del demo estático, tamaño razonable).

---

## 8. Próximos pasos planificados

### Inmediatos
- Añadir `static/app_original.js` y `static/index_original.html` al `.gitignore` para que no reaparezcan como untracked tras regenerarlos.

### Dataset Hamburg HWRM
- Completar `hamburg_river_flood_medium` y `hamburg_river_flood_extreme` (GeoTIFF `wt_rw_m.tif` y `wt_rw_l.tif`).
- Añadir Küstenhochwasser Häufig (`wt_cw_h.tif`) y Mittel (`wt_cw_m.tif`) como datasets.
- Automatizar descarga de GeoTIFF desde Geoportal Hamburg (actualmente descarga manual — resolver vía WFS/OGC API).
- Automatizar subida a Google Drive para que el pipeline sea reproducible sin pasos manuales entre sesiones de Colab.
- Fase 3 profundidad de routing: `routing_cost` ya es proporcional a `depth_m` en el grafo; pendiente visualización de profundidad en los segmentos de ruta en el frontend.

### Mejoras de arquitectura
- Soporte multi-dataset en el modo demo estático: selector de escenario + ficheros JSON por escenario en `static/data/<nombre>/`.
- Mover el pipeline `prepare_datasets.py` al repositorio para que el flujo completo (descarga → procesamiento → serialización) sea reproducible desde cero.
- Añadir una cola de tareas (Celery + Redis) para que `POST /api/add_dataset` no bloquee el proceso Flask durante el procesamiento (~15 min por dataset).

---

## 9. Arquitectura de capas frontend (app_original.js)

Documentación de las capas adicionales implementadas en `static/app_original.js` y sus dependencias en el backend.

### `depthLayer` — profundidad del agua por color

```javascript
depthLayer = L.geoJSON(floodGeoJSON, {
  style: function(feature) {
    const depth = feature.properties.depth_m;
    const color = DEPTH_COLORS[depth] || '#2171b5';
    return { fillColor: color, fillOpacity: 0.7, color: color, weight: 0.3, opacity: 0.8 };
  },
  interactive: false
});
```

- Usa el **mismo GeoJSON** que `floodLayer` (ya disponible en `loadDataset()`), sin petición adicional al servidor.
- La función de estilo accede a `feature.properties.depth_m` (valores discretos: 0.25, 0.75, 1.5, 3.0, 5.0) y lo mapea con la constante `DEPTH_COLORS`.
- Toggle "Water depth" en sidebar — **desactivado por defecto**.
- **Dependencia en `cache.py`**: `_gdf_to_geojson_str(flood_display, ["fid", "depth_m"])` — `depth_m` debe estar incluido en la serialización del flood GeoJSON. Si se elimina, `depthLayer` muestra todo en el color fallback `#2171b5`.

Paleta de colores:

| depth_m | Color | Rango |
|---|---|---|
| 0.25 | `#c6dbef` | 0 – 0.5 m |
| 0.75 | `#6baed6` | 0.5 – 1.0 m |
| 1.5 | `#2171b5` | 1.0 – 2.0 m |
| 3.0 | `#f16913` | 2.0 – 4.0 m |
| 5.0 | `#d73027` | > 4.0 m |

### `boundaryLayer` — límite administrativo de la ciudad

```javascript
async function loadHamburgBoundary() {
  if (boundaryLayer) return; // cargado una sola vez por sesión
  const url = 'https://nominatim.openstreetmap.org/search?q=Hamburg,Germany'
            + '&format=geojson&polygon_geojson=1&limit=1';
  const data = await fetch(url).then(r => r.json());
  boundaryLayer = L.geoJSON(data, {
    style: { color: '#1a1a1a', weight: 2, fillOpacity: 0, opacity: 0.8 },
    interactive: false
  });
}
```

- Se carga **una sola vez** por sesión (guard `if (boundaryLayer) return`) desde Nominatim — sin coste adicional al cambiar de dataset Hamburg.
- Se activa automáticamente cuando `name.toLowerCase().includes('hamburg')` al final del bloque `try` de `loadDataset()`. Se elimina del mapa y se resetea si se carga un dataset no-Hamburg.
- Toggle "City boundary" en sidebar — **activado por defecto**.
- Estilo: borde negro `#1a1a1a`, `weight: 2`, sin relleno (`fillOpacity: 0`).
- Si Nominatim no responde, el error se captura silenciosamente con `console.warn` — la capa simplemente no aparece, sin romper el resto de la UI.

### `bezirkeLayer` — límites de los 7 Bezirke de Hamburg

```javascript
bezirkeLayer = L.geoJSON(geojson, {
  style: { color: '#444444', weight: 1.5, fillOpacity: 0, opacity: 0.7, dashArray: '6,4' },
  onEachFeature: function(feature, layer) {
    const name = feature.properties && feature.properties.name;
    if (name) layer.bindTooltip(name, { permanent: true, direction: 'center', className: 'bezirk-label' });
  },
  interactive: false
});
```

- Datos precargados desde **`static/data/hamburg_bezirke.geojson`** (72 KB) — no requiere llamada a Overpass en tiempo de carga.
- Fichero generado vía Nominatim (7 peticiones individuales por Bezirk) y guardado estáticamente. Los 7 Bezirke: Hamburg-Mitte (MultiPolygon), Altona, Eimsbüttel, Hamburg-Nord, Wandsbek, Bergedorf, Harburg.
- Se carga con `fetch(APP_BASE + '/static/data/hamburg_bezirke.geojson')` — misma convención de paths que el resto de `app_original.js`.
- Tooltips permanentes centrados con clase `.bezirk-label` (fondo transparente, 11px, `font-weight: 600`).
- Toggle "Bezirke" en sidebar — **activado por defecto**.
- No requiere la librería `osmtogeojson` — el GeoJSON viene directamente de Nominatim en formato estándar.
- Se activa/limpia junto con `boundaryLayer` en el bloque Hamburg/non-Hamburg de `loadDataset()`.
