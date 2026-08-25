/* NYC Taxi Traffic 대시보드 — 헥스빈 지도 + 요일·시간 필터 */
"use strict";

// ---------- 상태 ----------
const state = { days: new Set([0, 1, 2, 3, 4, 5, 6]), hour: null, metric: "speed", layer: "flow", flowWp: "all", flowBand: "all" };

const DAY_RANGE = { wd: [0, 1, 2, 3, 4], we: [5, 6], all: [0, 1, 2, 3, 4, 5, 6] };

// 플로우 시간대(밴드) → 해당 6시간 Set. 0→0–5, 1→6–11, 2→12–17, 3→18–23
function bandHours(b) {
  const base = b * 6; // 0→0,1→6,2→12,3→18
  return new Set([base, base + 1, base + 2, base + 3, base + 4, base + 5]);
}

// 플로우 요일 범위 → 헥스 요일 선택·시간(전체)으로 동기화. 히스토그램·KPI가 같은 선택을 따름.
function applyFlowDayRange() {
  state.days = new Set(DAY_RANGE[state.flowWp] || DAY_RANGE.all);
  state.hour = null;
  document.querySelectorAll(".ctl-days button[data-day]").forEach((b) =>
    b.classList.toggle("on", state.days.has(+b.dataset.day)));
  const daysAll = document.getElementById("days-all");
  if (daysAll) daysAll.classList.toggle("on", state.days.size === 7);
  const hourAll = document.getElementById("hour-all");
  const hourInput = document.getElementById("hour");
  const hourLabel = document.getElementById("hour-label");
  if (hourAll) hourAll.classList.add("on");
  if (hourInput) hourInput.disabled = true;
  if (hourLabel) hourLabel.textContent = "";
  refresh();
}

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
// 속력: 도로망 최단경로 거리 기준 값에 맞춘 고정 스톱.
// 저속(정체)=검붉음으로 끝맺고 저속 구간에 스톱을 촘촘히 배치해 색 해상도↑ (R3)
const FILL_SPEED = ["interpolate", ["linear"], ["get", "speed"],
  6, "#2a0a0a", 9, "#7a1717", 12, "#c73030", 16, "#e08c3a", 22, "#c9c94a", 30, "#3f9e63"];

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

// 색/두께 분리 (9차): 색 = 세그먼트 평균 속력(s, 정체=검붉음), 두께 = 통행량(n).
// 색은 속력 기준 고정 램프 — 헥스 FILL_SPEED와 동일 의미론(저속=검붉음 → 고속=초록).
// 넓은 간선은 통행이 많아도(굵어도) 안 막힐 수 있으므로 색을 n에서 분리해 정체를 정확히 표현.
const FLOW_SPEED_COLOR = ["interpolate", ["linear"], ["get", "s"],
  6, "#2a0a0a", 9, "#7a1717", 12, "#c73030", 16, "#e08c3a", 22, "#c9c94a", 30, "#3f9e63"];
// 두께·투명도는 통행량 n 기준. 고정 스톱이면 "전체×전체"(n 수백)에서 포화 →
// 슬라이스별 n 분위수(p55/p78/p92/p99)로 스톱을 동적 구성 (헥스빈 buildCountColor와 같은 패턴).
const FLOW_WIDTHS = [0.5, 1.4, 2.4, 3.6, 5.5];

