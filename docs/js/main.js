/* NYC Taxi Traffic 대시보드 — 헥스빈 지도 + 요일·시간 필터 */
"use strict";

// ---------- 상태 ----------
const state = { days: new Set([0, 1, 2, 3, 4, 5, 6]), hour: null, metric: "count", layer: "flow", flowWp: "wd", flowBand: 3 };

let TRIPS = null;
let META = null;
let LANDMARKS = null;
let map = null;
let mapReady = false;

// ---------- 헥스빈 (pointy-top axial, ~240m) ----------
const COS0 = Math.cos(40.75 * Math.PI / 180);
const R_HEX = 0.0022;

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
// 속력: 도로망 최단경로 거리 기준 값에 맞춘 고정 스톱
const FILL_SPEED = ["interpolate", ["linear"], ["get", "speed"],
  7, "#a63232", 15, "#d99a4e", 22, "#7f9cc9", 34, "#2e7d52"];

// 밀도: 고정 스톱이면 희소 선택(특정 요일+시간)에서 최저색으로 뭉개짐 →
// refresh()마다 셀 n값 분위수(p50/p85/p98)로 스톱을 동적 구성
const COUNT_PALETTE = ["#dbe4f0", "#7f9cc9", "#345995", "#16294d"];
let fillCount = ["interpolate", ["linear"], ["get", "n"], 1, COUNT_PALETTE[0], 2, COUNT_PALETTE[3]];

