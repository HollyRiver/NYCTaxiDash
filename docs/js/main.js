/* NYC Taxi Traffic 대시보드 — 헥스빈 지도 + 요일·시간 필터 */
"use strict";

// ---------- 상태 ----------
const state = { days: new Set([0, 1, 2, 3, 4, 5, 6]), hour: null, metric: "count", layer: "hex", flowWp: "wd", flowBand: 1 };

let TRIPS = null;
let META = null;
let LANDMARKS = null;
let map = null;
let mapReady = false;

// ---------- 헥스빈 (pointy-top axial, ~350m) ----------
const COS0 = Math.cos(40.75 * Math.PI / 180);
const R_HEX = 0.0032;

function hexKey(lat, lon) {
  const x = lon * COS0 / R_HEX, y = lat / R_HEX;
  let q = Math.sqrt(3) / 3 * x - y / 3, r = 2 / 3 * y;
  let s = -q - r, rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return rq + "," + rr;
}

function hexCenter(key) {
  const [q, r] = key.split(",").map(Number);
  return [Math.sqrt(3) * (q + r / 2) * R_HEX / COS0, 1.5 * r * R_HEX]; // [lon, lat]
}

function hexPolygon(c) {
  const pts = [];
  for (let i = 0; i < 7; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    pts.push([c[0] + R_HEX * Math.cos(a) / COS0, c[1] + R_HEX * Math.sin(a)]);
  }
  return pts;
}

// ---------- 집계 ----------
function aggregate() {
  const cells = new Map();
  const { plat, plon, dow, hr, v } = TRIPS;
  for (let i = 0; i < plat.length; i++) {
    if (!state.days.has(dow[i])) continue;
    if (state.hour !== null && hr[i] !== state.hour) continue;
    const k = hexKey(plat[i], plon[i]);
    let c = cells.get(k);
    if (!c) cells.set(k, c = { n: 0, sv: 0 });
    c.n++; c.sv += v[i];
  }
  return { type: "FeatureCollection", features: [...cells].map(([k, c]) => ({
    type: "Feature",
    properties: { n: c.n, speed: +(c.sv / c.n).toFixed(1), faint: c.n < 5 ? 1 : 0 },
    geometry: { type: "Polygon", coordinates: [hexPolygon(hexCenter(k))] },
  })) };
}

// ---------- 색상 표현식 ----------
const FILL_COLOR = {
  count: ["interpolate", ["linear"], ["get", "n"],
    1, "#dbe4f0", 20, "#7f9cc9", 80, "#345995", 300, "#16294d"],
  speed: ["interpolate", ["linear"], ["get", "speed"],
    5, "#a63232", 12, "#d99a4e", 20, "#7f9cc9", 35, "#2e7d52"],
};

// ---------- KPI ----------
function fillKpis() {
  const fmt = (x) => x.toLocaleString("en-US");
  document.getElementById("kpi-n").textContent = fmt(META.n);
  document.getElementById("kpi-total").textContent = fmt(META.n);
  document.getElementById("kpi-speed").textContent = META.avg_speed + " km/h";
  document.getElementById("kpi-slowest").textContent = META.slowest_hour + "시";
  document.getElementById("kpi-dist").textContent = META.avg_dist + " km";
}

// ---------- 지도 ----------
function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [-73.95, 40.74],
    zoom: 10.7,
    attributionControl: true,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", () => {
    // 수변·공원 대비 강화 (스타일별 레이어 id가 다르므로 탐색해 적용)
    try {
      for (const lyr of map.getStyle().layers) {
        if (lyr.type !== "fill") continue;
        const id = lyr.id.toLowerCase();
        try {
          if (id.includes("water")) map.setPaintProperty(lyr.id, "fill-color", "#cfe0ee");
          else if (id.includes("park") || id.includes("green")) map.setPaintProperty(lyr.id, "fill-color", "#dcead8");
        } catch (e) { /* 개별 레이어 실패는 무시 */ }
      }
    } catch (e) { /* 스타일 탐색 실패도 무시하고 진행 */ }

    map.addSource("hex", { type: "geojson", data: aggregate() });
    map.addLayer({
      id: "hex",
      type: "fill",
      source: "hex",
      paint: {
        "fill-color": FILL_COLOR[state.metric],
        "fill-opacity": ["case", ["==", ["get", "faint"], 1], 0.25, 0.72],
        "fill-outline-color": "#ffffff",
      },
    });

    // 랜드마크 라벨
    map.addSource("landmarks", { type: "geojson", data: LANDMARKS });
    try {
      map.addLayer({
        id: "landmarks",
        type: "symbol",
        source: "landmarks",
        layout: {
          "text-field": ["get", "name"],
          "text-size": 12,
          "text-font": ["Montserrat Regular", "Open Sans Regular"],
        },
        paint: {
          "text-color": "#6b7280",
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.2,
        },
      });
    } catch (e) {
      // 폰트 문제 등으로 실패하면 text-font 없이 재시도
      map.addLayer({
        id: "landmarks",
        type: "symbol",
        source: "landmarks",
        layout: { "text-field": ["get", "name"], "text-size": 12 },
        paint: { "text-color": "#6b7280", "text-halo-color": "#ffffff", "text-halo-width": 1.2 },
      });
    }

    // hover 팝업
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
    map.on("mousemove", "hex", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const p = e.features[0].properties;
      popup.setLngLat(e.lngLat).setHTML(`트립 ${p.n}건 · 평균 ${p.speed} km/h`).addTo(map);
    });
    map.on("mouseleave", "hex", () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    });

    mapReady = true;
  });
}

