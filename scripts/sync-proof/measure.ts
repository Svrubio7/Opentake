// Lip sync of a file recorded from the synthetic pair (inject.js), read from the file alone.
// Every frame says when it was drawn (a 20-bit ms code in a block grid); every chirp starts at a whole
// second of the same clock. The sound is late by (chirp's file time + picture clock offset - its second).
//   node --experimental-transform-types scripts/sync-proof/measure.ts <file>[@x:y:w:h] ...
// (x:y:w:h = where the camera sits in the file; none = the whole frame). Record with inject.js loaded
// before the app (page.evaluateOnNewDocument) and, for the transport alone, the voice processing off:
// a noise suppressor reshapes any test sound. Compare against a recording of the pair made directly
// (the source's own offset, about 40-55 ms here): what a file adds is the difference.
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const FF: string = createRequire(import.meta.url)("ffmpeg-static");
const SW = 1280, SH = 720, GX = 340, GY = 60, CW = 100, CH = 150;
const DW = 640; // decode width

function size(file: string) {
  const m = /Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(spawnSync(FF, ["-hide_banner", "-i", file], { encoding: "utf8" }).stderr)!;
  return { w: Number(m[1]), h: Number(m[2]) };
}

/** each video frame's time and the draw time its code says (null where it cannot be read) */
function pictures(file: string, region: { x: number; y: number; w: number; h: number } | null) {
  const { w, h } = size(file);
  const DH = Math.round((h * DW) / w / 2) * 2;
  const info = spawnSync(FF, ["-nostdin", "-v", "info", "-i", file, "-an", "-fps_mode", "passthrough", "-vf", "showinfo", "-f", "null", "-"], { encoding: "utf8", maxBuffer: 1 << 28 }).stderr;
  const pts = [...info.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const raw = execFileSync(FF, ["-nostdin", "-v", "quiet", "-i", file, "-an", "-fps_mode", "passthrough", "-vf", `scale=${DW}:${DH},format=gray`, "-f", "rawvideo", "-"], { maxBuffer: 1 << 30 });
  const r = region ?? { x: 0, y: 0, w, h };
  // the source fills the region by cover (the compositor's coverCrop)
  const s = Math.max(r.w / SW, r.h / SH);
  const at = (sx: number, sy: number) => ({ x: ((r.x + r.w / 2 + (sx - SW / 2) * s) * DW) / w, y: ((r.y + r.h / 2 + (sy - SH / 2) * s) * DH) / h });
  const out: { t: number; drawn: number | null }[] = [];
  const n = Math.min(pts.length, Math.floor(raw.length / (DW * DH)));
  for (let i = 0; i < n; i++) {
    const f = raw.subarray(i * DW * DH, (i + 1) * DW * DH);
    const cell = (q: number, row: number) => {
      const c = at(GX + (q + 0.5) * CW, GY + (row + 0.5) * CH);
      let sum = 0, k = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { sum += f[(Math.round(c.y) + dy) * DW + Math.round(c.x) + dx]; k++; }
      return sum / k;
    };
    const white = cell(0, 0), black = cell(5, 0);
    let mirrored = false, hi = white, lo = black;
    if (white < black) { mirrored = true; hi = black; lo = white; }
    if (hi - lo < 60) { out.push({ t: pts[i], drawn: null }); continue; }
    const mid = (hi + lo) / 2;
    const bit = (q: number, row: number) => (cell(mirrored ? 5 - q : q, row) > mid ? 1 : 0);
    let ms = 0;
    for (let q = 1; q <= 4; q++) ms = ms * 2 + bit(q, 0);
    for (let j = 0; j < 16; j++) ms = ms * 2 + bit(j % 6, 1 + Math.floor(j / 6));
    out.push({ t: pts[i], drawn: ms });
  }
  return out;
}

/**
 * When each second's chirp (sync-inject.js) arrives, by a matched filter: off maps file time to the
 * draw clock. Returns each chirp's lateness against the picture, in ms.
 */
function chirps(file: string, off: number): number[] {
  const FS = 12000;
  const raw = execFileSync(FF, ["-nostdin", "-v", "error", "-i", file, "-vn", "-af", `aresample=${FS}:async=1:first_pts=0`, "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
  const T = 0.15, L = Math.round(T * FS);
  const tpl = new Float32Array(L);
  for (let i = 0; i < L; i++) { const t = i / FS; tpl[i] = Math.sin(2 * Math.PI * (300 * t + ((3000 - 300) / (2 * T)) * t * t)) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1))); }
  const out: number[] = [];
  const first = Math.ceil(off / 1000), last = Math.floor(((x.length / FS) * 1000 + off) / 1000);
  for (let k = first; k <= last; k++) {
    const e = Math.round(((k * 1000 - off) / 1000) * FS);
    let best = 0, bi = -1;
    const scores: number[] = [];
    for (let lag = Math.max(0, e - Math.round(0.45 * FS)); lag <= Math.min(x.length - L, e + Math.round(0.45 * FS)); lag++) {
      let c = 0;
      for (let i = 0; i < L; i++) c += x[lag + i] * tpl[i];
      c = Math.abs(c);
      scores.push(c);
      if (c > best) { best = c; bi = lag; }
    }
    if (bi < 0) continue;
    scores.sort((a, b) => a - b);
    if (best < 6 * (scores[Math.floor(scores.length / 2)] || 1e-9)) continue;
    out.push(((bi - e) / FS) * 1000);
  }
  return out;
}

const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };

export function sync(file: string, region: { x: number; y: number; w: number; h: number } | null) {
  const pics = pictures(file, region);
  const read = pics.filter((p) => p.drawn != null);
  // file time to the draw clock: drawn = t*1000 + offset
  const offs = read.map((p) => p.drawn! - p.t * 1000);
  const off = median(offs);
  const good = offs.filter((o) => Math.abs(o - off) < 200);
  const jitter = Math.round(Math.sqrt(good.reduce((s, o) => s + (o - off) ** 2, 0) / Math.max(1, good.length)));
  const lc = chirps(file, off);
  if (process.env.SHOW) console.log("chirps:", lc.map(Math.round).join(" "));
  return { soundLateMs: Math.round(median(lc)), n: lc.length, spread: Math.round(Math.max(...lc) - Math.min(...lc)), frames: pics.length, readable: read.length, jitterMs: jitter, offsetMs: Math.round(off) };
}

if (process.argv[1]?.endsWith("measure.ts")) {
  for (const arg of process.argv.slice(2)) {
    const [file, reg] = arg.split("@");
    const r = reg ? (([x, y, w, h]) => ({ x, y, w, h }))(reg.split(":").map(Number)) : null;
    const o = sync(file, r);
    console.log(`${file.split(/[\\/]/).slice(-2).join("/")}: sound ${o.soundLateMs >= 0 ? "late" : "early"} by ${Math.abs(o.soundLateMs)} ms (${o.n} chirps, spread ${o.spread} ms; ${o.readable}/${o.frames} frames read, picture clock jitter ${o.jitterMs} ms)`);
  }
}
