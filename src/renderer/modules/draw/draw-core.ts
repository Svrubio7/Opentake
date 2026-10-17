// OWNED BY: shell agent. Drawing on the screen: stroke geometry, smoothing, fading and hit testing.
// Pure functions, no DOM. Coordinates are CSS pixels of the overlay window.
import type { DrawTool } from "@shared/types";

export interface Pt { x: number; y: number }
export interface Stroke {
  id: number;
  tool: DrawTool;
  color: string;
  /** pen and highlighter: every kept point; arrow and rectangle: [start, end] */
  points: Pt[];
  /** ms when the pointer lifted; undefined while it is still being drawn */
  doneAt?: number;
}

export const COLORS = [
  // label: the dictionary key of the colour's name (shown on hover)
  { id: "red", value: "#ff3b30", label: "draw.color.red" },
  { id: "yellow", value: "#ffd60a", label: "draw.color.yellow" },
  { id: "green", value: "#30d158", label: "draw.color.green" },
  { id: "blue", value: "#0a84ff", label: "draw.color.blue" },
  { id: "white", value: "#ffffff", label: "draw.color.white" },
] as const;

/** How long a finished stroke stays fully visible, then how long it takes to fade away. */
export const FADE_HOLD_MS = 3000;
export const FADE_OUT_MS = 600;

export const TOOL_STYLE: Record<DrawTool, { width: number; opacity: number }> = {
  pen: { width: 4, opacity: 1 },
  highlighter: { width: 22, opacity: 0.38 },
  arrow: { width: 5, opacity: 1 },
  rect: { width: 4, opacity: 1 },
};

/** Freehand tools keep every point; shapes only their two corners. */
export const isFreehand = (t: DrawTool) => t === "pen" || t === "highlighter";

/**
 * Adds a pointer sample to a freehand stroke. Samples closer than minDist to the last kept point
 * are dropped (a trembling hand and 1000 Hz mice make hundreds of them) unless it is the first.
 */
export function addPoint(points: Pt[], p: Pt, minDist = 2): Pt[] {
  const last = points[points.length - 1];
  if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDist) return points;
  return [...points, p];
}

