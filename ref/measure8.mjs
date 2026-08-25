/* 8차 측정 — 뷰포트 contain-fit 검증.
   가로가 긴 여러 출력장치 크기에서 (1) 스크롤 발생 여부, (2) 대시보드 비율·여백,
   (3) 좌우 컬럼 하단 정렬, (4) 레이어 전환 시 세로 흔들림, (5) 리사이즈 후 차트 추종을 측정. */
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p)) || "chrome";
const PORT = 9342;
const BASE = process.env.VERIFY_BASE || "http://127.0.0.1:8031";

// 가로가 긴 대표 출력장치의 "브라우저 뷰포트" 크기 (OS/브라우저 크롬 제외 추정치)
const SIZES = [
  { label: "1080p           ", w: 1920, h: 937 },
  { label: "1440p           ", w: 2560, h: 1300 },
  { label: "ultrawide 3440  ", w: 3440, h: 1300 },
  { label: "laptop 125%     ", w: 1229, h: 560 },
  { label: "1366x768        ", w: 1366, h: 625 },
  { label: "wide-short      ", w: 1920, h: 640 },
  { label: "1280x720        ", w: 1280, h: 585 },
  { label: "1280x720 full   ", w: 1280, h: 720 },
  { label: "1600x900        ", w: 1600, h: 817 },
  { label: "1920x1080 full  ", w: 1920, h: 1080 },
  { label: "1024x768 full   ", w: 1024, h: 768 },
];

const userDir = mkdtempSync(join(tmpdir(), "cdp-"));
const chrome = spawn(CHROME, [
  "--headless=new", `--remote-debugging-port=${PORT}`,
  "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
  "--no-first-run", "--no-default-browser-check",
  "--window-size=1920,1080", `--user-data-dir=${userDir}`, "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(300);
  }
  throw new Error("CDP endpoint not reachable");
}
let msgId = 0; const pending = new Map(); let ws;
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
async function evaluate(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
}
async function waitFor(expr, timeoutMs = 60000, label = "") {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(expr)) return;
    await sleep(300);
  }
  throw new Error("timeout waiting for: " + (label || expr));
}

const PROBE = `(() => {
  const r = (s) => { const e = document.querySelector(s); return e ? e.getBoundingClientRect() : null; };
  const dash = r(".dash"), mapc = r(".map-col"), panel = r(".panel"), foot = r(".foot");
  const de = document.documentElement;
  return JSON.stringify({
    vw: window.innerWidth, vh: window.innerHeight,
    scrollH: de.scrollHeight,
    overflow: de.scrollHeight - window.innerHeight,
    dashW: Math.round(dash.width), dashH: Math.round(dash.height),
    ratio: +(dash.width / dash.height).toFixed(3),
    sideMargin: Math.round(dash.left),
    topMargin: Math.round(dash.top),
    footBottomGap: Math.round(window.innerHeight - foot.bottom),
    bottomAlignDelta: Math.round(mapc.bottom - panel.bottom),
    mapH: Math.round(r("#map").height),
    ctlH: Math.round(r(".controls").height),
    hourH: Math.round(r("#chart-hour").height),
    heatH: Math.round(r("#chart-heat").height),
    heatRatio: +((r("#chart-heat").height - 32) / ((r("#chart-heat").width - 66) * 7 / 24)).toFixed(3),
    panelW: Math.round(panel.width),
    panelNeed: document.querySelector(".panel").scrollHeight,
    panelSpill: Math.max(0, document.querySelector(".panel").scrollHeight - Math.round(panel.height)),
  });
})()`;

