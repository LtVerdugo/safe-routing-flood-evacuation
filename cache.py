# In-memory cache for loaded datasets.
# Structure:
# CACHE = {
#   "brandenburg": {
#       "G":                <networkx.Graph>,
#       "buildings":        <GeoDataFrame EPSG:4326>,
#       "flood":            <GeoDataFrame EPSG:4326>,
#       "bbox":             [minx, miny, maxx, maxy] WGS84,
#       "buildings_geojson": <str>,   # pre-built FeatureCollection JSON
#       "flood_geojson":     <str>,   # pre-built FeatureCollection JSON
#   },
#   ...
# }

import math
from pathlib import Path

import numpy as np
import pickle
import geopandas as gpd
from scipy.spatial import KDTree
from shapely import wkt as shapely_wkt

WGS84_CRS = "EPSG:4326"


def _load_dataset_from_disk(dataset_dir):
    """Load G.pkl, buildings.geojson and flood.geojson from disk."""
    dataset_dir = Path(dataset_dir)
    with open(dataset_dir / 'G.pkl', 'rb') as f:
        G = pickle.load(f)
    buildings_gdf = gpd.read_file(str(dataset_dir / 'buildings.geojson'))
    flood_gdf     = gpd.read_file(str(dataset_dir / 'flood.geojson'))
    return G, buildings_gdf, flood_gdf


def _gdf_to_geojson_str(gdf, prop_cols):
    """Serialize a GeoDataFrame to a GeoJSON FeatureCollection string.
    Only prop_cols are included as properties; geometry is kept as-is.
    Uses GeoDataFrame.to_json() which is vectorized and much faster than iterrows.
    """
    geom_col = gdf.geometry.name
    keep = [geom_col] + [c for c in prop_cols if c in gdf.columns]
    return gdf[keep].to_json(show_bbox=False, drop_id=True)

CACHE = {}


def load_all_datasets(base_dir="datasets"):
    """Scan base_dir for dataset folders containing G.pkl and load each into CACHE."""
    base_path = Path(base_dir)
    if not base_path.exists():
        print(f"[cache] Datasets directory not found: {base_dir} — no datasets loaded.")
        return

    candidates = sorted(d for d in base_path.iterdir() if d.is_dir() and (d / "G.pkl").exists() and not d.name.startswith('_'))

    if not candidates:
        print(f"[cache] No datasets found in {base_dir}.")
        return

    for dataset_dir in candidates:
        name = dataset_dir.name
        print(f"[cache] Loading dataset: {name} …")
        try:
            G, buildings_gdf, flood_gdf = _load_dataset_from_disk(dataset_dir)
            add_dataset(name, G, buildings_gdf, flood_gdf)
        except Exception as exc:
            print(f"[cache] ERROR loading '{name}': {exc}")


def add_dataset(name, G, buildings_gdf, flood_gdf):
    """Add a dataset to CACHE at runtime. GeoDataFrames are converted to EPSG:4326."""
    buildings_wgs84 = (
        buildings_gdf.to_crs(WGS84_CRS) if buildings_gdf.crs is not None else buildings_gdf
    )
    flood_wgs84 = (
        flood_gdf.to_crs(WGS84_CRS) if flood_gdf.crs is not None else flood_gdf
    )
    _flood_bounds = flood_wgs84.total_bounds  # array([nan, nan, nan, nan]) si vacío
    if len(flood_wgs84) > 0 and not any(math.isnan(v) for v in _flood_bounds):
        bbox = [float(x) for x in _flood_bounds]
    else:
        bbox = [float(x) for x in buildings_wgs84.total_bounds]

    # Pre-serialize GeoJSON strings once so endpoints can return them directly.
    print(f"[cache] Pre-serializing GeoJSON for '{name}' …")
    buildings_geojson = _gdf_to_geojson_str(
        buildings_wgs84, ["bid", "flood_status", "building_type", "depth_max_m", "depth_mean_m"]
    )

    # Simplify flood geometries for browser display — 0.0001° ≈ 8 m at German latitudes.
    # preserve_topology=False is fast and acceptable for visual-only polygons.
    flood_display = flood_wgs84.copy()
    flood_display.geometry = flood_wgs84.geometry.simplify(0.00001, preserve_topology=False)
    flood_display = flood_display[flood_display.geometry.notna() & ~flood_display.geometry.is_empty]
    flood_geojson = _gdf_to_geojson_str(flood_display, ["fid", "depth_m"])

    CACHE[name] = {
        "G":                G,
        "bbox":             bbox,
        "buildings_geojson": buildings_geojson,
        "flood_geojson":     flood_geojson,
    }

    # Pre-compute KDTree over safe building centroids for fast emergency routing.
    safe_bids = []
    safe_coords = []
    for node, data in G.nodes(data=True):
        if data.get('node_type') == 'building' and data.get('flood_status') == 'safe':
            if 'wkt' in data:
                geom = shapely_wkt.loads(data['wkt'])
                cx, cy = geom.centroid.x, geom.centroid.y
                safe_bids.append(node)
                safe_coords.append([cx, cy])
    CACHE[name]['safe_kdtree'] = KDTree(np.array(safe_coords)) if safe_coords else None
    CACHE[name]['safe_bids'] = safe_bids

    print(
        f"[cache] Stored '{name}' — "
        f"{G.number_of_nodes():,} nodes, {G.number_of_edges():,} edges, "
        f"{len(buildings_wgs84):,} buildings, bbox={[round(c, 4) for c in bbox]}"
    )


def get_dataset(name):
    """Return the cache entry for name. Raises KeyError if not found."""
    if name not in CACHE:
        raise KeyError(f"Dataset '{name}' not found in cache.")
    return CACHE[name]


def list_datasets():
    """Return a list of dataset names currently in cache."""
    return list(CACHE.keys())
