// Proof harness for the auto zoom: runs the camera over synthetic click and cursor timelines,
// prints the motion metrics, and renders a comparison video and contact sheets over a test pattern.
//   node scripts/zoom-proof.ts [outDir] [oldModel.ts]
// outDir defaults to the system temp folder; oldModel (optional) is a copy of an older zoom-core.ts
// to compare against. Needs Node 23+ (runs TypeScript directly), sharp and ffmpeg-static.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as NEW from "../src/renderer/modules/record/zoom-core.ts";

const require = createRequire(import.meta.url);
const sharp = require("sharp");
const ffmpeg: string = require("ffmpeg-static");

const OUT = resolve(process.argv[2] ?? join(tmpdir(), "ot-zoom"));
const OLD_PATH = process.argv[3];
mkdirSync(OUT, { recursive: true });

type Pt = { x: number; y: number };
type TP = Pt & { t: number };
type Frame = { t: number; scale: number; x: number; y: number };
interface Model {
  simulateCamera(clicks: TP[], cursor: TP[], durationMs: number, fps: number): Frame[];
  LiveZoom: new () => { click(p: Pt, t: number): void; move(t: number): void; update(t: number, c: Pt | null, ahead?: Pt | null): Omit<Frame, "t"> };
}

// ---- synthetic timelines ----

/** a smooth human-like move between waypoints (minimum jerk), sampled like the pointer poller */
function cursorPath(keys: { t: number; x: number; y: number }[], durationMs: number, seed = 1): TP[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const out: TP[] = [];
  const mj = (u: number) => u * u * u * (10 - 15 * u + 6 * u * u);
  let last: Pt | null = null;
  for (let t = 0; t <= durationMs; t += 1000 / 60 + rnd() * 4) {
    let p: Pt = keys[0];
    for (let i = 0; i + 1 < keys.length; i++) {
      const a = keys[i], b = keys[i + 1];
      if (t >= a.t && t < b.t) { const u = mj((t - a.t) / (b.t - a.t)); p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }; break; }
      if (t >= b.t) p = b;
    }
    // hand tremor and DIP rounding: under a pixel
    const q = { x: p.x + rnd() * 0.0006, y: p.y + rnd() * 0.0006 };
    if (!last || q.x !== last.x || q.y !== last.y) out.push({ t: Math.round(t), ...q });
    last = q;
  }
  return out;
}

interface Scenario { name: string; title: string; durationMs: number; clicks: TP[]; cursor: TP[] }

const hold = (x: number, y: number, t: number) => ({ t, x, y });
const SCENARIOS: Scenario[] = [
  {
    name: "single", title: "One click", durationMs: 7000,
    clicks: [{ t: 2000, x: 0.68, y: 0.36 }],
    cursor: cursorPath([hold(0.3, 0.62, 0), hold(0.3, 0.62, 1200), hold(0.68, 0.36, 1850), hold(0.68, 0.36, 7000)], 7000),
  },
  {
    name: "burst", title: "Click burst", durationMs: 8000,
    clicks: [1800, 2200, 2700, 3300].map((t, i) => ({ t, x: 0.42 + i * 0.03, y: 0.55 - i * 0.015 })),
    cursor: cursorPath([hold(0.7, 0.2, 0), hold(0.7, 0.2, 1000), hold(0.42, 0.55, 1700), hold(0.45, 0.535, 2150), hold(0.48, 0.52, 2650), hold(0.51, 0.505, 3250), hold(0.51, 0.505, 8000)], 8000, 2),
  },
  {
    name: "far", title: "Two far clicks", durationMs: 9000,
    clicks: [{ t: 1800, x: 0.18, y: 0.2 }, { t: 4200, x: 0.84, y: 0.78 }],
    cursor: cursorPath([hold(0.5, 0.5, 0), hold(0.5, 0.5, 900), hold(0.18, 0.2, 1650), hold(0.18, 0.2, 3200), hold(0.84, 0.78, 4050), hold(0.84, 0.78, 9000)], 9000, 3),
  },
  {
    name: "drag", title: "Drag while zoomed", durationMs: 8000,
    clicks: [{ t: 1500, x: 0.25, y: 0.5 }],
    cursor: cursorPath([hold(0.3, 0.3, 0), hold(0.25, 0.5, 1300), hold(0.25, 0.5, 1700), hold(0.8, 0.45, 3500), hold(0.8, 0.45, 8000)], 8000, 4),
  },
  {
    name: "typing", title: "Typing while zoomed", durationMs: 9000,
    clicks: [{ t: 1500, x: 0.35, y: 0.3 }, { t: 5200, x: 0.37, y: 0.31 }],
    cursor: cursorPath([hold(0.6, 0.6, 0), hold(0.35, 0.3, 1350), hold(0.35, 0.3, 4800), hold(0.37, 0.31, 5100), hold(0.37, 0.31, 9000)], 9000, 5),
  },
  {
    name: "edge", title: "Click at the edge", durationMs: 7000,
    clicks: [{ t: 1800, x: 0.97, y: 0.04 }],
    cursor: cursorPath([hold(0.6, 0.5, 0), hold(0.6, 0.5, 900), hold(0.97, 0.04, 1700), hold(0.97, 0.04, 7000)], 7000, 6),
  },
];