/** Moving average over a window of neighbours: takes out the jitter, keeps both ends where they were. */
export function smooth(points: Pt[], radius = 2): Pt[] {
  if (points.length < 3 || radius < 1) return points;
  return points.map((p, i) => {
    if (i === 0 || i === points.length - 1) return p;
    const from = Math.max(0, i - radius), to = Math.min(points.length - 1, i + radius);
    let x = 0, y = 0;
    for (let j = from; j <= to; j++) { x += points[j].x; y += points[j].y; }
    const n = to - from + 1;
    return { x: x / n, y: y / n };
  });
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** An SVG path through the points: quadratic curves through the midpoints, so corners come out round. */
export function freehandPath(raw: Pt[]): string {
  const pts = smooth(raw);
  if (pts.length === 0) return "";
  const [a] = pts;
  // a single tap still leaves a dot (the round line cap draws it)
  if (pts.length === 1) return `M${r1(a.x)} ${r1(a.y)}L${r1(a.x + 0.1)} ${r1(a.y)}`;
  if (pts.length === 2) return `M${r1(a.x)} ${r1(a.y)}L${r1(pts[1].x)} ${r1(pts[1].y)}`;
  let d = `M${r1(a.x)} ${r1(a.y)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    d += `Q${r1(p.x)} ${r1(p.y)} ${r1((p.x + q.x) / 2)} ${r1((p.y + q.y) / 2)}`;
  }
  const z = pts[pts.length - 1];
  return d + `L${r1(z.x)} ${r1(z.y)}`;
}

/** The two barbs of an arrow head at `to`, sized to the stroke and never longer than half the shaft. */
export function arrowHead(from: Pt, to: Pt, width: number): [Pt, Pt] {
  const len = Math.hypot(to.x - from.x, to.y - from.y);
  const size = Math.min(Math.max(14, width * 4.5), len / 2);
  const ang = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 7;
  return [
    { x: to.x - size * Math.cos(ang - spread), y: to.y - size * Math.sin(ang - spread) },
    { x: to.x - size * Math.cos(ang + spread), y: to.y - size * Math.sin(ang + spread) },
  ];
}

export function arrowPath(from: Pt, to: Pt, width: number): string {
  if (Math.hypot(to.x - from.x, to.y - from.y) < 1) return "";
  const [l, r] = arrowHead(from, to, width);
  return `M${r1(from.x)} ${r1(from.y)}L${r1(to.x)} ${r1(to.y)}M${r1(l.x)} ${r1(l.y)}L${r1(to.x)} ${r1(to.y)}L${r1(r.x)} ${r1(r.y)}`;
}

/** The rectangle between two corners dragged in any direction. */
export function rectFrom(a: Pt, b: Pt) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** The SVG path of a stroke, whatever its tool. */
export function strokePath(s: Stroke): string {
  const w = TOOL_STYLE[s.tool].width;
  if (isFreehand(s.tool)) return freehandPath(s.points);
  const [a, b = a] = s.points;
  if (!a) return "";
  if (s.tool === "arrow") return arrowPath(a, b, w);
  const r = rectFrom(a, b);
  if (r.w < 1 && r.h < 1) return "";
  return `M${r1(r.x)} ${r1(r.y)}h${r1(r.w)}v${r1(r.h)}h${r1(-r.w)}Z`;
}

/** 1 while drawn and for the hold time after, then down to 0. Without fading a stroke stays at 1. */
export function fadeOpacity(s: Stroke, now: number, fade: boolean): number {
  if (!fade || s.doneAt === undefined) return 1;
  const t = now - s.doneAt - FADE_HOLD_MS;
  if (t <= 0) return 1;
  return Math.max(0, 1 - t / FADE_OUT_MS);
}

/** Strokes still on screen (a faded one is gone for good, undo does not bring it back). */
export function liveStrokes(list: Stroke[], now: number, fade: boolean): Stroke[] {
  return fade ? list.filter((s) => fadeOpacity(s, now, true) > 0) : list;
}

/** ms until the next stroke disappears, or null when nothing is waiting to fade. */
export function nextExpiry(list: Stroke[], now: number, fade: boolean): number | null {
  if (!fade) return null;
  let next: number | null = null;
  for (const s of list) {
    if (s.doneAt === undefined) continue;
    const left = s.doneAt + FADE_HOLD_MS + FADE_OUT_MS - now;
    if (left > 0 && (next === null || left < next)) next = left;
  }
  return next;
}

/** Distance from p to the segment ab. */
export function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Whether p touches the stroke's line (within half its width plus a tolerance). Rectangles are hit on their edges. */
export function hitStroke(s: Stroke, p: Pt, tolerance = 6): boolean {
  const reach = TOOL_STYLE[s.tool].width / 2 + tolerance;
  let segs: [Pt, Pt][];
  if (isFreehand(s.tool)) {
    if (s.points.length === 1) return Math.hypot(p.x - s.points[0].x, p.y - s.points[0].y) <= reach;
    segs = s.points.slice(1).map((q, i) => [s.points[i], q]);
  } else {
    const [a, b = a] = s.points;
    if (!a) return false;
    if (s.tool === "arrow") segs = [[a, b]];
    else {
      const r = rectFrom(a, b);
      const c = [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];
      segs = c.map((q, i) => [q, c[(i + 1) % 4]]);
    }
  }
  return segs.some(([a, b]) => distToSegment(p, a, b) <= reach);
}

/** The topmost stroke under p (the last drawn wins), or -1. */
export function strokeAt(list: Stroke[], p: Pt, tolerance?: number): number {
  for (let i = list.length - 1; i >= 0; i--) if (hitStroke(list[i], p, tolerance)) return i;
  return -1;
}