function buildFlowPaint(fc) {
  const ns = fc.features.map((f) => f.properties.n).sort((a, b) => a - b);
  const lo = ns.length ? ns[0] : 3;
  const hi = ns.length ? ns[ns.length - 1] : 150;
  let width, opacity;
  if (ns.length >= 5 && hi > lo) {
    // 고통행 구간을 세밀하게: 상위 분위수를 촘촘히 (p55/p78/p92/p99)
    const stops = [lo, quantileSorted(ns, 0.55), quantileSorted(ns, 0.78), quantileSorted(ns, 0.92), quantileSorted(ns, 0.99)];
    for (let i = 1; i < stops.length; i++) if (stops[i] <= stops[i - 1]) stops[i] = stops[i - 1] + 1e-6;
    width = ["interpolate", ["linear"], ["get", "n"],
      stops[0], FLOW_WIDTHS[0], stops[1], FLOW_WIDTHS[1], stops[2], FLOW_WIDTHS[2], stops[3], FLOW_WIDTHS[3], stops[4], FLOW_WIDTHS[4]];
    opacity = ["interpolate", ["linear"], ["get", "n"], stops[0], 0.5, stops[2], 0.8, stops[4], 0.98];
  } else {
    // 퇴화 케이스(피처 적음): [lo, hi] 2스톱 폴백으로 최소 대비 보장
    const top = Math.max(hi, lo + 1);
    width = ["interpolate", ["linear"], ["get", "n"], lo, FLOW_WIDTHS[0], top, FLOW_WIDTHS[4]];
    opacity = ["interpolate", ["linear"], ["get", "n"], lo, 0.5, top, 0.98];
  }
  return { color: FLOW_SPEED_COLOR, width, opacity };
}

// 모드별 컨트롤 표시 전환: 플로우 → .ctl-flow만, 헥스 → 요일/시간/지표만
// (헥스 모드 내 "전체 시간" 토글의 슬라이더 disabled 상태는 setHourAll이 별도 관리)
function syncModeControls() {
  const flowMode = state.layer === "flow";
  document.querySelectorAll(".ctl-flow").forEach((grp) => { grp.hidden = !flowMode; });
  for (const sel of [".ctl-days", ".ctl-hour", ".ctl-metric"]) {
    const grp = document.querySelector(sel);
    if (grp) grp.hidden = flowMode;
  }
  // 플로우(2줄)는 패딩·gap을 키워 헥스(3줄)와 카드 높이를 근접 (style.css .mode-flow)
  const card = document.querySelector(".controls");
  if (card) card.classList.toggle("mode-flow", flowMode);
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
    // .ctl-note는 플로우 로딩/실패 상태 표시 전용 (기본은 빈 텍스트)
    const note = document.querySelector(".ctl-note");
    if (note) note.textContent = "로드 중…";
    try {
      flowCache[key] = await fetch(`data/flow_${state.flowWp}_${state.flowBand}.geojson`).then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      });
      if (note) note.textContent = "";
    } catch (e) {
      console.error("플로우 로드 실패:", e);
      if (note) note.textContent = "플로우 데이터 로드 실패";
      return;
    }
  }
  if (seq !== flowReq) return; // 그 사이 다른 슬라이스가 요청됨
  map.getSource("flow").setData(flowCache[key]);
  // 슬라이스별 동적 스케일 — n 분포가 슬라이스마다 크게 달라(최대 수십~수백) 분위수로 재산정
  const paint = buildFlowPaint(flowCache[key]);
  map.setPaintProperty("flow-lines", "line-color", paint.color);
  map.setPaintProperty("flow-lines", "line-width", paint.width);
  map.setPaintProperty("flow-lines", "line-opacity", paint.opacity);
};

// ---------- KPI ----------
// KPI: 현재 선택 기준 재계산. 플로우 모드는 요일범위 + 시간대(밴드), 헥스 모드는
// state.days + state.hour. 최저속 시간대는 헥스=선택 요일 전 시간, 플로우=선택 밴드
// 시간에서 산출(전체 밴드는 전 시간). 기본(전체 요일·전체 시간)은 meta와 동일.
function updateKpis() {
  if (!TRIPS) return;
  const { dow, hr, v, km } = TRIPS;
  const flow = state.layer === "flow";
  // 통계 대상 시간 필터
  const statHours = flow
    ? (state.flowBand === "all" ? null : bandHours(state.flowBand))
    : (state.hour === null ? null : new Set([state.hour]));
  // 최저속 시간대 산출 범위 (헥스는 단일 시간 선택과 무관하게 선택 요일 전 시간)
  const slowHours = flow
    ? (state.flowBand === "all" ? null : bandHours(state.flowBand))
    : null;
  let n = 0, sv = 0, sk = 0;
  const hSum = new Array(24).fill(0), hCnt = new Array(24).fill(0);
  for (let i = 0; i < dow.length; i++) {
    if (!state.days.has(dow[i])) continue;
    if (slowHours === null || slowHours.has(hr[i])) { hSum[hr[i]] += v[i]; hCnt[hr[i]]++; }
    if (statHours !== null && !statHours.has(hr[i])) continue;
    n++; sv += v[i]; sk += km[i];
  }
  const fmt = (x) => x.toLocaleString("en-US");
  document.getElementById("kpi-total").textContent = n ? fmt(n) : "—";
  document.getElementById("kpi-speed").textContent = n ? (sv / n).toFixed(1) + " km/h" : "—";
  document.getElementById("kpi-dist").textContent = n ? (sk / n).toFixed(2) + " km" : "—";
  let slow = -1, slowV = Infinity;
  for (let h = 0; h < 24; h++) {
    if (hCnt[h] && hSum[h] / hCnt[h] < slowV) { slowV = hSum[h] / hCnt[h]; slow = h; }
  }
  document.getElementById("kpi-slowest").textContent = slow >= 0 ? slow + "시" : "—";
}