// ---- running a model ----

const FPS = 60;
/** the live compositor: clicks arrive when they happen, the cursor in 50 ms batches (last sample used) */
function runLive(m: Model, sc: Scenario, fps = FPS): Frame[] {
  const z = new m.LiveZoom();
  const frames: Frame[] = [];
  let ci = 0, si = 0, cursor: Pt | null = null, nextFlush = 50;
  for (let i = 0; i * (1000 / fps) <= sc.durationMs; i++) {
    const t = i * (1000 / fps);
    while (nextFlush <= t) {
      let lastS: TP | null = null;
      while (si < sc.cursor.length && sc.cursor[si].t <= nextFlush) lastS = sc.cursor[si++];
      if (lastS) { cursor = lastS; z.move(lastS.t); }
      nextFlush += 50;
    }
    while (ci < sc.clicks.length && sc.clicks[ci].t <= t) { const c = sc.clicks[ci++]; z.click(c, c.t); }
    frames.push({ t, ...z.update(t, cursor) });
  }
  return frames;
}
const runExport = (m: Model, sc: Scenario, fps = FPS) => m.simulateCamera(sc.clicks, sc.cursor, sc.durationMs, fps);

/**
 * The delayed live recording (engine.ts during a take with auto zoom): the picture at time t is drawn
 * at real time t + DELAY_MS, when every click up to then has arrived (at its real time) and the cursor
 * trail is known up to then (in 50 ms batches).
 */
function runDelayed(m: Model, sc: Scenario, fps = FPS, delayMs = 800, cursorLeadMs = 500): Frame[] {
  const z = new m.LiveZoom();
  const frames: Frame[] = [];
  let ci = 0, si = 0, nextFlush = 50;
  const trail: TP[] = [];
  for (let i = 0; i * (1000 / fps) <= sc.durationMs; i++) {
    const t = i * (1000 / fps), now = t + delayMs;
    while (nextFlush <= now) { while (si < sc.cursor.length && sc.cursor[si].t <= nextFlush) trail.push(sc.cursor[si++]); nextFlush += 50; }
    while (ci < sc.clicks.length && sc.clicks[ci].t <= now) { const c = sc.clicks[ci++]; z.click(c, c.t); }
    frames.push({ t, ...z.update(t, NEW.cursorAt(trail, t), NEW.cursorAt(trail, t + cursorLeadMs)) });
  }
  return frames;
}
type Path = "live" | "delayed" | "export";
const run = (m: Model, sc: Scenario, path: Path, fps = FPS) => (path === "live" ? runLive(m, sc, fps) : path === "delayed" ? runDelayed(m, sc, fps) : runExport(m, sc, fps));
const PATH_LABEL: Record<Path, string> = { live: "live recording", delayed: "live recording (delayed)", export: "hi-res export" };

// ---- metrics ----

const W = 1920, H = 1080;
interface Metrics {
  overshoot: number; outside: number; jerkZoom: number; jerkPan: number; velJump: number;
  drift: number; backtrack: number; lag90: number | null; cursorHidden: number; settleMs: number | null;
}

