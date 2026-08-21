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

// ---------- 플로우 레이어 ----------
const flowCache = {}; // wp+band → GeoJSON (lazy fetch)
let flowReq = 0;      // 최신 요청만 반영하기 위한 시퀀스

const FLOW_LINE_COLOR = ["interpolate", ["linear"], ["get", "n"],
  3, "#9db4d6", 30, "#345995", 120, "#16294d"];
const FLOW_LINE_WIDTH = ["interpolate", ["linear"], ["get", "n"],
  3, 0.5, 20, 1.6, 60, 3, 150, 5];

// 플로우 모드에서는 요일·시간·지표 필터가 무의미 → disabled 시각 처리
function setHexControlsDisabled(disabled) {
  for (const sel of [".ctl-days", ".ctl-hour", ".ctl-metric"]) {
    const grp = document.querySelector(sel);
    if (!grp) continue;
    grp.classList.toggle("disabled", disabled);
    grp.querySelectorAll("button, input").forEach((el) => { el.disabled = disabled; });
  }
}

window.updateFlowLayer = async function () {
  const flowMode = state.layer === "flow";
  setHexControlsDisabled(flowMode);
  if (!mapReady || !map.getLayer("flow-lines")) return;

  if (!flowMode) {
    map.setLayoutProperty("flow-lines", "visibility", "none");
    map.setLayoutProperty("hex", "visibility", "visible");
    return;
  }

  map.setLayoutProperty("hex", "visibility", "none");
  map.setLayoutProperty("flow-lines", "visibility", "visible");

  const key = state.flowWp + state.flowBand;
  const seq = ++flowReq;
  if (!flowCache[key]) {
    const note = document.querySelector(".ctl-note");
    if (note && !note.dataset.orig) note.dataset.orig = note.textContent;
    if (note) note.textContent = "로드 중…";
    try {
      flowCache[key] = await fetch(`data/flow_${state.flowWp}_${state.flowBand}.geojson`).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
      if (note) note.textContent = note.dataset.orig;
    } catch (e) {
      console.error("플로우 로드 실패:", e);
      if (note) note.textContent = "플로우 데이터 로드 실패";
      return;
    }
  }
  if (seq !== flowReq) return; // 그 사이 다른 슬라이스가 요청됨
  map.getSource("flow").setData(flowCache[key]);
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

// ---------- 보조 차트 (Plotly) ----------
const CHART_FONT = '"Pretendard", -apple-system, "Segoe UI", "Noto Sans KR", "Malgun Gothic", sans-serif';
const CHART_CONFIG = { displayModeBar: false, responsive: true };
const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];

// 요일×시간 평균 속력 히트맵 — 필터와 무관한 전역 패턴 (1회만 렌더)
function renderHeatChart() {
  if (!window.Plotly) return;
  const { dow, hr, v } = TRIPS;
  const sum = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const cnt = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (let i = 0; i < dow.length; i++) {
    sum[dow[i]][hr[i]] += v[i];
    cnt[dow[i]][hr[i]]++;
  }
  const z = sum.map((row, d) => row.map((s, h) => cnt[d][h] ? +(s / cnt[d][h]).toFixed(1) : null));

  Plotly.newPlot("chart-heat", [{
    type: "heatmap",
    z,
    x: [...Array(24).keys()],
    y: DAY_LABELS,
    customdata: cnt,
    colorscale: [[0, "#a63232"], [0.35, "#d99a4e"], [0.7, "#7f9cc9"], [1, "#2e7d52"]],
    colorbar: { title: { text: "km/h", side: "top" }, thickness: 10, outlinewidth: 0, tickfont: { size: 10 } },
    hovertemplate: "%{y}요일 %{x}시 · 평균 %{z} km/h · 표본 %{customdata}건<extra></extra>",
  }], {
    margin: { l: 30, r: 4, t: 8, b: 26 },
    font: { family: CHART_FONT, size: 11, color: "#1c1c1e" },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { dtick: 2, ticksuffix: "시" },
    yaxis: { autorange: "reversed" }, // 월이 위
  }, CHART_CONFIG);
}

// 시간대별 트립 수 막대 — state.days 반영, state.hour 막대만 강조 (refresh 훅에서 갱신)
window.updateCharts = function () {
  if (!window.Plotly || !TRIPS) return;
  const { dow, hr } = TRIPS;
  const counts = new Array(24).fill(0);
  for (let i = 0; i < dow.length; i++) {
    if (state.days.has(dow[i])) counts[hr[i]]++;
  }
  const colors = counts.map((_, h) => (state.hour === h ? "#345995" : "#7f9cc9"));

  Plotly.react("chart-hour", [{
    type: "bar",
    x: [...Array(24).keys()],
    y: counts,
    marker: { color: colors },
    hovertemplate: "%{x}시 · %{y:,}건<extra></extra>",
  }], {
    margin: { l: 40, r: 4, t: 8, b: 26 },
    font: { family: CHART_FONT, size: 11, color: "#1c1c1e" },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { dtick: 2, ticksuffix: "시" },
    yaxis: { gridcolor: "#e4e2dc", zerolinecolor: "#e4e2dc" },
    bargap: 0.25,
  }, CHART_CONFIG);
};

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

    // 도로 플로우 (초기엔 빈 컬렉션·숨김 — updateFlowLayer가 관리)
    map.addSource("flow", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "flow-lines",
      type: "line",
      source: "flow",
      layout: { "line-cap": "round", "line-join": "round", "visibility": "none" },
      paint: {
        "line-color": FLOW_LINE_COLOR,
        "line-width": FLOW_LINE_WIDTH,
        "line-opacity": 0.85,
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
    map.on("mousemove", "flow-lines", (e) => {
      map.getCanvas().style.cursor = "pointer";
      popup.setLngLat(e.lngLat).setHTML(`통행 ${e.features[0].properties.n}회`).addTo(map);
    });
    map.on("mouseleave", "flow-lines", () => {
      map.getCanvas().style.cursor = "";
      popup.remove();
    });

    mapReady = true;
    if (state.layer === "flow") window.updateFlowLayer(); // 로드 전에 플로우로 전환한 경우 반영
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
      if (window.updateFlowLayer) window.updateFlowLayer();
    });
  });

  // 플로우 슬라이스: 주중/주말 × 시간대
  document.querySelectorAll(".ctl-flow button[data-wp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.flowWp === btn.dataset.wp) return;
      state.flowWp = btn.dataset.wp;
      document.querySelectorAll(".ctl-flow button[data-wp]").forEach((b) => b.classList.toggle("on", b === btn));
      window.updateFlowLayer();
    });
  });
  document.querySelectorAll(".ctl-flow button[data-band]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.flowBand === +btn.dataset.band) return;
      state.flowBand = +btn.dataset.band;
      document.querySelectorAll(".ctl-flow button[data-band]").forEach((b) => b.classList.toggle("on", b === btn));
      window.updateFlowLayer();
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

  renderHeatChart();      // 전역 패턴 히트맵 — 필터와 무관, 1회만
  window.updateCharts();  // 현재 선택 반영 막대 — 이후 refresh()가 갱신

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
