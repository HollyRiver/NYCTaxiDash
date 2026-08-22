"""트립별 도로망 최단경로 → 세그먼트 통행량·평균속도 GeoJSON 15슬라이스.

기본 8장: 주중(wd)/주말(we) × 시간대 0:새벽(0-6) 1:오전(6-12) 2:오후(12-18) 3:저녁(18-24)
합성 7장: all×{0..3} (wd+we 합산), {wd,we}×all (band 합산), all×all (전부 합산)
합성 슬라이스는 MIN_COUNT=3 기본이되 2.5MB 초과 시 그 파일만 컷을 5, 7…로 올려 수납.

각 세그먼트 properties = {"n": 통행량, "s": 평균 속력(km/h)}.
평균 속력 s는 그 세그먼트를 지난 트립들의 network 속력(df.speed_kmh) 평균 —
세그먼트별 (count, speed_sum) 가중 누적 후 speed_sum/count. 합성 슬라이스는 base
슬라이스들의 (count, speed_sum)를 세그먼트별로 각각 합산한 뒤 s를 재산출 (가중합).

한계(대시보드에 명시): 최단경로는 실주행 경로가 아닌 추정. 세그먼트 속도는 그 도로를
지난 트립들의 전체 평균 속력 기반 — 구간별 실측 통과속도가 아닌 근사치.
실행: python scripts/build_flows.py [MIN_COUNT]  (pkl 캐시 히트 시 그래프 로드 포함 수 분)
osmnx 2.x API 기준: graph_from_bbox(bbox=(left, bottom, right, top)), ox.routing.shortest_path.
"""
import json
import os
import pickle
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import numpy as np
import osmnx as ox

from build_data import load_clean

BBOX = (-74.05, 40.60, -73.75, 40.88)  # (west, south, east, north) 핵심 운행 대역
MIN_COUNT = 3          # 이 미만 통행 세그먼트는 출력 제외 (용량·노이즈 컷)
MAX_BYTES = int(2.5 * 1024 * 1024)  # 합성 슬라이스 파일 상한 — 초과 시 그 파일만 컷 상향
CACHE_GRAPH = "cache/nyc_drive.graphml"
CACHE_STATS = "cache/segment_stats.pkl"    # 라우팅 결과 캐시 (u,v)->[count, speed_sum] (MIN_COUNT 재조정용)
CACHE_ROUTE_KM = "cache/route_km.json"     # 트립별 도로망 최단경로 거리 (build_data.py에서 조인)

def get_graph():
    if os.path.exists(CACHE_GRAPH):
        return ox.load_graphml(CACHE_GRAPH)
    G = ox.graph_from_bbox(BBOX, network_type="drive", simplify=True)
    os.makedirs("cache", exist_ok=True)
    ox.save_graphml(G, CACHE_GRAPH)
    return G