function metrics(fr: Frame[], sc: Scenario, maxScale: number): Metrics {
  const dt = fr[1].t - fr[0].t;
  const z = fr.map((f) => Math.log(f.scale));
  // content motion on screen: the view centre in output pixels of the zoomed picture
  const cx = fr.map((f) => f.x * W), cy = fr.map((f) => f.y * H);
  const d1 = (a: number[]) => a.slice(1).map((v, i) => (v - a[i]) / (dt / 1000));
  const vz = d1(z), az = d1(vz), jz = d1(az);
  const vx = d1(cx), vy = d1(cy);
  const ax = d1(vx), ay = d1(vy);
  const jx = d1(ax), jy = d1(ay);
  const jerkZoom = Math.max(...jz.map(Math.abs));
  const jerkPan = Math.max(...jx.map((v, i) => Math.hypot(v, jy[i])));
  // a smooth curve changes its velocity a little each frame: the worst change against the peak speed
  const speed = vx.map((v, i) => Math.hypot(v, vy[i]));
  const peak = Math.max(1e-9, ...speed);
  const peakZ = Math.max(1e-9, ...vz.map(Math.abs));
  let velJump = 0;
  for (let i = 1; i < vx.length; i++) {
    velJump = Math.max(velJump, Math.hypot(vx[i] - vx[i - 1], vy[i] - vy[i - 1]) / peak, Math.abs(vz[i] - vz[i - 1]) / peakZ);
  }
  const overshoot = Math.max(0, ...fr.map((f) => f.scale - maxScale), ...fr.map((f) => 1 - f.scale));
  const outside = Math.max(0, ...fr.map((f) => { const h = 0.5 / f.scale; return Math.max(h - f.x, f.x + h - 1, h - f.y, f.y + h - 1); }));

  // the first click: its point's path on screen while the zoom comes in
  const c0 = sc.clicks[0];
  const scr = (f: Frame) => ({ x: ((c0.x - (f.x - 0.5 / f.scale)) * f.scale) * W, y: ((c0.y - (f.y - 0.5 / f.scale)) * f.scale) * H });
  const zTarget = Math.log(maxScale);
  const iStart = fr.findIndex((f) => f.scale > 1.001);
  let iEnd = fr.findIndex((f, i) => i > iStart && Math.log(f.scale) >= zTarget * 0.995);
  if (iEnd < 0) iEnd = fr.length - 1;
  let drift = 0, backtrack = 0;
  if (iStart > 0) {
    const a = scr(fr[iStart - 1]), b = scr(fr[iEnd]);
    const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
    let far = 0;
    for (let i = iStart; i <= iEnd; i++) {
      const p = scr(fr[i]);
      const along = (p.x - a.x) * ux + (p.y - a.y) * uy;
      const perp = Math.abs(-(p.x - a.x) * uy + (p.y - a.y) * ux);
      drift = Math.max(drift, perp);
      far = Math.max(far, along);
      backtrack = Math.max(backtrack, far - along, along - L);
    }
  }
  const i90 = fr.findIndex((f) => Math.log(f.scale) >= zTarget * 0.9);
  const lag90 = i90 >= 0 ? fr[i90].t - c0.t : null;
  const settle = iEnd >= 0 && iStart >= 0 ? fr[iEnd].t - fr[iStart].t : null;

  // while zoomed in, how often the real cursor is outside the picture
  let zoomedFrames = 0, hidden = 0;
  for (const f of fr) {
    if (f.scale < maxScale * 0.97) continue;
    const p = NEW.cursorAt(sc.cursor, f.t);
    if (!p) continue;
    zoomedFrames++;
    const h = 0.5 / f.scale;
    if (Math.abs(p.x - f.x) > h || Math.abs(p.y - f.y) > h) hidden++;
  }
  return { overshoot, outside, jerkZoom, jerkPan, velJump, drift, backtrack, lag90, cursorHidden: zoomedFrames ? hidden / zoomedFrames : 0, settleMs: settle };
}

// ---- rendering ----

const PW = 960, PH = 540;

