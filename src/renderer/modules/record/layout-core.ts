// Layout and recording decisions as pure functions (tested in layout-core.test.ts).
import type { BubbleLayout, OutputAspect, RecordLayout, RecordMode } from "@shared/types";

export interface Rect { x: number; y: number; w: number; h: number }

export function outputSize(aspect: OutputAspect, base = 1080): { width: number; height: number } {
  if (aspect === "9:16") return { width: base, height: Math.round((base * 16) / 9) };
  if (aspect === "1:1") return { width: base, height: base };
  return { width: Math.round((base * 16) / 9), height: base };
}

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

/** Where the screen goes: inside the padding, keeping its own aspect. */
export function screenRect(layout: Pick<RecordLayout, "width" | "height" | "padding">, srcW: number, srcH: number): Rect {
  const pad = Math.round(Math.min(layout.width, layout.height) * layout.padding);
  return containRect(srcW, srcH, { x: pad, y: pad, w: layout.width - pad * 2, h: layout.height - pad * 2 });
}

/** Bubble in output pixels. A circle is square; a rounded bubble is 4:3 landscape. */
export function bubbleRect(b: BubbleLayout, width: number, height: number): Rect {
  const w = b.size * Math.min(width, height);
  const h = b.shape === "circle" ? w : (w * 3) / 4;
  return { x: b.cx * width - w / 2, y: b.cy * height - h / 2, w, h };
}

/** Keeps the bubble fully on screen. */
export function clampBubble(b: BubbleLayout, width: number, height: number): BubbleLayout {
  const size = Math.min(0.6, Math.max(0.08, b.size));
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

export const BACKGROUNDS: { id: string; label: string; css: string; stops: string[] }[] = [
  { id: "none", label: "None", css: "#000", stops: ["#000000"] },
  { id: "graphite", label: "Graphite", css: "linear-gradient(135deg,#2b2d33,#0f1012)", stops: ["#2b2d33", "#0f1012"] },
  { id: "dusk", label: "Dusk", css: "linear-gradient(135deg,#ff7a59,#7b4dff)", stops: ["#ff7a59", "#7b4dff"] },
  { id: "sea", label: "Sea", css: "linear-gradient(135deg,#1fd1a5,#2563eb)", stops: ["#1fd1a5", "#2563eb"] },
  { id: "sand", label: "Sand", css: "linear-gradient(135deg,#f6d8b5,#c9a27e)", stops: ["#f6d8b5", "#c9a27e"] },
  { id: "white", label: "White", css: "#f4f4f5", stops: ["#f4f4f5"] },
];
