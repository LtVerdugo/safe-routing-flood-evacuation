import heapq
import math
import os
import sys
from pathlib import Path
from shapely import wkt as shapely_wkt

import numpy as np
from scipy.spatial import KDTree

import networkx as nx
from flask import Flask, Response, jsonify, send_from_directory, request
from pyproj import Transformer

# Ensure pipeline and cache are importable when run from any directory
sys.path.insert(0, str(Path(__file__).parent))

import cache

PUBLIC_BASE_PATH = os.environ.get("PUBLIC_BASE_PATH", "").strip()
if PUBLIC_BASE_PATH and not PUBLIC_BASE_PATH.startswith("/"):
    PUBLIC_BASE_PATH = f"/{PUBLIC_BASE_PATH}"
PUBLIC_BASE_PATH = PUBLIC_BASE_PATH.rstrip("/")
if PUBLIC_BASE_PATH == "/":
    PUBLIC_BASE_PATH = ""

app = Flask(
    __name__,
    template_folder='static',
    static_url_path=(
        f"{PUBLIC_BASE_PATH}/static" if PUBLIC_BASE_PATH else "/static"
    ),
)
app.config["APPLICATION_ROOT"] = PUBLIC_BASE_PATH or "/"


def app_route(rule: str, **options):
    """Register a route with an optional public URL prefix alias."""
    def decorator(func):
        app.route(rule, **options)(func)
        if PUBLIC_BASE_PATH:
            app.route(f"{PUBLIC_BASE_PATH}{rule}", **options)(func)
            if rule == "/":
                app.route(PUBLIC_BASE_PATH, **options)(func)
        return func
    return decorator


_BASE_DIR = str(Path(__file__).parent / "datasets")

# Load all serialized datasets into memory at startup.
cache.load_all_datasets(_BASE_DIR)

# Single transformer instance reused across requests (thread-safe in pyproj).
_transformer = Transformer.from_crs("EPSG:25832", "EPSG:4326", always_xy=True)


def _node_lonlat(node_data):
    """Return (lon, lat) in WGS84 for any node type."""
    if 'x' in node_data and 'y' in node_data:
        lon, lat = _transformer.transform(node_data['x'], node_data['y'])
        return lon, lat
    elif 'wkt' in node_data:
        geom = shapely_wkt.loads(node_data['wkt'])
        cx, cy = geom.centroid.x, geom.centroid.y
        lon, lat = _transformer.transform(cx, cy)
        return lon, lat
    return None, None


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _require_dataset():
    """Validate the ?dataset= query parameter. Returns (entry, None) or (None, error_response)."""
    name = request.args.get("dataset")
    if not name:
        return None, (jsonify({"error": "dataset parameter required"}), 400)
    try:
        return cache.get_dataset(name), None
    except KeyError:
        return None, (jsonify({"error": "dataset not found"}), 404)


def _reproject_linestring(geom):
    """Convert a Shapely LineString (EPSG:25832) to a [[lon, lat], ...] coordinate list."""
    return [list(_transformer.transform(x, y)) for x, y in geom.coords]


def _bearing(p1, p2):
    """Compass bearing in degrees [0, 360) from p1=[lon,lat] to p2=[lon,lat] (WGS84)."""
    lat1 = math.radians(p1[1])
    lon1 = math.radians(p1[0])
    lat2 = math.radians(p2[1])
    lon2 = math.radians(p2[0])
    dlon = lon2 - lon1
    x = math.sin(dlon) * math.cos(lat2)
    y = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _turn_direction(b1, b2):
    """Returns 'turn_right', 'turn_left', or 'straight' given two compass bearings."""
    diff = (b2 - b1 + 360) % 360
    if diff > 180:
        diff -= 360  # normalise to -180..180
    if diff > 20:
        return "turn_right"
    elif diff < -20:
        return "turn_left"
    else:
        return "straight"


def _bearing_to_cardinal(deg):
    labels = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
    return labels[round(deg / 45) % 8]


