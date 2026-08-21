"""트립별 도로망 최단경로 → 세그먼트 통행량 GeoJSON 8슬라이스.

슬라이스: 주중(wd)/주말(we) × 시간대 0:새벽(0-6) 1:오전(6-12) 2:오후(12-18) 3:저녁(18-24)
한계(대시보드에 명시): 최단경로는 실주행 경로가 아닌 추정.
실행: python scripts/build_flows.py [MIN_COUNT]  (그래프 다운로드 포함 수 분~수십 분)
osmnx 2.x API 기준: graph_from_bbox(bbox=(left, bottom, right, top)), ox.routing.shortest_path.
"""
import json
import os
import pickle
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from collections import Counter
import numpy as np
import osmnx as ox

from build_data import load_clean

BBOX = (-74.05, 40.60, -73.75, 40.88)  # (west, south, east, north) 핵심 운행 대역
MIN_COUNT = 3          # 이 미만 통행 세그먼트는 출력 제외 (용량·노이즈 컷)
CACHE_GRAPH = "cache/nyc_drive.graphml"
CACHE_COUNTS = "cache/segment_counts.pkl"  # 라우팅 결과 캐시 (MIN_COUNT 재조정용)
CACHE_ROUTE_KM = "cache/route_km.json"     # 트립별 도로망 최단경로 거리 (build_data.py에서 조인)

def get_graph():
    if os.path.exists(CACHE_GRAPH):
        return ox.load_graphml(CACHE_GRAPH)
    G = ox.graph_from_bbox(BBOX, network_type="drive", simplify=True)
    os.makedirs("cache", exist_ok=True)
    ox.save_graphml(G, CACHE_GRAPH)
    return G

def build_counters(G):
    """트립 라우팅 → (슬라이스별 세그먼트 통행량 Counter, 트립별 경로 거리 dict).

    route_km은 {"index": [트립 id...], "route_km": [km...]} — 라우팅 성공 트립만 포함.
    """
    df = load_clean()
    m = (df.pickup_longitude.between(BBOX[0], BBOX[2]) & df.pickup_latitude.between(BBOX[1], BBOX[3])
         & df.dropoff_longitude.between(BBOX[0], BBOX[2]) & df.dropoff_latitude.between(BBOX[1], BBOX[3]))
    df = df[m].reset_index(drop=True)
    print(f"routing {len(df)} trips")
    orig = ox.distance.nearest_nodes(G, X=df.pickup_longitude.values, Y=df.pickup_latitude.values)
    dest = ox.distance.nearest_nodes(G, X=df.dropoff_longitude.values, Y=df.dropoff_latitude.values)
    routes = ox.routing.shortest_path(G, orig, dest, weight="length", cpus=None)

    wp = np.where(df.dow < 5, "wd", "we")
    band = (df.hour // 6).values
    ids = df.id.tolist()
    counters = {(w, b): Counter() for w in ("wd", "we") for b in range(4)}
    route_km = {"index": [], "route_km": []}
    for i, r in enumerate(routes):
        if r is None or len(r) < 2:
            continue
        c = counters[(wp[i], band[i])]
        km = 0.0
        for u, v in zip(r[:-1], r[1:]):
            c[(u, v)] += 1
            km += min(d["length"] for d in G.get_edge_data(u, v).values())
        route_km["index"].append(ids[i])
        route_km["route_km"].append(round(km / 1000.0, 4))
    print(f"routed {len(route_km['index'])}/{len(df)} trips")
    return counters, route_km

def main(min_count=MIN_COUNT):
    G = get_graph()
    if os.path.exists(CACHE_COUNTS) and os.path.exists(CACHE_ROUTE_KM):
        with open(CACHE_COUNTS, "rb") as f:
            counters = pickle.load(f)
        print("loaded segment counts from cache")
    else:
        counters, route_km = build_counters(G)
        os.makedirs("cache", exist_ok=True)
        with open(CACHE_COUNTS, "wb") as f:
            pickle.dump(counters, f)
        with open(CACHE_ROUTE_KM, "w") as f:
            json.dump(route_km, f, separators=(",", ":"))
        print(CACHE_ROUTE_KM, "written,", len(route_km["index"]), "trips")

    n_max = max((max(c.values()) for c in counters.values() if c), default=0)
    for (w, b), counter in counters.items():
        feats = []
        for (u, v), n in counter.items():
            if n < min_count:
                continue
            data = min(G.get_edge_data(u, v).values(), key=lambda d: d.get("length", 0))
            if "geometry" in data:
                coords = [[round(x, 5), round(y, 5)] for x, y in data["geometry"].coords]
            else:
                coords = [[round(G.nodes[u]["x"], 5), round(G.nodes[u]["y"], 5)],
                          [round(G.nodes[v]["x"], 5), round(G.nodes[v]["y"], 5)]]
            feats.append({"type": "Feature", "properties": {"n": n},
                          "geometry": {"type": "LineString", "coordinates": coords}})
        out = {"type": "FeatureCollection", "features": feats}
        path = f"docs/data/flow_{w}_{b}.geojson"
        with open(path, "w") as f:
            json.dump(out, f, separators=(",", ":"))
        print(path, len(feats), "segments,", os.path.getsize(path), "bytes")
    print("max segment count n =", n_max)

if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else MIN_COUNT)