async function testPattern(): Promise<Buffer> {
  // a desktop-like page: grid, labelled cells, a toolbar, buttons and text, so drift and swoops show
  const cells: string[] = [];
  for (let gy = 0; gy < 12; gy++) for (let gx = 0; gx < 16; gx++) {
    const x = gx * 120, y = gy * 90;
    const shade = (gx + gy) % 2 ? "#f4f5f7" : "#e9ecf1";
    cells.push(`<rect x="${x}" y="${y}" width="120" height="90" fill="${shade}"/>`);
    cells.push(`<text x="${x + 8}" y="${y + 22}" font-family="Segoe UI, Arial" font-size="16" fill="#8a90a0">${String.fromCharCode(65 + gx)}${gy + 1}</text>`);
  }
  const lines: string[] = [];
  for (let x = 0; x <= W; x += 120) lines.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="#c9ced8" stroke-width="2"/>`);
  for (let y = 0; y <= H; y += 90) lines.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="#c9ced8" stroke-width="2"/>`);
  const ui = `
    <rect x="0" y="0" width="${W}" height="56" fill="#1f2430"/>
    <text x="24" y="37" font-family="Segoe UI, Arial" font-size="24" fill="#fff" font-weight="600">OpenTake zoom proof</text>
    <rect x="1250" y="350" width="260" height="70" rx="12" fill="#006f4f"/><text x="1290" y="395" font-family="Segoe UI, Arial" font-size="28" fill="#fff">Save changes</text>
    <rect x="270" y="1020" width="300" height="60" rx="10" fill="#ff6b3d"/>
    <rect x="1780" y="70" width="120" height="44" rx="8" fill="#3d6bff"/><text x="1800" y="100" font-family="Segoe UI, Arial" font-size="22" fill="#fff">Share</text>
    <rect x="560" y="245" width="420" height="44" rx="6" fill="#fff" stroke="#5a6070" stroke-width="2"/>
    <text x="575" y="276" font-family="Consolas, monospace" font-size="22" fill="#222">hello@example.com|</text>
    <circle cx="960" cy="540" r="6" fill="#e0245e"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${cells.join("")}${lines.join("")}${ui}</svg>`;
  return sharp(Buffer.from(svg)).removeAlpha().raw().toBuffer();
}

/** draws one camera frame of the pattern into a PW x PH panel (bilinear, sub-pixel) */
function renderPanel(src: Buffer, f: Frame, out: Buffer, ox: number, oy: number, stride: number) {
  const size = 1 / f.scale;
  const left = (f.x - size / 2) * W, top = (f.y - size / 2) * H;
  const sx = (size * W) / PW, sy = (size * H) / PH;
  for (let j = 0; j < PH; j++) {
    const v = top + (j + 0.5) * sy - 0.5;
    const y0 = Math.max(0, Math.min(H - 2, Math.floor(v))), fy = Math.min(1, Math.max(0, v - y0));
    for (let i = 0; i < PW; i++) {
      const u = left + (i + 0.5) * sx - 0.5;
      const x0 = Math.max(0, Math.min(W - 2, Math.floor(u))), fx = Math.min(1, Math.max(0, u - x0));
      const a = (y0 * W + x0) * 3, b = a + 3, c = a + W * 3, d = c + 3;
      const o = ((oy + j) * stride + ox + i) * 3;
      for (let k = 0; k < 3; k++) {
        const top_ = src[a + k] + (src[b + k] - src[a + k]) * fx;
        const bot = src[c + k] + (src[d + k] - src[c + k]) * fx;
        out[o + k] = top_ + (bot - top_) * fy;
      }
    }
  }
}

function dot(out: Buffer, stride: number, ox: number, oy: number, cx: number, cy: number, r: number, rgb: number[], ring = 0) {
  for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
    if (x < 0 || y < 0 || x >= PW || y >= PH) continue;
    const d = Math.hypot(x - cx, y - cy);
    const a = ring ? Math.max(0, 1 - Math.abs(d - r) / ring) : Math.max(0, Math.min(1, r - d + 0.5));
    if (a <= 0) continue;
    const o = ((oy + y) * stride + ox + x) * 3;
    for (let k = 0; k < 3; k++) out[o + k] = out[o + k] * (1 - a) + rgb[k] * a;
  }
}

function overlay(out: Buffer, stride: number, ox: number, oy: number, f: Frame, sc: Scenario) {
  const size = 1 / f.scale;
  const map = (p: Pt) => ({ x: ((p.x - (f.x - size / 2)) / size) * PW, y: ((p.y - (f.y - size / 2)) / size) * PH });
  for (const c of sc.clicks) {
    const age = f.t - c.t;
    if (age >= 0 && age < 500) { const m = map(c); dot(out, stride, ox, oy, m.x, m.y, 10 + age / 12, [255, 60, 60], 2.5 * (1 - age / 500) + 0.5); }
  }
  const p = NEW.cursorAt(sc.cursor, f.t);
  if (p) { const m = map(p); dot(out, stride, ox, oy, m.x, m.y, 9, [255, 255, 255]); dot(out, stride, ox, oy, m.x, m.y, 6, [20, 20, 20]); }
}