def build_stats(G):
    """트립 라우팅 → (슬라이스별 세그먼트 통계 dict, 트립별 경로 거리 dict).

    슬라이스별 통계는 {(u,v): [count, speed_sum]} — 그 세그먼트를 지난 트립들의
    수와 network 속력(df.speed_kmh) 합. s = speed_sum/count.
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
    speeds = df.speed_kmh.values  # 트립 i의 network 속력 (이미 도로망 기준)
    stats = {(w, b): {} for w in ("wd", "we") for b in range(4)}  # (u,v) -> [count, speed_sum]
    route_km = {"index": [], "route_km": []}
    for i, r in enumerate(routes):
        if r is None or len(r) < 2:
            continue
        st = stats[(wp[i], band[i])]
        sp = float(speeds[i])
        km = 0.0
        for u, v in zip(r[:-1], r[1:]):
            e = st.get((u, v))
            if e is None:
                st[(u, v)] = [1, sp]
            else:
                e[0] += 1
                e[1] += sp
            km += min(d["length"] for d in G.get_edge_data(u, v).values())
        route_km["index"].append(ids[i])
        route_km["route_km"].append(round(km / 1000.0, 4))
    print(f"routed {len(route_km['index'])}/{len(df)} trips")
    return stats, route_km

def edge_coords(G, u, v, _cache={}):
    """세그먼트 (u, v)의 LineString 좌표 — 슬라이스 15장에서 재사용하므로 메모이즈."""
    key = (u, v)
    if key in _cache:
        return _cache[key]
    data = min(G.get_edge_data(u, v).values(), key=lambda d: d.get("length", 0))
    if "geometry" in data:
        coords = [[round(x, 5), round(y, 5)] for x, y in data["geometry"].coords]
    else:
        coords = [[round(G.nodes[u]["x"], 5), round(G.nodes[u]["y"], 5)],
                  [round(G.nodes[v]["x"], 5), round(G.nodes[v]["y"], 5)]]
    _cache[key] = coords
    return coords

def merge_stats(*dicts):
    """세그먼트 통계 dict들을 (u,v)별로 [count, speed_sum] 각각 합산 (합성 슬라이스용)."""
    out = {}
    for d in dicts:
        for k, (c, ss) in d.items():
            e = out.get(k)
            if e is None:
                out[k] = [c, ss]
            else:
                e[0] += c
                e[1] += ss
    return out

def write_slice(G, stat, path, min_count, max_bytes=None):
    """세그먼트 통계 dict → GeoJSON 출력. max_bytes 지정 시 초과하면 컷을 +2씩 올려 재출력.

    각 feature properties = {"n": count, "s": round(speed_sum/count, 1)}.
    반환: (세그먼트 수, 파일 크기, 실제 적용 컷, n 최대값, s 최소, s 최대)
    """
    n_max = max((c for c, _ in stat.values()), default=0)
    while True:
        feats = []
        s_min, s_max = None, None
        for (u, v), (c, ss) in stat.items():
            if c < min_count:
                continue
            s = round(ss / c, 1)
            if s_min is None or s < s_min:
                s_min = s
            if s_max is None or s > s_max:
                s_max = s
            feats.append({"type": "Feature", "properties": {"n": c, "s": s},
                          "geometry": {"type": "LineString", "coordinates": edge_coords(G, u, v)}})
        with open(path, "w") as f:
            json.dump({"type": "FeatureCollection", "features": feats}, f, separators=(",", ":"))
        size = os.path.getsize(path)
        if max_bytes is None or size <= max_bytes:
            return len(feats), size, min_count, n_max, s_min, s_max
        min_count += 2

def main(min_count=MIN_COUNT):
    G = get_graph()
    if os.path.exists(CACHE_STATS) and os.path.exists(CACHE_ROUTE_KM):
        with open(CACHE_STATS, "rb") as f:
            stats = pickle.load(f)
        print("loaded segment stats from cache")
    else:
        stats, route_km = build_stats(G)
        os.makedirs("cache", exist_ok=True)
        with open(CACHE_STATS, "wb") as f:
            pickle.dump(stats, f)
        with open(CACHE_ROUTE_KM, "w") as f:
            json.dump(route_km, f, separators=(",", ":"))
        print(CACHE_ROUTE_KM, "written,", len(route_km["index"]), "trips")

    def report(path, nseg, size, cut, n_max, s_min, s_max):
        print(f"{path} {nseg} segments, {size} bytes, cut={cut}, n_max={n_max}, "
              f"s=[{s_min}, {s_max}]")

    # 기본 8장: wd/we × band 0..3
    for (w, b), stat in stats.items():
        path = f"docs/data/flow_{w}_{b}.geojson"
        report(path, *write_slice(G, stat, path, min_count))

    # 합성 7장: all×band 4장 + wp×all 2장 + all×all 1장 (2.5MB 초과 시 컷 상향)
    # 세그먼트별 [count, speed_sum]를 가중 합산한 뒤 s를 재산출 (단순 s 평균 아님).
    composites = {}
    for b in range(4):
        composites[("all", b)] = merge_stats(stats[("wd", b)], stats[("we", b)])
    for w in ("wd", "we"):
        composites[(w, "all")] = merge_stats(*(stats[(w, b)] for b in range(4)))
    composites[("all", "all")] = merge_stats(composites[("wd", "all")], composites[("we", "all")])

    for (w, b), stat in composites.items():
        path = f"docs/data/flow_{w}_{b}.geojson"
        report(path, *write_slice(G, stat, path, min_count, max_bytes=MAX_BYTES))

if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else MIN_COUNT)