try {
  const wsUrl = await getWsUrl();
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");

  console.log("size             vw x vh    | dash W x H   ratio | overflow | side/top mgn | mapH ctlH hourH heatH | botAlign");
  console.log("-".repeat(122));

  for (const s of SIZES) {
    await send("Emulation.setDeviceMetricsOverride", { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `${BASE}/` });
    await waitFor(`!!(document.querySelector("#chart-heat") && document.querySelector("#chart-heat").data)`, 60000, "charts");
    await sleep(500);
    const m = JSON.parse(await evaluate(PROBE));
    const flag = m.overflow > 0 ? " <-- SCROLL" : "";
    console.log(
      `${s.label} ${String(m.vw).padStart(4)}x${String(m.vh).padStart(4)} | ` +
      `${String(m.dashW).padStart(4)} x ${String(m.dashH).padStart(4)} ${String(m.ratio).padStart(5)} | ` +
      `${String(m.overflow).padStart(8)} | ${String(m.sideMargin).padStart(5)}/${String(m.topMargin).padStart(4)}  | ` +
      `${String(m.mapH).padStart(4)} ${String(m.ctlH).padStart(4)} ${String(m.hourH).padStart(5)} ${String(m.heatH).padStart(5)} | ` +
      `${String(m.bottomAlignDelta).padStart(4)} | pw${String(m.panelW).padStart(4)} spill${String(m.panelSpill).padStart(3)}${flag}`
    );
  }

  // 레이어 전환 시 세로 흔들림 (차트 y좌표 이동량)
  await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 937, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/` });
  await waitFor(`!!(document.querySelector("#chart-heat") && document.querySelector("#chart-heat").data)`, 60000, "charts");
  await sleep(500);
  const shift = JSON.parse(await evaluate(`(() => {
    const y = () => [document.querySelector("#chart-hour").getBoundingClientRect().top,
                     document.querySelector("#chart-heat").getBoundingClientRect().top];
    const a = y();
    document.querySelector('.layer-switch [data-layer="hex"]').click();
    const b = y();
    document.querySelector('.layer-switch [data-layer="flow"]').click();
    const c = y();
    return JSON.stringify({ flow: a, hex: b, back: c,
      shift: [Math.round(b[0]-a[0]), Math.round(b[1]-a[1])] });
  })()`));
  console.log("\n레이어 전환 세로 이동량 [hour, heat] =", JSON.stringify(shift.shift), "(0,0이면 흔들림 없음)");

  // 좁은 폭에서도 모드 전환이 세로를 흔들지 않는지 (헥스 컨트롤은 3줄)
  for (const [w, h] of [[1366, 625], [1047, 640]]) {
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `${BASE}/` });
    await waitFor(`!!(document.querySelector("#chart-heat") && document.querySelector("#chart-heat").data)`, 60000);
    await sleep(500);
    const r = JSON.parse(await evaluate(`(() => {
      const probe = () => ({
        hour: Math.round(document.querySelector("#chart-hour").getBoundingClientRect().top),
        heat: Math.round(document.querySelector("#chart-heat").getBoundingClientRect().top),
        ctl: Math.round(document.querySelector(".controls").getBoundingClientRect().height),
        ovf: document.documentElement.scrollHeight - window.innerHeight,
      });
      const a = probe();
      document.querySelector('.layer-switch [data-layer="hex"]').click();
      const b = probe();
      document.querySelector('.layer-switch [data-layer="flow"]').click();
      return JSON.stringify({ flow: a, hex: b, shift: [b.hour-a.hour, b.heat-a.heat] });
    })()`));
    console.log(`  @${w}x${h}: shift=${JSON.stringify(r.shift)} ctl flow/hex=${r.flow.ctl}/${r.hex.ctl} ovf flow/hex=${r.flow.ovf}/${r.hex.ovf}`);
  }

  // 리사이즈 핸들러: 리로드 없이 창만 줄였을 때 차트가 컨테이너를 따라가는지
  const before = JSON.parse(await evaluate(PROBE));
  await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 625, deviceScaleFactor: 1, mobile: false });
  await sleep(900); // 디바운스 150ms + Plotly 재렌더
  const after = JSON.parse(await evaluate(`(() => {
    const el = document.querySelector("#chart-heat"), hr = document.querySelector("#chart-hour");
    const inner = (d) => { const p = d.querySelector(".main-svg"); return p ? Math.round(p.getBoundingClientRect().height) : -1; };
    const r = el.getBoundingClientRect();
    return JSON.stringify({
      overflow: document.documentElement.scrollHeight - window.innerHeight,
      heatBoxH: Math.round(r.height), heatSvgH: inner(el),
      hourBoxH: Math.round(hr.getBoundingClientRect().height), hourSvgH: inner(hr),
      heatRatio: +((r.height - 32) / ((r.width - 66) * 7 / 24)).toFixed(3),
    });
  })()`));
  console.log("리사이즈(1920x937 -> 1366x625) 후:", JSON.stringify(after));
  console.log("  before heatH/hourH =", before.heatH, "/", before.hourH);
  console.log("  SVG가 박스 높이를 따라가면 heatBoxH≈heatSvgH, hourBoxH≈hourSvgH");
} catch (e) {
  console.error("MEASURE ERROR:", e.message);
  process.exitCode = 2;
} finally {
  try { ws && ws.close(); } catch {}
  chrome.kill();
}