def _compute_directions(path_geojson, dest_lonlat=None, access_from_lonlat=None):
    """Build turn-by-turn directions, grouping consecutive straight segments."""
    features = path_geojson.get("features", [])
    if not features:
        return []

    segments = []
    for f in features:
        if f.get("geometry") is None:
            continue
        coords = f["geometry"]["coordinates"]
        length = round(f["properties"].get("length", 0))
        if len(coords) >= 2:
            segments.append((coords, length))

    if not segments:
        return []

    # Fix first segment orientation using access_from as reference.
    if access_from_lonlat and access_from_lonlat[0] is not None and len(segments) > 0:
        access_lon, access_lat = access_from_lonlat
        seg0_start = segments[0][0][0]
        seg0_end   = segments[0][0][-1]
        dist_start = abs(seg0_start[0] - access_lon) + abs(seg0_start[1] - access_lat)
        dist_end   = abs(seg0_end[0]   - access_lon) + abs(seg0_end[1]   - access_lat)
        if dist_end < dist_start:
            segments[0] = (list(reversed(segments[0][0])), segments[0][1])

    # Fix inverted segments: graph edges may be stored in either direction.
    # Ensure each segment starts where the previous one ended.
    for i in range(1, len(segments)):
        prev_end   = segments[i - 1][0][-1]
        curr_start = segments[i][0][0]
        curr_end   = segments[i][0][-1]
        if curr_start != prev_end and curr_end == prev_end:
            segments[i] = (list(reversed(segments[i][0])), segments[i][1])

    directions = []

    p0 = segments[0][0][0]
    p1 = segments[0][0][1]
    if p0 is None or p1 is None or None in p0 or None in p1:
        return []
    first_bearing = _bearing(p0, p1)
    directions.append({"action": "start", "heading": _bearing_to_cardinal(first_bearing)})

    accumulated_distance = segments[0][1]

    for i in range(1, len(segments)):
        prev_coords = segments[i - 1][0]
        curr_coords = segments[i][0]

        if len(prev_coords) < 2 or len(curr_coords) < 2:
            accumulated_distance += segments[i][1]
            continue

        p1 = prev_coords[-2]
        p2 = prev_coords[-1]
        p3 = curr_coords[0]
        p4 = curr_coords[1]

        if None in (p1, p2, p3, p4) or None in p1 or None in p2 or None in p3 or None in p4:
            accumulated_distance += segments[i][1]
            continue

        b1   = _bearing(p1, p2)
        b2   = _bearing(p3, p4)
        turn = _turn_direction(b1, b2)

        if turn in ("turn_right", "turn_left"):
            directions.append({"action": turn, "distance_m": accumulated_distance})
            accumulated_distance = segments[i][1]
        else:
            accumulated_distance += segments[i][1]

    if accumulated_distance > 0:
        directions.append({"action": "arriving", "distance_m": accumulated_distance})

    last_coords = segments[-1][0]
    if len(last_coords) >= 2:
        final_bearing = _bearing(last_coords[-2], last_coords[-1])
    else:
        final_bearing = _bearing(last_coords[0], last_coords[0])

    if dest_lonlat and dest_lonlat[0] is not None:
        dest_lon, dest_lat = dest_lonlat
        last_node_coords = last_coords[-1]
        bearing_to_dest = _bearing(last_node_coords, [dest_lon, dest_lat])
        angle_diff = (bearing_to_dest - final_bearing + 360) % 360
        if angle_diff > 180:
            angle_diff -= 360
        side = "right" if angle_diff > 0 else "left"
    else:
        side = None

    directions.append({"action": "arrive", "side": side})
    return directions


