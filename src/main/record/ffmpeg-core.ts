// ffmpeg arguments and output parsing as pure functions (tested in ffmpeg-core.test.ts).
import type { BubbleLayout, LoudnessTarget } from "../../shared/types";
import { bubbleAspect, bubbleRadius, parseHex, pxScale } from "../../renderer/modules/record/layout-core";
import type { CameraFrame } from "../../renderer/modules/record/zoom-core";

/** Reads `-progress pipe:1` output; returns the encoded position in ms, or null. */
export function parseProgressTime(text: string): number | null {
  let last: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
    if (m) last = Number(m[1]) / 1000; // both keys are microseconds (out_time_ms is misnamed)
  }
  return last;
}

export const hasAudioStream = (probeStderr: string) => /Stream #\d+:\d+.*: Audio:/.test(probeStderr);

export interface LoudnormMeasure { input_i: string; input_tp: string; input_lra: string; input_thresh: string; target_offset: string }

/** The JSON block loudnorm prints at the end of its first pass. */
export function parseLoudnorm(stderr: string): LoudnormMeasure | null {
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1));
    if (!j.input_i || !Number.isFinite(Number(j.input_i))) return null; // silence measures as -inf
    return j;
  } catch {
    return null;
  }
}

export function loudnormFilter(target: Exclude<LoudnessTarget, "off">, m?: LoudnormMeasure | null): string {
  const base = `loudnorm=I=${target}:TP=-1.5:LRA=11`;
  if (!m) return `${base}:print_format=json`;
  return `${base}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=summary`;
}

export const SILENCE_FILTER = "silencedetect=noise=-40dB:d=0.4";

/**
 * Where speech starts and ends, from silencedetect's log. Keeps a little air on both sides.
 * Returns seconds; end is null when the take does not end in silence.
 */