async function label(text: string, w: number, h: number): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="rgba(0,0,0,0.62)" rx="8"/><text x="14" y="${h - 13}" font-family="Segoe UI, Arial" font-size="24" fill="#fff" font-weight="600">${text}</text></svg>`;
  return sharp(Buffer.from(svg)).raw().toBuffer();
}
function blitRGBA(out: Buffer, stride: number, img: Buffer, w: number, h: number, ox: number, oy: number) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = (y * w + x) * 4, a = img[s + 3] / 255;
    if (!a) continue;
    const o = ((oy + y) * stride + ox + x) * 3;
    for (let k = 0; k < 3; k++) out[o + k] = out[o + k] * (1 - a) + img[s + k] * a;
  }
}

async function main() {
  const models: { key: string; label: string; m: Model }[] = [];
  if (OLD_PATH) models.push({ key: "old", label: "before", m: (await import(pathToFileURL(resolve(OLD_PATH)).href)) as Model });
  models.push({ key: "new", label: "after", m: NEW as unknown as Model });

  // metrics, at the take's 30 fps and at 60
  const rows: string[] = [];
  const report: Record<string, unknown> = {};
  for (const sc of SCENARIOS) for (const fps of [30, 60]) for (const { key, m } of models) for (const path of (key === "new" ? ["live", "delayed", "export"] : ["live", "export"]) as Path[]) {
    const fr = run(m, sc, path, fps);
    const r = metrics(fr, sc, NEW.DEFAULT_ZOOM.scale);
    report[`${sc.name}/${fps}/${key}/${path}`] = r;
    rows.push([sc.name.padEnd(7), String(fps).padEnd(3), key.padEnd(4), path.padEnd(7),
      r.overshoot.toFixed(4).padStart(7), r.outside.toFixed(4).padStart(7),
      r.jerkZoom.toFixed(0).padStart(7), r.jerkPan.toFixed(0).padStart(9), r.velJump.toFixed(3).padStart(6),
      r.drift.toFixed(1).padStart(6), r.backtrack.toFixed(1).padStart(6),
      (r.lag90 == null ? "-" : r.lag90.toFixed(0)).padStart(6), (r.cursorHidden * 100).toFixed(1).padStart(6),
      (r.settleMs == null ? "-" : r.settleMs.toFixed(0)).padStart(6)].join(" "));
  }
  const head = "scene   fps model path    over    outside  jerkZ   jerkPan  vJump  drift  back   lag90 hidden% settle";
  const table = [head, ...rows].join("\n");
  console.log(table);
  writeFileSync(join(OUT, "metrics.txt"), table + "\n");
  writeFileSync(join(OUT, "metrics.json"), JSON.stringify(report, null, 2));
  if (process.env.METRICS_ONLY) return;

  // the video: before and after, live on top and export below (or just after when no old model)
  const src = await testPattern();
  const cols = models.length;
  const VW = PW * cols, VH = PH * 2;
  const panels: { model: (typeof models)[number]; path: Path; ox: number; oy: number }[] = [];
  models.forEach((model, ci) => ((model.key === "new" ? ["delayed", "export"] : ["live", "export"]) as Path[]).forEach((path, ri) => panels.push({ model, path, ox: ci * PW, oy: ri * PH })));
  const labels = await Promise.all(panels.map((p) => label(`${p.model.label} - ${PATH_LABEL[p.path]}`, 420, 44)));
  const ff = spawn(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${VW}x${VH}`, "-r", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, "zoom-compare.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
  const sheetTimes: Record<string, number[]> = {};
  for (const sc of SCENARIOS) {
    const runs = panels.map((p) => run(p.model.m, sc, p.path));
    const title = await label(sc.title, 320, 44);
    const n = runs[0].length;
    // contact sheet: one row per panel, a column every 150 ms from 900 ms before the first click
    const t0 = Math.max(0, sc.clicks[0].t - 900);
    sheetTimes[sc.name] = Array.from({ length: 12 }, (_, i) => t0 + i * 150);
    const sheetFrames: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const buf = Buffer.alloc(VW * VH * 3);
      panels.forEach((p, k) => { renderPanel(src, runs[k][i], buf, p.ox, p.oy, VW); overlay(buf, VW, p.ox, p.oy, runs[k][i], sc); blitRGBA(buf, VW, labels[k], 420, 44, p.ox + 12, p.oy + PH - 56); });
      blitRGBA(buf, VW, title, 320, 44, VW - 332, 12);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
      const t = runs[0][i].t;
      if (sheetTimes[sc.name].some((s) => Math.abs(s - t) < 1000 / FPS / 2)) sheetFrames.push(buf);
    }
    // the sheet: one row per panel (model and path), one column per time
    const tw = 320, th = 180, gap = 4;
    const tiles: { input: Buffer; left: number; top: number }[] = [];
    for (const [ci, b] of sheetFrames.entries()) for (const [ri, p] of panels.entries()) {
      const input = await sharp(b, { raw: { width: VW, height: VH, channels: 3 } }).extract({ left: p.ox, top: p.oy, width: PW, height: PH }).resize(tw, th).png().toBuffer();
      tiles.push({ input, left: ci * (tw + gap), top: ri * (th + gap) });
    }
    const sheet = sharp({ create: { width: sheetFrames.length * (tw + gap), height: panels.length * (th + gap), channels: 3, background: "#000" } }).composite(tiles);
    await sheet.png().toFile(join(OUT, `sheet-${sc.name}.png`));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log(`\nwrote ${join(OUT, "zoom-compare.mp4")} and sheet-*.png (every 200 ms from 800 ms before the first click)`);
}