function quantileSorted(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function buildCountColor(fc) {
  const ns = fc.features.map((f) => f.properties.n).sort((a, b) => a - b);
  const max = ns.length ? ns[ns.length - 1] : 0;
  if (max > 1) {
    const stops = [1, quantileSorted(ns, 0.5), quantileSorted(ns, 0.85), quantileSorted(ns, 0.98)];
    if (stops.every((s, i) => i === 0 || s > stops[i - 1])) {
      return ["interpolate", ["linear"], ["get", "n"],
        stops[0], COUNT_PALETTE[0], stops[1], COUNT_PALETTE[1],
        stops[2], COUNT_PALETTE[2], stops[3], COUNT_PALETTE[3]];
    }
  }
  // 퇴화 케이스(셀 수 적거나 스톱 겹침): [1, max] 2스톱 폴백으로 최소 대비 보장
  return ["interpolate", ["linear"], ["get", "n"], 1, COUNT_PALETTE[0], Math.max(max, 2), COUNT_PALETTE[3]];
}

function currentFillColor() {
  return state.metric === "speed" ? FILL_SPEED : fillCount;
}

// ---------- 플로우 레이어 ----------
const flowCache = {}; // wp+band → GeoJSON (lazy fetch)
let flowReq = 0;      // 최신 요청만 반영하기 위한 시퀀스

// "두꺼울수록 붉게, 얇을수록 파랗고 흐리게" — 통행량 청→적 발산 색 + 투명도 그라데이션
const FLOW_LINE_COLOR = ["interpolate", ["linear"], ["get", "n"],
  3, "#7fa3d1", 20, "#8a7fb8", 60, "#b0596a", 150, "#c73030"];
const FLOW_LINE_WIDTH = ["interpolate", ["linear"], ["get", "n"],
  3, 0.5, 20, 1.6, 60, 3, 150, 5];
const FLOW_LINE_OPACITY = ["interpolate", ["linear"], ["get", "n"],
  3, 0.45, 30, 0.75, 100, 0.95];

// 모드별 컨트롤 표시 전환: 플로우 → .ctl-flow만, 헥스 → 요일/시간/지표만
// (헥스 모드 내 "전체 시간" 토글의 슬라이더 disabled 상태는 setHourAll이 별도 관리)
function syncModeControls() {
  const flowMode = state.layer === "flow";
  const flowGrp = document.querySelector(".ctl-flow");
  if (flowGrp) flowGrp.hidden = !flowMode;
  for (const sel of [".ctl-days", ".ctl-hour", ".ctl-metric"]) {
    const grp = document.querySelector(sel);
    if (grp) grp.hidden = flowMode;
  }
}

window.updateFlowLayer = async function () {
  const flowMode = state.layer === "flow";
  syncModeControls();
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

  // 우측 패널 폭(~420px) 기준 compact: 셀 정방 비율을 따르되 최소 가독선 150px 확보
  // (좌우 여백 l26+r4 + 세로 컬러바(thickness 8 + 틱) ~36px ≈ 66, 상하 여백 t8+b24 = 32)
  const el = document.getElementById("chart-heat");
  const w = el.clientWidth || 420;
  el.style.height = Math.max(150, Math.round((w - 66) * 7 / 24) + 32) + "px";

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
    colorscale: [[0, "#c73030"], [0.4, "#d99a4e"], [0.75, "#7f9cc9"], [1, "#2e5f95"]],
    colorbar: { title: { text: "km/h", side: "top", font: { size: 9 } }, thickness: 8, outlinewidth: 0, tickfont: { size: 9 } },
    hovertemplate: "%{y}요일 %{x}시 · 평균 %{z} km/h · 표본 %{customdata}건<extra></extra>",
  }], {
    margin: { l: 26, r: 4, t: 8, b: 24 },
    font: { family: CHART_FONT, size: 10, color: "#1c1c1e" },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    xaxis: { dtick: 3, ticksuffix: "시", tickfont: { size: 9 } },
    yaxis: { autorange: "reversed", tickfont: { size: 10 } }, // 월이 위
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
// 초기 시점: 데이터 전체 bbox fitBounds가 기본. 아래 상수는 bbox 계산 실패 폴백.
const FALLBACK_VIEW = { center: [-73.95, 40.74], zoom: 10.7 };
let INIT_VIEW = { ...FALLBACK_VIEW }; // fitBounds 후 실제 시점(getCenter/getZoom)으로 갱신

// 승차+하차 좌표 전체의 bbox → [[minLon, minLat], [maxLon, maxLat]]
function computeDataBounds() {
  if (!TRIPS) return null;
  const { plat, plon, dlat, dlon } = TRIPS;
  if (!plat || !plat.length || !dlat || dlat.length !== plat.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (let i = 0; i < plat.length; i++) {
    if (plat[i] < minLat) minLat = plat[i];
    if (plat[i] > maxLat) maxLat = plat[i];
    if (dlat[i] < minLat) minLat = dlat[i];
    if (dlat[i] > maxLat) maxLat = dlat[i];
    if (plon[i] < minLon) minLon = plon[i];
    if (plon[i] > maxLon) maxLon = plon[i];
    if (dlon[i] < minLon) minLon = dlon[i];
    if (dlon[i] > maxLon) maxLon = dlon[i];
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;
  return [[minLon, minLat], [maxLon, maxLat]];
}

// 초기 시점 리셋 커스텀 컨트롤 (MapLibre IControl)
class ResetViewControl {
  onAdd(m) {
    this._map = m;
    this._container = document.createElement("div");
    this._container.className = "maplibregl-ctrl maplibregl-ctrl-group";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "map-reset-btn";
    btn.title = "초기 화면으로";
    btn.setAttribute("aria-label", "초기 화면으로");
    btn.textContent = "⟲";
    btn.addEventListener("click", () => {
      this._map.easeTo({ center: INIT_VIEW.center, zoom: INIT_VIEW.zoom, duration: 600 });
    });
    this._container.appendChild(btn);
    return this._container;
  }
  onRemove() {
    this._container.remove();
    this._map = null;
  }
}

function initMap() {
  map = new maplibregl.Map({
    container: "map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: FALLBACK_VIEW.center,
    zoom: FALLBACK_VIEW.zoom,
    attributionControl: true,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");
  map.addControl(new ResetViewControl(), "top-right");

  map.on("load", () => {
    // 데이터 전체 bbox로 초기 뷰 — animate:false는 동기(jumpTo)라 직후 캡처 가능.
    // 리셋 버튼(⟲)도 이 실측 시점으로 복원.
    try {
      const bounds = computeDataBounds();
      if (bounds) {
        map.fitBounds(bounds, { padding: 24, animate: false });
        INIT_VIEW = { center: map.getCenter(), zoom: map.getZoom() };
      }
    } catch (e) {
      console.warn("bbox 초기 뷰 실패 — 폴백 시점 유지:", e);
    }

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

    const hexFc = aggregate();
    fillCount = buildCountColor(hexFc);
    map.addSource("hex", { type: "geojson", data: hexFc });
    map.addLayer({
      id: "hex",
      type: "fill",
      source: "hex",
      paint: {
        "fill-color": currentFillColor(),
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
        "line-opacity": FLOW_LINE_OPACITY,
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
  const fc = aggregate();
  fillCount = buildCountColor(fc); // 밀도 스케일을 현재 선택의 분위수로 재산정
  if (mapReady && map.getSource("hex")) {
    map.getSource("hex").setData(fc);
    if (state.metric === "count" && map.getLayer("hex")) {
      map.setPaintProperty("hex", "fill-color", fillCount);
    }
  }
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

  // 시간: "전체 시간" 토글 + 0–23 슬라이더
  const hourInput = document.getElementById("hour");
  const hourLabel = document.getElementById("hour-label");
  const hourAllBtn = document.getElementById("hour-all");

  function setHourAll(on) {
    hourAllBtn.classList.toggle("on", on);
    hourInput.disabled = on;
    if (on) {
      state.hour = null;
      hourLabel.textContent = "";
    } else {
      state.hour = +hourInput.value;
      hourLabel.textContent = hourInput.value + "시";
    }
    refresh();
  }

  hourAllBtn.addEventListener("click", () => {
    setHourAll(!hourAllBtn.classList.contains("on"));
  });

  hourInput.addEventListener("input", () => {
    // 슬라이더 조작 시 토글은 off 상태 유지
    hourAllBtn.classList.remove("on");
    const h = +hourInput.value;
    state.hour = h;
    hourLabel.textContent = h + "시";
    refresh();
  });

  document.querySelectorAll(".ctl-metric button[data-metric]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.metric === btn.dataset.metric) return;
      state.metric = btn.dataset.metric;
      document.querySelectorAll(".ctl-metric button[data-metric]").forEach((b) => b.classList.toggle("on", b === btn));
      if (mapReady && map.getLayer("hex")) map.setPaintProperty("hex", "fill-color", currentFillColor());
    });
  });

  document.querySelectorAll(".layer-switch button[data-layer]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.layer === btn.dataset.layer) return;
      state.layer = btn.dataset.layer;
      document.querySelectorAll(".layer-switch button[data-layer]").forEach((b) => b.classList.toggle("on", b === btn));
      if (window.updateFlowLayer) window.updateFlowLayer(); // 컨트롤 표시 전환 포함
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
  syncModeControls(); // 플로우 기본 — 모드에 맞는 컨트롤 그룹만 표시

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
      const flow = map.getLayer("flow-lines") ? map.queryRenderedFeatures({ layers: ["flow-lines"] }).length : -1;
      const lm = map.getLayer("landmarks") ? map.queryRenderedFeatures({ layers: ["landmarks"] }).length : -1;
      document.title = `MAPTEST loaded=${map.loaded()} hex=${hex} flow=${flow} lm=${lm} err=${errs.slice(0, 2).join(";") || "none"}`;
    });
  }
}

init().catch((e) => {
  console.error("초기화 실패:", e);
  const hero = document.querySelector(".hero");
  if (hero) {
    const msg = document.createElement("p");
    msg.className = "load-error";
    msg.textContent = "데이터 로드 실패 — 새로고침 필요. 문제가 계속되면 GitHub 저장소 이슈로 제보.";
    hero.appendChild(msg);
  }
});