def find_emergency_route(G, from_bid, kdtree=None, safe_bids=None):
    """Find nearest safe building.

    If a KDTree is provided, probe the k nearest safe buildings with A* and
    return the cheapest reachable one.  Falls back to full Dijkstra when the
    KDTree is unavailable or all candidates are unreachable.
    """
    if kdtree is not None and safe_bids:
        from_data = G.nodes[from_bid]
        if 'wkt' in from_data:
            geom = shapely_wkt.loads(from_data['wkt'])
            fx, fy = geom.centroid.x, geom.centroid.y
        else:
            fx, fy = from_data.get('x', 0), from_data.get('y', 0)

        k = min(3, len(safe_bids))
        _, idxs = kdtree.query([fx, fy], k=k)
        if isinstance(idxs, (int, np.integer)):
            idxs = [idxs]

        def heuristic(u, v):
            u_d = G.nodes[u]; v_d = G.nodes[v]
            return ((u_d.get('x', 0) - v_d.get('x', 0)) ** 2 +
                    (u_d.get('y', 0) - v_d.get('y', 0)) ** 2) ** 0.5

        best_path, best_cost = None, float("inf")
        for idx in idxs:
            target = safe_bids[idx]
            try:
                path = nx.astar_path(G, from_bid, target, heuristic=heuristic, weight="routing_cost")
                cost = nx.path_weight(G, path, weight="routing_cost")
                if cost < best_cost:
                    best_path, best_cost = path, cost
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                continue
        if best_path is not None:
            return best_path, best_cost

    # Full Dijkstra fallback.
    dist = {from_bid: 0}
    prev = {from_bid: None}
    heap = [(0, from_bid)]

    while heap:
        cost, node = heapq.heappop(heap)
        if cost > dist.get(node, float("inf")):
            continue
        node_data = G.nodes[node]
        if (node != from_bid
                and node_data.get("node_type") == "building"
                and node_data.get("flood_status") == "safe"):
            path = []
            cur = node
            while cur is not None:
                path.append(cur)
                cur = prev[cur]
            return list(reversed(path)), cost

        for neighbor in G.neighbors(node):
            edge_data = G.get_edge_data(node, neighbor)
            edge_cost = edge_data.get("routing_cost", float("inf"))
            if edge_cost == float("inf"):
                continue
            new_cost = cost + edge_cost
            if new_cost < dist.get(neighbor, float("inf")):
                dist[neighbor] = new_cost
                prev[neighbor] = node
                heapq.heappush(heap, (new_cost, neighbor))

    return None, float("inf")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app_route("/")
def index():
    return send_from_directory(app.static_folder, "index_original.html")


@app_route("/api/datasets")
def api_datasets():
    return jsonify({"datasets": cache.list_datasets()})


@app_route("/api/buildings")
def api_buildings():
    ds, err = _require_dataset()
    if err:
        return err
    return Response(ds["buildings_geojson"], mimetype="application/json")


@app_route("/api/flood")
def api_flood():
    ds, err = _require_dataset()
    if err:
        return err
    return Response(ds["flood_geojson"], mimetype="application/json")


@app_route("/api/bbox")
def api_bbox():
    ds, err = _require_dataset()
    if err:
        return err
    return jsonify({"bbox": ds["bbox"]})


@app_route("/api/flooded_segments")
def api_flooded_segments():
    ds, err = _require_dataset()
    if err:
        return err

    G = ds["G"]

    features = []
    for u, v, data in G.edges(data=True):
        if not data.get("flooded"):
            continue
        geom = data.get("geometry")
        if geom is None:
            continue
        coords = [list(_transformer.transform(x, y)) for x, y in geom.coords]
        features.append({
            "type": "Feature",
            "geometry": {"type": "LineString", "coordinates": coords},
            "properties": {"length": data.get("length", 0)}
        })

    return jsonify({"type": "FeatureCollection", "features": features})