// ---- the hi-res export through the real ffmpeg graph: where a marker lands, frame by frame ----

/** the old export: one crop in whole even pixels (the script before the zoom chain) */
function oldCropCommands(frames: Frame[], w: number, h: number, shiftMs = 0) {
  let prev = "";
  const out: string[] = [];
  for (const f of frames) {
    const r = NEW.cropRect(f, w, h);
    const key = `${r.w} ${r.h} ${r.x} ${r.y}`;
    if (key === prev) continue;
    prev = key;
    out.push(`${(Math.max(0, f.t - shiftMs) / 1000).toFixed(3)} crop@zoom w ${r.w}, crop@zoom h ${r.h}, crop@zoom x ${r.x}, crop@zoom y ${r.y};`);
  }
  return out.join("\n") + "\n";
}

/** decoded frames of a video, one rgb24 buffer at a time */
async function* rawFrames(file: string, size: number): AsyncGenerator<Buffer> {
  const p = spawn(ffmpeg, ["-nostdin", "-v", "error", "-i", file, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { stdio: ["ignore", "pipe", "inherit"] });
  let pending: Buffer[] = [], have = 0;
  for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
    pending.push(chunk); have += chunk.length;
    while (have >= size) {
      const all = Buffer.concat(pending);
      yield all.subarray(0, size);
      const rest = all.subarray(size);
      pending = rest.length ? [rest] : []; have = rest.length;
    }
  }
}