export function parseSilenceTrim(stderr: string, durationSec: number | null, padIn = 0.25, padOut = 0.4): { start: number; end: number | null } {
  const events: { kind: "start" | "end"; t: number }[] = [];
  const re = /silence_(start|end): (-?[\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) events.push({ kind: m[1] as "start" | "end", t: Math.max(0, Number(m[2])) });
  let start = 0;
  let end: number | null = null;
  if (events[0]?.kind === "start" && events[0].t <= 0.05 && events[1]?.kind === "end") {
    start = Math.max(0, events[1].t - padIn);
  }
  const last = events[events.length - 1];
  const prev = events[events.length - 2];
  if (last?.kind === "start" && last.t > start) {
    end = last.t + padOut; // silence ran to the end of the file
  } else if (last?.kind === "end" && prev?.kind === "start" && durationSec != null && last.t >= durationSec - 0.15 && prev.t > start) {
    end = prev.t + padOut;
  }
  if (durationSec != null && end != null && end >= durationSec) end = null;
  if (end != null && end - start < 0.5) return { start: 0, end: null }; // all silence: keep the take whole
  return { start, end };
}

/**
 * Where the zoom chain (crop@zin, scale@zs, crop@zout) samples the screen for one camera frame.
 * A crop alone moves in whole even pixels, which at 1.8x is a 2-5 px judder through every ease.
 * Here the crop takes the whole pixels around the view (with a margin), the scale enlarges them by
 * the camera's own factor, and the last crop places the view at the output's resolution: the
 * picture lands within half an output pixel of where the camera really is.
 */
export function zoomChainRect(f: Pick<CameraFrame, "scale" | "x" | "y">, w: number, h: number) {
  const s = Math.max(1, f.scale);
  const cw = w / s, ch = h / s;
  const L = Math.min(w - cw, Math.max(0, f.x * w - cw / 2)), T = Math.min(h - ch, Math.max(0, f.y * h - ch / 2));
  // whole pixels around the view, even for yuv420, two pixels of margin for the scaler's taps
  const span = (lo: number, len: number, max: number) => {
    let a = Math.max(0, Math.floor((Math.floor(lo) - 2) / 2) * 2);
    let b = Math.min(max, Math.ceil(lo + len) + 2);
    if ((b - a) % 2) { if (b < max) b++; else a = Math.max(0, a - 2); if ((b - a) % 2) b--; }
    return { a, n: b - a };
  };
  const X = span(L, cw, w), Y = span(T, ch, h);
  const sw = Math.max(w, Math.round(X.n * s)), sh = Math.max(h, Math.round(Y.n * s));
  const kx = sw / X.n, ky = sh / Y.n;
  const ox = Math.min(sw - w, Math.max(0, Math.round((L - X.a) * kx)));
  const oy = Math.min(sh - h, Math.max(0, Math.round((T - Y.a) * ky)));
  return { crop: { x: X.a, y: Y.a, w: X.n, h: Y.n }, scale: { w: sw, h: sh }, out: { x: ox, y: oy } };
}

/** ffmpeg sendcmd script for the zoom chain (see zoomChainRect): one line per changed frame, times shifted by the trimmed start. */
export function zoomCommands(frames: CameraFrame[], w: number, h: number, offsetMs = 0): string {
  const lines: string[] = [];
  let prev = "";
  const line = (t: number, f: CameraFrame) => {
    const r = zoomChainRect(f, w, h);
    return {
      key: JSON.stringify(r),
      text: `${t.toFixed(3)} crop@zin w ${r.crop.w}, crop@zin h ${r.crop.h}, crop@zin x ${r.crop.x}, crop@zin y ${r.crop.y}, ` +
        `scale@zs w ${r.scale.w}, scale@zs h ${r.scale.h}, crop@zout x ${r.out.x}, crop@zout y ${r.out.y};`,
    };
  };
  // each line half a frame before its frame: written at the frame's own time, a time rounded up to
  // the millisecond (frame 2 at 30 fps is 66.667 ms, "0.067") lands one frame late, a jolt every third frame
  const half = frames.length > 1 ? (frames[1].t - frames[0].t) / 2 : 0;
  for (const f of frames) {
    const t = (f.t - offsetMs - half) / 1000;
    const l = line(Math.max(0, t), f);
    if (t < 0) { prev = l.key; continue; }
    if (l.key === prev) continue;
    prev = l.key;
    lines.push(l.text);
  }
  if (!lines.length || !lines[0].startsWith("0.000")) {
    // the first frame after the trim point must set the chain too
    const first = frames.find((f) => f.t >= offsetMs) ?? frames[frames.length - 1];
    if (first) lines.unshift(line(0, first).text);
  }
  return lines.join("\n") + "\n";
}

/** Alpha mask for a rounded or round camera bubble, soft by one pixel at the edge. */
export function bubbleMaskExpr(w: number, h: number, shape: BubbleLayout["shape"], radius?: number): string {
  const r = shape === "circle" ? Math.min(w, h) / 2 : Math.round(bubbleRadius({ shape, radius }, { w, h }));
  const dx = `max(abs(X-${w / 2})-${w / 2 - r},0)`;
  const dy = `max(abs(Y-${h / 2})-${h / 2 - r},0)`;
  return `clip(255*(${r}+0.5-hypot(${dx},${dy})),0,255)`;
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

export interface EncodeArgsInput {
  input: string;
  out: string;
  fps: number;
  trim: { start: number; end: number | null };
  audio: boolean;
  loudness?: string | null;
}

const trimArgs = (trim: { start: number; end: number | null }) => [
  ...(trim.start > 0 ? ["-ss", trim.start.toFixed(3)] : []),
  ...(trim.end != null ? ["-t", (trim.end - trim.start).toFixed(3)] : []),
];

const VIDEO_OUT = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p"];
const audioOut = (loudness?: string | null) => [...(loudness ? ["-af", loudness] : []), "-c:a", "aac", "-b:a", "192k", "-ar", "48000"];
const TAIL = ["-movflags", "+faststart", "-progress", "pipe:1", "-nostats"];

/** The composite take (what the stage showed) to H.264 + AAC MP4. */
export function compositeArgs(o: EncodeArgsInput): string[] {
  return [
    "-nostdin", "-y", "-hide_banner",
    ...trimArgs(o.trim), "-i", o.input,
    "-map", "0:v:0", ...(o.audio ? ["-map", "0:a:0"] : []),
    ...VIDEO_OUT, "-fps_mode", "cfr", "-r", String(o.fps),
    ...(o.audio ? audioOut(o.loudness) : ["-an"]),
    ...TAIL, o.out,
  ];
}

export interface HiresArgsInput extends EncodeArgsInput {
  screen: string;
  screenSize: { width: number; height: number };
  camera?: string | null;
  bubble?: BubbleLayout | null;
  cmdFile: string;
  /** the export's length in seconds (stops the picture and the sound together) */
  limitSec?: number | null;
  /** the part of the screen that is kept, in source pixels (the layout's crop) */
  crop?: { x: number; y: number; w: number; h: number } | null;
}

/** The hi-res frame: the screen's own size, or the part the crop keeps (null when nothing is cut). */
export function hiresFrame(screenSize: { width: number; height: number }, crop?: HiresArgsInput["crop"]) {
  const c = crop && (crop.w < screenSize.width - 1 || crop.h < screenSize.height - 1) ? crop : null;
  return { c, W: even(c ? c.w : screenSize.width), H: even(c ? c.h : screenSize.height) };
}

const maskAlpha =(mask: string) => `format=yuva420p,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${mask}'`;
const ffColor = (hex: string | undefined) => `0x${(parseHex(hex ?? "") ?? "#ffffff").slice(1)}`;

/**
 * The screen track at its native resolution (inside the layout's crop), zoom redone from the click
 * timeline (sendcmd drives the crop, scale brings each frame back to full size), the camera bubble
 * laid over it with its shape and border, and the sound from the composite take.
 * `input` is the composite file (audio source).
 */
export function hiresArgs(o: HiresArgsInput): string[] {
  const { inputs, parts, last, audioIdx } = hiresGraph(o);
  return [
    "-nostdin", "-y", "-hide_banner",
    ...inputs,
    "-filter_complex", parts.join(";"),
    "-map", `[${last}]`, ...(o.audio ? ["-map", `${audioIdx}:a:0`] : []),
    ...VIDEO_OUT, "-fps_mode", "cfr", "-r", String(o.fps),
    ...(o.audio ? audioOut(o.loudness) : ["-an"]),
    // the length set outright: -shortest could deadlock at the end of a pass with this graph
    ...(o.limitSec && Number.isFinite(o.limitSec) ? ["-t", o.limitSec.toFixed(3)] : []),
    ...TAIL, o.out,
  ];
}

/** The hi-res inputs and filter graph, shared by hiresArgs and the editor export (src/main/record/export-core.ts). */
export function hiresGraph(o: Omit<HiresArgsInput, "out" | "loudness">) {
  const { c, W, H } = hiresFrame(o.screenSize, o.crop);
  const at = (v: number) => Math.max(0, Math.round(v / 2) * 2);
  const cut = c ? `crop=${W}:${H}:${at(c.x)}:${at(c.y)},` : "";
  const parts = [`[0:v]fps=${o.fps},${cut}sendcmd=f=${o.cmdFile},crop@zin=w=${W}:h=${H}:x=0:y=0,format=yuv420p,scale@zs=w=${W}:h=${H}:flags=bicubic,crop@zout=w=${W}:h=${H}:x=0:y=0:exact=1,setsar=1[base]`];
  // format before the scale: a crop at full size scaled to the same size crashed the bundled ffmpeg 6.1 at 1080p.
  // bicubic, not lanczos: the scaler is rebuilt on every moving frame, and lanczos took 8x longer to rebuild
  const inputs = [...trimArgs(o.trim), "-i", o.screen];
  let last = "base";
  let audioIdx = 1;
  if (o.camera && o.bubble) {
    inputs.push(...trimArgs(o.trim), "-i", o.camera);
    audioIdx = 2;
    const b = o.bubble;
    const bw = even(b.size * Math.min(W, H));
    const bh = b.shape === "circle" ? bw : even(bw / bubbleAspect(b));
    const x = Math.round(Math.min(W - bw, Math.max(0, b.cx * W - bw / 2)));
    const y = Math.round(Math.min(H - bh, Math.max(0, b.cy * H - bh / 2)));
    const r = bubbleRadius(b, { w: bw, h: bh });
    // the border is a ring of colour the size of the bubble, with the picture set inside it
    const border = Math.min(Math.round((b.border ?? 0) * pxScale(W, H)), Math.floor(Math.min(bw, bh) / 4));
    if (border > 0) {
      const iw = even(bw - border * 2), ih = even(bh - border * 2);
      parts.push(
        `color=c=${ffColor(b.borderColor)}:s=${bw}x${bh}:r=${o.fps},${maskAlpha(bubbleMaskExpr(bw, bh, b.shape, b.radius))}[ring]`,
        `[1:v]fps=${o.fps},scale=${iw}:${ih}:force_original_aspect_ratio=increase,crop=${iw}:${ih},` +
          maskAlpha(bubbleMaskExpr(iw, ih, b.shape === "circle" ? "circle" : "rounded", b.shape === "circle" ? undefined : Math.max(0, r - border) / Math.min(iw, ih))) + "[cam]",
        `[base][ring]overlay=${x}:${y}:shortest=1[ringed]`,
        `[ringed][cam]overlay=${x + Math.round((bw - iw) / 2)}:${y + Math.round((bh - ih) / 2)}[out]`,
      );
    } else {
      parts.push(
        `[1:v]fps=${o.fps},scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},${maskAlpha(bubbleMaskExpr(bw, bh, b.shape, b.radius))}[cam]`,
        `[base][cam]overlay=${x}:${y}[out]`,
      );
    }
    last = "out";
  }
  if (o.audio) inputs.push(...trimArgs(o.trim), "-i", o.input);
  return { inputs, parts, last, audioIdx, W, H };
}

/** Folder name for a take: sortable, and legal on Windows (no colons). */
export function takeFolderName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

/** A take id is a folder name we made: no separators, no dot-dot. */
export const validTakeId = (id: unknown): id is string =>
  typeof id === "string" && /^[\w .()-]{1,80}$/.test(id) && !id.includes("..") && id.trim() === id;