@app_route("/api/route")
def api_route():
    try:
        ds, err = _require_dataset()
        if err:
            return err

        from_bid = request.args.get("from")
        to_bid   = request.args.get("to")   # optional explicit destination
        if not from_bid:
            return jsonify({"error": "from parameter required"}), 400

        G = ds["G"]

        if from_bid not in G:
            return jsonify({"error": f"node '{from_bid}' not found in graph"}), 404

        if to_bid and to_bid not in G:
            return jsonify({"error": f"node '{to_bid}' not found in graph"}), 404

        # A* heuristic: euclidean distance in EPSG:25832 metres.
        # Road nodes carry x/y; building and flood nodes do not — return 0 for those.
        def heuristic(u, v):
            u_data = G.nodes[u]
            v_data = G.nodes[v]
            ux, uy = u_data.get("x", 0), u_data.get("y", 0)
            vx, vy = v_data.get("x", 0), v_data.get("y", 0)
            return ((ux - vx) ** 2 + (uy - vy) ** 2) ** 0.5

        if to_bid:
            # Direct A* to the caller-specified destination.
            try:
                best_path   = nx.astar_path(G, from_bid, to_bid, heuristic=heuristic, weight="routing_cost")
                best_cost   = nx.path_weight(G, best_path, weight="routing_cost")
                best_target = to_bid
            except (nx.NetworkXNoPath, nx.NodeNotFound):
                return jsonify({"found": False, "reason": "no path between the two buildings"})
        else:
            kdtree   = ds.get("safe_kdtree")
            safe_bids = ds.get("safe_bids", [])
            best_path, best_cost = find_emergency_route(G, from_bid, kdtree, safe_bids)
            if best_path is None:
                return jsonify({"found": False, "reason": "no path to safe building"})
            best_target = best_path[-1]

        # Build path GeoJSON — skip access edges that carry no geometry.
        features = []
        flooded_count = 0

        for i in range(len(best_path) - 1):
            u, v = best_path[i], best_path[i + 1]
            edge_data = G[u][v]

            if edge_data.get("flooded", False):
                flooded_count += 1

            geom = edge_data.get("geometry")
            if geom is None:
                continue

            features.append({
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": _reproject_linestring(geom),
                },
                "properties": {
                    "flooded": edge_data.get("flooded", False),
                    "length": edge_data.get("length", 0),
                },
            })

        # Access node coordinates for the frontend yellow dashed lines.
        # path structure: [from_bid, access_node_1, ..., access_node_2, to_bid]
        access_from_node = best_path[1]  if len(best_path) > 2 else best_path[0]
        access_to_node   = best_path[-2] if len(best_path) > 2 else best_path[-1]

        af_lon, af_lat = _node_lonlat(G.nodes[access_from_node])
        at_lon, at_lat = _node_lonlat(G.nodes[access_to_node])

        from_status = G.nodes[from_bid].get("flood_status", None)
        to_status   = G.nodes[best_target].get("flood_status", None)

        path_geojson = {"type": "FeatureCollection", "features": features}
        dest_lonlat = _node_lonlat(G.nodes[best_target])
        access_from_lonlat = (af_lon, af_lat)
        directions = _compute_directions(
            path_geojson,
            dest_lonlat=dest_lonlat,
            access_from_lonlat=access_from_lonlat
        )

        return jsonify({
            "found": True,
            "from": from_bid,
            "to": best_target,
            "mode": "emergency" if not to_bid else "normal",
            "total_cost": best_cost,
            "road_segments": len(features),
            "flooded_segments": flooded_count,
            "from_status": from_status,
            "to_status": to_status,
            "path_geojson": {
                "type": "FeatureCollection",
                "features": features,
            },
            "directions": directions,
            "access_from": {"node": str(access_from_node), "coordinates": [af_lon, af_lat]} if af_lon is not None else None,
            "access_to":   {"node": str(access_to_node),   "coordinates": [at_lon, at_lat]} if at_lon is not None else None,
        })
    except Exception as e:
        app.logger.exception("Error in /api/route: %s", e)
        return jsonify({"error": str(e)}), 500


@app_route("/healthz")
def healthz():
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(debug=False, port=5000)