async function exportProof() {
  // extensionless imports inside src (ffmpeg-core -> layout-core) resolve to .ts
  register("data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(s.startsWith('.'))return n(s+'.ts',c);throw e}}");
  const core = await import("../src/main/record/ffmpeg-core.ts");
  const dir = join(OUT, "export");
  mkdirSync(dir, { recursive: true });
  const sc = SCENARIOS.find((s) => s.name === "single")!;
  const secs = sc.durationMs / 1000;
  await sharp(await testPattern(), { raw: { width: W, height: H, channels: 3 } }).png().toFile(join(dir, "pattern.png"));
  execFileSync(ffmpeg, ["-nostdin", "-v", "error", "-y", "-loop", "1", "-r", "30", "-i", "pattern.png", "-t", String(secs), "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", "screen.mp4"], { cwd: dir });
  const frames = NEW.simulateCamera(sc.clicks, sc.cursor, sc.durationMs, 30);
  writeFileSync(join(dir, "new.cmd"), core.zoomCommands(frames, W, H));
  writeFileSync(join(dir, "old.cmd"), oldCropCommands(frames, W, H));
  writeFileSync(join(dir, "crop.cmd"), oldCropCommands(frames, W, H, 1000 / 60));
  const graphs = {
    old: `[0:v]fps=30,sendcmd=f=old.cmd,crop@zoom=w=${W}:h=${H}:x=0:y=0,format=yuv420p,scale=${W}:${H}:flags=lanczos,setsar=1[v]`,
    "crop-timed": `[0:v]fps=30,sendcmd=f=crop.cmd,crop@zoom=w=${W}:h=${H}:x=0:y=0,format=yuv420p,scale=${W}:${H}:flags=lanczos,setsar=1[v]`,
    new: core.hiresGraph({ input: "screen.mp4", fps: 30, trim: { start: 0, end: null }, audio: false, screen: "screen.mp4", screenSize: { width: W, height: H }, cmdFile: "new.cmd" }).parts[0].replace("[base]", "[v]"),
  };
  const lines: string[] = [];
  const marker = { x: 960, y: 540 }; // the red dot in the pattern
  for (const [k, g] of Object.entries(graphs)) {
    execFileSync(ffmpeg, ["-nostdin", "-v", "error", "-y", "-i", "screen.mp4", "-filter_complex", g, "-map", "[v]", "-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p", `export-${k}.mp4`], { cwd: dir });
    // the dot's centre on every frame, against where the exact camera puts it
    const errs: number[] = [], steps: number[] = [];
    let prevErr: { x: number; y: number } | null = null;
    let i = -1;
    for await (const raw of rawFrames(join(dir, `export-${k}.mp4`), W * H * 3)) {
      if (++i >= frames.length) break;
      const f = frames[i];
      const ex = (marker.x / W - (f.x - 0.5 / f.scale)) * f.scale * W, ey = (marker.y / H - (f.y - 0.5 / f.scale)) * f.scale * H;
      let sx = 0, sy = 0, sw = 0;
      const r = 16 * f.scale;
      for (let y = Math.max(0, Math.floor(ey - r)); y < Math.min(H, ey + r); y++) for (let x = Math.max(0, Math.floor(ex - r)); x < Math.min(W, ex + r); x++) {
        const o = (y * W + x) * 3;
        const red = raw[o] - (raw[o + 1] + raw[o + 2]) / 2; // the dot is #e0245e: strongly red
        if (red > 60) { sx += x * red; sy += y * red; sw += red; }
      }
      if (!sw) continue;
      const e = { x: sx / sw - ex, y: sy / sw - ey };
      errs.push(Math.hypot(e.x, e.y));
      if (process.env.DEBUG && Math.hypot(e.x, e.y) > 2) console.log(k, i, f.scale.toFixed(3), e.x.toFixed(1), e.y.toFixed(1), sw.toFixed(0));
      // judder: how much the error changes from one frame to the next (a smooth path keeps it steady)
      if (prevErr) steps.push(Math.hypot(e.x - prevErr.x, e.y - prevErr.y));
      prevErr = e;
    }
    const rms = (a: number[]) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / Math.max(1, a.length));
    lines.push(`${k.padEnd(10)} frames ${errs.length}  position error max ${Math.max(...errs).toFixed(2)} px rms ${rms(errs).toFixed(2)}  judder max ${Math.max(...steps).toFixed(2)} px rms ${rms(steps).toFixed(2)}`);
  }
  // side by side, to look at: before (whole-pixel crop) and after (zoom chain)
  execFileSync(ffmpeg, ["-nostdin", "-v", "error", "-y", "-i", "export-old.mp4", "-i", "export-new.mp4", "-filter_complex",
    "[0:v]crop=960:540:700:120,drawtext=text='before':x=20:y=20:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6[a];[1:v]crop=960:540:700:120,drawtext=text='after':x=20:y=20:fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6[b];[a][b]hstack[v]",
    "-map", "[v]", "-c:v", "libx264", "-crf", "14", "-pix_fmt", "yuv420p", join(OUT, "export-judder-compare.mp4")], { cwd: dir });
  const text = ["hi-res export through ffmpeg (1080p, one-click scenario, red dot tracked against the exact camera):", ...lines].join("\n");
  console.log("\n" + text);
  writeFileSync(join(OUT, "export-metrics.txt"), text + "\n");
}

if (process.env.EXPORT_ONLY) void exportProof();
else void main().then(exportProof);
