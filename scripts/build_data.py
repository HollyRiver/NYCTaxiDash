"""data/NYCTaxi.csv → docs/data/trips.json + meta.json.

정제 기준 (대시보드 푸터에도 명시):
- NYC 대역 밖 좌표 제거 (BBOX)
- 60초 미만 트립 제거
- 직선거리 0.05km 이하 / 60km 초과 제거
- 직선거리 기반 평균속력 120km/h 초과 제거
정제(행 선별)는 haversine 직선거리 기준. 단, cache/route_km.json(build_flows.py 산출)이
있으면 출력되는 거리/속력 값은 OSM 도로망 최단경로 거리 기준으로 교체 (미라우팅 트립은
haversine 유지). meta.json의 speed_basis로 기준을 명시.
"""
import json
import os
import numpy as np
import pandas as pd

RAW = "data/NYCTaxi.csv"
OUT_TRIPS = "docs/data/trips.json"
OUT_META = "docs/data/meta.json"
CACHE_ROUTE_KM = "cache/route_km.json"

BBOX = dict(lat_min=40.50, lat_max=41.00, lon_min=-74.30, lon_max=-73.60)
MIN_DURATION_S = 60
MIN_DIST_KM, MAX_DIST_KM = 0.05, 60.0
MAX_SPEED_KMH = 120.0

def haversine_km(lat1, lon1, lat2, lon2):
    R = 6371.0088
    p1, p2 = np.radians(lat1), np.radians(lat2)
    a = np.sin((p2 - p1) / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(np.radians(lon2 - lon1) / 2) ** 2
    return 2 * R * np.arcsin(np.sqrt(a))

def load_clean(path=RAW):
    df = pd.read_csv(path, parse_dates=["pickup_datetime", "dropoff_datetime"])
    df["dist_km"] = haversine_km(df.pickup_latitude.values, df.pickup_longitude.values,
                                 df.dropoff_latitude.values, df.dropoff_longitude.values)
    df["speed_kmh"] = df.dist_km / (df.trip_duration / 3600.0)
    def in_bbox(lat, lon):
        return lat.between(BBOX["lat_min"], BBOX["lat_max"]) & lon.between(BBOX["lon_min"], BBOX["lon_max"])
    mask = (in_bbox(df.pickup_latitude, df.pickup_longitude)
            & in_bbox(df.dropoff_latitude, df.dropoff_longitude)
            & (df.trip_duration >= MIN_DURATION_S)
            & df.dist_km.between(MIN_DIST_KM, MAX_DIST_KM, inclusive="neither")
            & (df.speed_kmh <= MAX_SPEED_KMH))
    df = df[mask].copy()
    df["dow"] = df.pickup_datetime.dt.dayofweek
    df["hour"] = df.pickup_datetime.dt.hour
    return df

def apply_network_speed(df, route_path=CACHE_ROUTE_KM):
    """route_km.json이 있으면 id 조인으로 dist_km/speed_kmh를 도로망 거리 기준으로 교체.

    행 집합(정제 결과)은 그대로 두고 값만 바꿈. 미라우팅 트립은 haversine 값 유지.
    반환: (df, 도로망 기준으로 교체된 트립 수). 파일이 없으면 (df, 0).
    """
    if not os.path.exists(route_path):
        return df, 0
    with open(route_path) as f:
        rk = json.load(f)
    net = df.id.map(pd.Series(rk["route_km"], index=rk["index"], dtype=float))
    m = net.notna() & (net > 0)
    df.loc[m, "dist_km"] = net[m]
    df.loc[m, "speed_kmh"] = net[m] / (df.loc[m, "trip_duration"] / 3600.0)
    return df, int(m.sum())

def main():
    raw_n = len(pd.read_csv(RAW, usecols=["id"]))
    df = load_clean()
    df, n_network = apply_network_speed(df)
    n_over = int((df.speed_kmh > MAX_SPEED_KMH).sum())
    trips = dict(
        plat=df.pickup_latitude.round(4).tolist(), plon=df.pickup_longitude.round(4).tolist(),
        dlat=df.dropoff_latitude.round(4).tolist(), dlon=df.dropoff_longitude.round(4).tolist(),
        dow=df.dow.tolist(), hr=df.hour.tolist(),
        v=df.speed_kmh.round(1).tolist(), km=df.dist_km.round(2).tolist(),
    )
    slowest = df.groupby("hour").speed_kmh.mean().idxmin()
    meta = dict(
        n=len(df), n_raw=raw_n, n_dropped=raw_n - len(df),
        period=[str(df.pickup_datetime.min().date()), str(df.pickup_datetime.max().date())],
        avg_speed=round(df.speed_kmh.mean(), 1), avg_dist=round(df.dist_km.mean(), 2),
        slowest_hour=int(slowest),
        speed_basis="network" if n_network else "haversine", n_network=n_network,
    )
    with open(OUT_TRIPS, "w") as f:
        json.dump(trips, f, separators=(",", ":"))
    with open(OUT_META, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    print(f"kept {meta['n']}/{raw_n}, dropped {meta['n_dropped']}")
    print(f"speed basis: {meta['speed_basis']}, network trips: {n_network}, "
          f"network speed > {MAX_SPEED_KMH:.0f} km/h: {n_over}")

if __name__ == "__main__":
    main()
