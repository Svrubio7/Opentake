// Layout and recording decisions as pure functions (tested in layout-core.test.ts).
import type { BubbleLayout, FrameCrop, OutputAspect, RecordLayout, RecordMode } from "@shared/types";
import { t, type Key } from "../../../shared/i18n";

export interface Rect { x: number; y: number; w: number; h: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

export const ASPECT_RATIO: Record<Exclude<OutputAspect, "custom">, number> = {
  "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:3": 4 / 3, "4:5": 4 / 5,
};

/** A custom output side, in pixels. Even sizes, because H.264 in yuv420 needs them. */
export const CUSTOM_SIDE = { min: 320, max: 4096 };
export const clampSide = (v: number) => even(clamp(Number.isFinite(v) ? v : 1080, CUSTOM_SIDE.min, CUSTOM_SIDE.max));

/** Output pixels: `base` is the shorter side; a custom aspect brings its own width and height. */
export function outputSize(aspect: OutputAspect, base = 1080, custom?: { width: number; height: number }): { width: number; height: number } {
  if (aspect === "custom") return { width: clampSide(custom?.width ?? 1920), height: clampSide(custom?.height ?? 1080) };
  const r = ASPECT_RATIO[aspect] ?? 16 / 9;
  return r >= 1 ? { width: even(base * r), height: base } : { width: base, height: even(base / r) };
}

/** Sizes that are set in 1080p pixels (corners, borders, shadows) grow with the output. */
export const pxScale = (width: number, height: number) => Math.min(width, height) / 1080;

/** Largest rect of aspect srcW/srcH that fits inside box (letterboxed). */
export function containRect(srcW: number, srcH: number, box: Rect): Rect {
  if (!srcW || !srcH) return box;
  const s = Math.min(box.w / srcW, box.h / srcH);
  const w = srcW * s, h = srcH * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Source crop of a srcW x srcH picture that fills a box of aspect boxW/boxH (centre crop). */
export function coverCrop(srcW: number, srcH: number, boxW: number, boxH: number): Rect {
  if (!srcW || !srcH) return { x: 0, y: 0, w: srcW, h: srcH };
  const target = boxW / boxH;
  if (srcW / srcH > target) {
    const w = srcH * target;
    return { x: (srcW - w) / 2, y: 0, w, h: srcH };
  }
  const h = srcW / target;
  return { x: 0, y: (srcH - h) / 2, w: srcW, h };
}

type WindowLayout = Pick<RecordLayout, "width" | "height" | "padding" | "screenScale" | "screenPosition">;

/** The room inside the padding. */
export function paddedBox(layout: Pick<RecordLayout, "width" | "height" | "padding">): Rect {
  const pad = Math.round(Math.min(layout.width, layout.height) * layout.padding);
  return { x: pad, y: pad, w: layout.width - pad * 2, h: layout.height - pad * 2 };
}

/** Scales a window inside its box and places it in the room left over (position -1..1 on each axis). */
function placeIn(box: Rect, w: number, h: number, layout: WindowLayout): Rect {
  const s = clamp(layout.screenScale ?? 1, 0.3, 1);
  const p = layout.screenPosition ?? { x: 0, y: 0 };
  const sw = w * s, sh = h * s;
  return {
    x: box.x + ((box.w - sw) / 2) * (1 + clamp(p.x, -1, 1)),
    y: box.y + ((box.h - sh) / 2) * (1 + clamp(p.y, -1, 1)),
    w: sw, h: sh,
  };
}

/** Where the screen goes: inside the padding, keeping its own aspect, at its size and position. */
export function screenRect(layout: WindowLayout, srcW: number, srcH: number): Rect {
  const box = paddedBox(layout);
  const fit = containRect(srcW, srcH, box);
  return placeIn(box, fit.w, fit.h, layout);
}

/** Camera-only takes fill the padded room (the picture is cropped to it), at the window size. */
export function cameraWindowRect(layout: WindowLayout): Rect {
  const box = paddedBox(layout);
  return placeIn(box, box.w, box.h, layout);
}

export const NO_CROP: FrameCrop = { top: 0, right: 0, bottom: 0, left: 0 };

/** Each edge can lose at most 45%, so something is always left to show. */
export function normalizeCrop(c: Partial<FrameCrop> | undefined): FrameCrop {
  const k = (v: number | undefined) => clamp(Number.isFinite(v) ? (v as number) : 0, 0, 0.45);
  return { top: k(c?.top), right: k(c?.right), bottom: k(c?.bottom), left: k(c?.left) };
}

/** The part of a w x h source that is kept, in source pixels. */
export function cropSource(c: Partial<FrameCrop> | undefined, w: number, h: number): Rect {
  const n = normalizeCrop(c);
  return { x: n.left * w, y: n.top * h, w: w * (1 - n.left - n.right), h: h * (1 - n.top - n.bottom) };
}

/** A point given on the whole display, in the cropped picture's 0..1 space. */
export function toCropSpace<P extends { x: number; y: number }>(p: P, c: Partial<FrameCrop> | undefined): P {
  const n = normalizeCrop(c);
  return { ...p, x: (p.x - n.left) / (1 - n.left - n.right), y: (p.y - n.top) / (1 - n.top - n.bottom) };
}

/** Width / height of a bubble: a circle is 1, a rounded bubble its own aspect (4:3 by default). */
export const bubbleAspect = (b: Pick<BubbleLayout, "shape" | "aspect">) => (b.shape === "circle" ? 1 : clamp(b.aspect ?? 4 / 3, 0.5, 2.5));

/** Bubble in output pixels. */
export function bubbleRect(b: BubbleLayout, width: number, height: number): Rect {
  const w = b.size * Math.min(width, height);
  const h = w / bubbleAspect(b);
  return { x: b.cx * width - w / 2, y: b.cy * height - h / 2, w, h };
}

/** Corner radius of a bubble in pixels. */
export function bubbleRadius(b: Pick<BubbleLayout, "shape" | "radius">, r: Pick<Rect, "w" | "h">): number {
  const m = Math.min(r.w, r.h);
  return b.shape === "circle" ? m / 2 : clamp(b.radius ?? 0.18, 0, 0.5) * m;
}

/** The largest size a bubble of this aspect can take and still fit on screen. */
export function maxBubbleSize(b: Pick<BubbleLayout, "shape" | "aspect">, width: number, height: number): number {
  const m = Math.min(width, height);
  return Math.min((0.95 * width) / m, (0.95 * height * bubbleAspect(b)) / m);
}

/** Keeps the bubble fully on screen. */
export function clampBubble(b: BubbleLayout, width: number, height: number): BubbleLayout {
  const size = clamp(b.size, 0.06, maxBubbleSize(b, width, height));
  const r = bubbleRect({ ...b, size }, width, height);
  const hx = r.w / 2 / width, hy = r.h / 2 / height;
  return { ...b, size, cx: Math.min(1 - hx, Math.max(hx, b.cx)), cy: Math.min(1 - hy, Math.max(hy, b.cy)) };
}

/** Corner positions a bubble snaps to, with a margin of 3% of the shorter side. */
export function bubbleCorners(b: BubbleLayout, width: number, height: number) {
  const r = bubbleRect(b, width, height);
  const m = 0.03 * Math.min(width, height);
  const left = (m + r.w / 2) / width, right = 1 - left;
  const top = (m + r.h / 2) / height, bottom = 1 - top;
  return [
    { cx: left, cy: top }, { cx: right, cy: top },
    { cx: left, cy: bottom }, { cx: right, cy: bottom },
  ];
}

/** After a drag, a bubble near a corner settles into it; anywhere else it stays put. */
export function snapBubble(b: BubbleLayout, width: number, height: number, threshold = 0.12): BubbleLayout {
  const c = clampBubble(b, width, height);
  let best: { cx: number; cy: number } | null = null;
  let bestD = Infinity;
  for (const k of bubbleCorners(c, width, height)) {
    const d = Math.hypot((k.cx - c.cx) * width, (k.cy - c.cy) * height) / Math.min(width, height);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best && bestD <= threshold ? { ...c, ...best } : c;
}

export type BubbleHit = "move" | "resize" | null;

/** Inside the bubble moves it; the outer ring (last 18% of its half size) resizes it. */
export function hitBubble(b: BubbleLayout, width: number, height: number, px: number, py: number): BubbleHit {
  const r = bubbleRect(b, width, height);
  const nx = (px - (r.x + r.w / 2)) / (r.w / 2);
  const ny = (py - (r.y + r.h / 2)) / (r.h / 2);
  const d = b.shape === "circle" ? Math.hypot(nx, ny) : Math.max(Math.abs(nx), Math.abs(ny));
  if (d > 1.04) return null;
  return d > 0.82 ? "resize" : "move";
}

export const needsScreen = (m: RecordMode) => m !== "camera";
export const needsCamera = (m: RecordMode) => m !== "screen";

/**
 * Best recorder format. H.264 first: Chromium encodes it on the GPU on Windows (Media Foundation),
 * which leaves the CPU to the compositor and the camera filters; VP9 is a CPU encoder at 1080p.
 */
export const MIME_PREFERENCE = [
  "video/webm;codecs=h264,opus",
  "video/mp4;codecs=avc1.640033,mp4a.40.2",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=av01,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export function pickMime(isSupported: (m: string) => boolean, audio = true): string {
  for (const m of MIME_PREFERENCE) {
    const mime = audio ? m : m.replace(/,opus|,mp4a\.40\.2/, "");
    if (isSupported(mime)) return mime;
  }
  return "";
}

export const extensionFor = (mime: string) => (mime.startsWith("video/mp4") ? "mp4" : "webm");

/** ~16 Mbps for 1080p30, scaled by pixels and frame rate, inside 8-40 Mbps. */
export function videoBitrate(width: number, height: number, fps: number): number {
  const bps = 16_000_000 * ((width * height) / (1920 * 1080)) * Math.sqrt(fps / 30);
  return Math.round(Math.min(40_000_000, Math.max(8_000_000, bps)));
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// the label is read in the current language each time (the app switches language live)
const preset = (id: string, key: Extract<Key, `record.bg.${string}`>, ...stops: string[]) => ({
  id, get label() { return t(key); }, stops, css: stops.length > 1 ? `linear-gradient(135deg,${stops.join(",")})` : stops[0],
});

export const BACKGROUNDS: { id: string; readonly label: string; css: string; stops: string[] }[] = [
  preset("none", "record.bg.none", "#000000"),
  preset("graphite", "record.bg.graphite", "#2b2d33", "#0f1012"),
  preset("midnight", "record.bg.midnight", "#1e3a8a", "#0f172a"),
  preset("emerald", "record.bg.emerald", "#0f8a63", "#06281d"),
  preset("dusk", "record.bg.dusk", "#ff7a59", "#7b4dff"),
  preset("sea", "record.bg.sea", "#1fd1a5", "#2563eb"),
  preset("rose", "record.bg.rose", "#fbcfe8", "#c084fc"),
  preset("sand", "record.bg.sand", "#f6d8b5", "#c9a27e"),
  preset("white", "record.bg.white", "#f4f4f5"),
  preset("black", "record.bg.black", "#000000"),
];

/** The background kinds a person sets up themself, beside the presets. */
export type CustomBackground = "color" | "gradient" | "image";
export const isCustomBackground = (id: string): id is CustomBackground => id === "color" || id === "gradient" || id === "image";

export interface BackgroundSpec { id: string; color: string; color2: string; angle: number; image: string | null; blur: number }

/** What to paint: one colour, a gradient at an angle, or a picture (with a colour behind it while it loads). */
export function resolveBackground(s: BackgroundSpec): { kind: "solid"; color: string } | { kind: "gradient"; stops: string[]; angle: number } | { kind: "image"; src: string; blur: number; color: string } {
  if (s.id === "color") return { kind: "solid", color: s.color };
  if (s.id === "gradient") return { kind: "gradient", stops: [s.color, s.color2], angle: s.angle };
  if (s.id === "image" && s.image) return { kind: "image", src: s.image, blur: s.blur, color: s.color };
  if (s.id === "image") return { kind: "solid", color: s.color };
  const p = BACKGROUNDS.find((b) => b.id === s.id) ?? BACKGROUNDS[0];
  return p.stops.length > 1 ? { kind: "gradient", stops: p.stops, angle: 135 } : { kind: "solid", color: p.stops[0] };
}

/** A CSS-style gradient line: 0deg runs bottom to top, 90deg left to right, reaching the corners. */
export function gradientLine(angleDeg: number, width: number, height: number) {
  const a = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  const cx = width / 2, cy = height / 2;
  return { x0: cx - dx * half, y0: cy - dy * half, x1: cx + dx * half, y1: cy + dy * half };
}

/** "#rgb" or "#rrggbb", else null. */
export function parseHex(v: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}