// ---------- 갱신 ----------
function refresh() {
  if (mapReady && map.getSource("hex")) map.getSource("hex").setData(aggregate());
  if (window.updateCharts) window.updateCharts();
}
window.__refresh = refresh;

// ---------- 컨트롤 바인딩 ----------
function bindControls() {
  const dayBtns = document.querySelectorAll(".ctl-days button[data-day]");

  dayBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = +btn.dataset.day;
      if (state.days.has(d)) { state.days.delete(d); btn.classList.remove("on"); }
      else { state.days.add(d); btn.classList.add("on"); }
      refresh();
    });
  });
  document.getElementById("days-all").addEventListener("click", () => {
    dayBtns.forEach((b) => { state.days.add(+b.dataset.day); b.classList.add("on"); });
    refresh();
  });
  document.getElementById("days-none").addEventListener("click", () => {
    state.days.clear();
    dayBtns.forEach((b) => b.classList.remove("on"));
    refresh();
  });

  const hourInput = document.getElementById("hour");
  const hourLabel = document.getElementById("hour-label");
  hourInput.addEventListener("input", () => {
    const h = +hourInput.value;
    if (h < 0) { state.hour = null; hourLabel.textContent = "전체 시간"; }
    else { state.hour = h; hourLabel.textContent = h + "시"; }
    refresh();
  });

  document.querySelectorAll(".ctl-metric button[data-metric]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.metric === btn.dataset.metric) return;
      state.metric = btn.dataset.metric;
      document.querySelectorAll(".ctl-metric button[data-metric]").forEach((b) => b.classList.toggle("on", b === btn));
      if (mapReady && map.getLayer("hex")) map.setPaintProperty("hex", "fill-color", FILL_COLOR[state.metric]);
    });
  });

  document.querySelectorAll(".ctl-layer button[data-layer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.layer === btn.dataset.layer) return;
      state.layer = btn.dataset.layer;
      document.querySelectorAll(".ctl-layer button[data-layer]").forEach((b) => b.classList.toggle("on", b === btn));
      document.querySelector(".ctl-flow").hidden = state.layer !== "flow";
      if (window.updateFlowLayer) window.updateFlowLayer(); // Task 7에서 구현
    });
  });
}

// ---------- 초기화 ----------
async function init() {
  const [trips, meta, landmarks] = await Promise.all([
    fetch("data/trips.json").then((r) => r.json()),
    fetch("data/meta.json").then((r) => r.json()),
    fetch("data/landmarks.json").then((r) => r.json()),
  ]);
  TRIPS = trips; META = meta; LANDMARKS = landmarks;
  fillKpis();
  bindControls();

  // 셀프테스트 훅: ?selftest 시 집계 요약을 title에 기록 (헤드리스 검증용)
  if (location.search.includes("selftest")) {
    const fc = aggregate();
    const total = fc.features.reduce((s, f) => s + f.properties.n, 0);
    document.title = `SELFTEST cells=${fc.features.length} trips=${total} n=${META.n}`;
    return; // 셀프테스트에서는 지도 초기화 생략 (WebGL 불필요)
  }

  initMap();

  // 지도 렌더 셀프테스트: ?maptest 시 렌더된 헥스 수를 title에 기록 (헤드리스 검증용)
  if (location.search.includes("maptest")) {
    const errs = [];
    map.on("error", (e) => errs.push(e.error && e.error.message || String(e)));
    map.on("idle", () => {
      const hex = map.getLayer("hex") ? map.queryRenderedFeatures({ layers: ["hex"] }).length : -1;
      const lm = map.getLayer("landmarks") ? map.queryRenderedFeatures({ layers: ["landmarks"] }).length : -1;
      document.title = `MAPTEST loaded=${map.loaded()} hex=${hex} lm=${lm} err=${errs.slice(0, 2).join(";") || "none"}`;
    });
  }
}

init().catch((e) => console.error("초기화 실패:", e));
