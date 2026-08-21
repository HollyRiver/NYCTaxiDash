import json
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))
import numpy as np
import pandas as pd
from build_data import apply_network_speed, haversine_km, load_clean

def test_haversine_known_distance():
    # 타임스퀘어(40.7580,-73.9855) ~ JFK(40.6413,-73.7781) ≈ 21.7km
    d = haversine_km(np.array([40.7580]), np.array([-73.9855]), np.array([40.6413]), np.array([-73.7781]))
    assert abs(d[0] - 21.7) < 0.5

def test_load_clean_removes_outliers(tmp_path):
    rows = [
        # 정상: 5km/600s = 30km/h
        dict(id="a", pickup_datetime="2016-03-14 08:00:00", dropoff_datetime="2016-03-14 08:10:00",
             passenger_count=1, pickup_longitude=-73.98, pickup_latitude=40.75,
             dropoff_longitude=-73.98, dropoff_latitude=40.795, trip_duration=600),
        # 이상치: 좌표가 NYC 밖
        dict(id="b", pickup_datetime="2016-03-14 08:00:00", dropoff_datetime="2016-03-14 08:10:00",
             passenger_count=1, pickup_longitude=0.0, pickup_latitude=0.0,
             dropoff_longitude=-73.98, dropoff_latitude=40.75, trip_duration=600),
        # 이상치: 30초 트립
        dict(id="c", pickup_datetime="2016-03-14 08:00:00", dropoff_datetime="2016-03-14 08:00:30",
             passenger_count=1, pickup_longitude=-73.98, pickup_latitude=40.75,
             dropoff_longitude=-73.97, dropoff_latitude=40.76, trip_duration=30),
    ]
    p = tmp_path / "t.csv"
    pd.DataFrame(rows).to_csv(p, index=False)
    df = load_clean(str(p))
    assert list(df.id) == ["a"]
    assert 25 < df.speed_kmh.iloc[0] < 35
    assert df.dow.iloc[0] == 0 and df.hour.iloc[0] == 8

def test_apply_network_speed_joins_by_id(tmp_path):
    df = pd.DataFrame(dict(id=["a", "b"], trip_duration=[600, 600],
                           dist_km=[5.0, 5.0], speed_kmh=[30.0, 30.0]))
    p = tmp_path / "route_km.json"
    p.write_text(json.dumps({"index": ["a"], "route_km": [6.0]}))
    out, n = apply_network_speed(df, str(p))
    assert n == 1
    # 라우팅된 트립: 도로망 거리/속력으로 교체 (6km / 600s = 36km/h)
    assert out.dist_km.iloc[0] == 6.0 and abs(out.speed_kmh.iloc[0] - 36.0) < 1e-9
    # 미라우팅 트립: haversine 값 유지
    assert out.dist_km.iloc[1] == 5.0 and out.speed_kmh.iloc[1] == 30.0

def test_apply_network_speed_without_file(tmp_path):
    df = pd.DataFrame(dict(id=["a"], trip_duration=[600], dist_km=[5.0], speed_kmh=[30.0]))
    out, n = apply_network_speed(df, str(tmp_path / "missing.json"))
    assert n == 0 and out.speed_kmh.iloc[0] == 30.0