// ---------- 보조 차트 (Plotly) ----------
const CHART_FONT = '"Pretendard", -apple-system, "Segoe UI", "Noto Sans KR", "Malgun Gothic", sans-serif';
const CHART_CONFIG = { displayModeBar: false, responsive: true };
const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];

// 컨테이너 폭 기준 히트맵 높이 산정 — 최초 렌더와 리사이즈 핸들러가 공유.
// 우측 패널 폭(~420px) 기준 compact: 셀 정방 비율을 따르되 최소 가독선 120px 확보
// (좌우 여백 l26+r4 + 세로 컬러바(thickness 8 + 틱) ~36px ≈ 66, 상하 여백 t8+b24 = 32)
function sizeHeatBox() {
  const el = document.getElementById("chart-heat");
  if (!el) return null;
  const w = el.clientWidth || 420;
  el.style.height = Math.max(120, Math.round((w - 66) * 7 / 24) + 32) + "px";
  return el;
}

// 요일×시간 평균 속력 히트맵 — 필터와 무관한 전역 패턴 (1회만 렌더)
function renderHeatChart() {
  if (!window.Plotly) return;

  sizeHeatBox();

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
    colorscale: [[0, "#2a0a0a"], [0.12, "#7a1717"], [0.28, "#c73030"], [0.52, "#e08c3a"], [0.74, "#c9c94a"], [1, "#3f9e63"]],
    colorbar: { title: { text: "km/h", side: "top", font: { size: 9 } }, thickness: 8, outlinewidth: 0, tickfont: { size: 9 } },
    // x축 ticksuffix "시"가 hover의 %{x} 포맷에도 적용됨 — "시"를 덧붙이면 "18시시"로 중복
    hovertemplate: "%{y}요일 %{x} · 평균 %{z} km/h · 표본 %{customdata}건<extra></extra>",
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
  const flow = state.layer === "flow";
  const highlight = flow
    ? (state.flowBand === "all" ? null : bandHours(state.flowBand))
    : (state.hour === null ? null : new Set([state.hour]));
  const colors = counts.map((_, h) => (highlight && highlight.has(h) ? "#345995" : "#7f9cc9"));

  Plotly.react("chart-hour", [{
    type: "bar",
    x: [...Array(24).keys()],
    y: counts,
    marker: { color: colors },
    // ticksuffix "시"가 hover의 %{x}에도 적용되므로 "시"를 덧붙이지 않음 ("18시시" 방지)
    hovertemplate: "%{x} · %{y:,}건<extra></extra>",
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

// 뷰포트 contain-fit 레이아웃에서는 창 크기가 곧 차트 크기 — 시간대 차트는 잔여
// 세로를, 히트맵은 폭에서 역산한 세로를 따라가야 하므로 리사이즈에서 명시적 재계산.
// (Plotly의 responsive:true는 컨테이너 세로 변화를 스스로 따라가지 않음)
let chartResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => {
    if (!window.Plotly) return;
    const heat = sizeHeatBox();
    for (const el of [document.getElementById("chart-hour"), heat]) {
      if (el && el.data) Plotly.Plots.resize(el); // el.data — 렌더 완료된 그래프 div만
    }
  }, 150);
});

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
    // 데이터 전체 bbox fitBounds 후 줌 +1 (센터 유지) — bbox 전체보다 "한 번 확대된"
    // 시작 화면이 요구사항. animate:false는 동기(jumpTo)라 직후 캡처 가능.
    // 리셋 버튼(⟲)도 이 실측 시점으로 복원.
    try {
      const bounds = computeDataBounds();
      if (bounds) {
        map.fitBounds(bounds, { padding: 24, animate: false });
        map.setZoom(map.getZoom() + 1);
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
      // 색은 s 기준 고정 램프(초기부터), 두께·투명도는 updateFlowLayer가 슬라이스별로 설정.
      paint: {
        "line-color": FLOW_SPEED_COLOR,
        "line-width": ["interpolate", ["linear"], ["get", "n"], 3, FLOW_WIDTHS[0], 180, FLOW_WIDTHS[4]],
        "line-opacity": ["interpolate", ["linear"], ["get", "n"], 3, 0.5, 180, 0.98],
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
      const p = e.features[0].properties;
      popup.setLngLat(e.lngLat).setHTML(`통행 ${p.n}회 · 평균 ${p.s} km/h`).addTo(map);
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
  updateKpis();
}
window.__refresh = refresh;

// ---------- 컨트롤 바인딩 ----------
function bindControls() {
  const dayBtns = document.querySelectorAll(".ctl-days button[data-day]");
  const daysAllBtn = document.getElementById("days-all");

  // "전체 요일" 토글 상태 동기화: 7개 전부 선택이면 .on, 하나라도 빠지면 .off
  const syncDaysAll = () => daysAllBtn.classList.toggle("on", state.days.size === 7);

  dayBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = +btn.dataset.day;
      if (state.days.has(d)) { state.days.delete(d); btn.classList.remove("on"); }
      else { state.days.add(d); btn.classList.add("on"); }
      syncDaysAll();
      refresh();
    });
  });
  // 전체 요일 토글: 7개 미만 선택(0개 포함) → 전체 선택, 7개 전체 선택 → 전체 해제
  daysAllBtn.addEventListener("click", () => {
    if (state.days.size === 7) {
      state.days.clear();
      dayBtns.forEach((b) => b.classList.remove("on"));
    } else {
      dayBtns.forEach((b) => { state.days.add(+b.dataset.day); b.classList.add("on"); });
    }
    syncDaysAll();
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
      if (state.layer === "flow") applyFlowDayRange(); // 헥스→플로우 전환 시 요일을 플로우 범위로 재동기화
      if (window.updateFlowLayer) window.updateFlowLayer(); // 컨트롤 표시 전환 포함
      updateKpis();          // 모드별 KPI 로직 반영 (R1)
      window.updateCharts(); // 모드별 막대 강조 반영
    });
  });

  // 플로우 슬라이스: 요일 범위(주중/주말/전체) × 시간대(4구간+전체)
  // flowWp는 "wd"|"we"|"all", flowBand는 0..3 숫자 또는 "all" 문자열
  document.querySelectorAll(".ctl-flow button[data-wp]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.flowWp === btn.dataset.wp) return;
      state.flowWp = btn.dataset.wp;
      document.querySelectorAll(".ctl-flow button[data-wp]").forEach((b) => b.classList.toggle("on", b === btn));
      applyFlowDayRange();
      window.updateFlowLayer();
    });
  });
  document.querySelectorAll(".ctl-flow button[data-band]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const val = btn.dataset.band === "all" ? "all" : +btn.dataset.band;
      if (state.flowBand === val) return;
      state.flowBand = val;
      document.querySelectorAll(".ctl-flow button[data-band]").forEach((b) => b.classList.toggle("on", b === btn));
      window.updateFlowLayer();
      updateKpis();          // 밴드 선택이 KPI를 좌우 (R1)
      window.updateCharts(); // 히스토그램 밴드 시간대 막대 강조
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
  updateKpis();
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
