// Auto zoom on clicks, as pure math. No DOM: the live compositor (engine.ts) and the
// full-quality export (src/main/record/export.ts) run the same functions.
// Coordinates are 0..1 inside the captured screen; times are ms.

export interface Pt { x: number; y: number }
export interface TimedPt extends Pt { t: number }

export interface ZoomOpts {
  /** how far in a zoom goes (1.6-2x reads as "focused" without losing context) */
  scale: number;
  /** clicks closer than this (screen fraction) and within clusterGapMs belong to one focus */
  clusterRadius: number;
  clusterGapMs: number;
  /** the export zooms in this long before the first click, so the zoom lands as the click happens */
  leadMs: number;
  /** stay zoomed this long after the last click of a cluster */
  holdMs: number;
  /** two zooms closer than this pan from one to the other instead of zooming out and in */
  mergeGapMs: number;
  /** fraction of the zoomed view (from its edge) the cursor may enter before the view follows */
  deadZone: number;
  /** spring stiffness (rad/s) of a critically damped spring: 6-9 feels smooth, not floaty */
  omega: number;
}

export const DEFAULT_ZOOM: ZoomOpts = {
  scale: 1.8,
  clusterRadius: 0.12,
  clusterGapMs: 1500,
  leadMs: 450,
  holdMs: 2200,
  mergeGapMs: 900,
  deadZone: 0.25,
  omega: 7,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export interface ClickCluster { start: number; end: number; x: number; y: number; count: number }

/** Groups clicks that happen close together in space and time into one focus point. */
export function clusterClicks(clicks: TimedPt[], o: Pick<ZoomOpts, "clusterRadius" | "clusterGapMs"> = DEFAULT_ZOOM): ClickCluster[] {
  const sorted = [...clicks].sort((a, b) => a.t - b.t);
  const out: ClickCluster[] = [];
  for (const c of sorted) {
    const cur = out[out.length - 1];
    if (cur && c.t - cur.end <= o.clusterGapMs && dist(cur, c) <= o.clusterRadius) {
      cur.x = (cur.x * cur.count + c.x) / (cur.count + 1);
      cur.y = (cur.y * cur.count + c.y) / (cur.count + 1);
      cur.count += 1;
      cur.end = c.t;
    } else {
      out.push({ start: c.t, end: c.t, x: c.x, y: c.y, count: 1 });
    }
  }
  return out;
}

export interface ZoomSegment { start: number; end: number; x: number; y: number; scale: number }

/** Turns clicks into zoom segments: lead in, hold after, and close gaps so nearby zooms pan. */
export function planZoomSegments(clicks: TimedPt[], o: ZoomOpts = DEFAULT_ZOOM): ZoomSegment[] {
  const segs = clusterClicks(clicks, o).map((c) => ({
    start: Math.max(0, c.start - o.leadMs),
    end: c.end + o.holdMs,
    x: c.x,
    y: c.y,
    scale: o.scale,
  }));
  for (let i = 0; i + 1 < segs.length; i++) {
    const a = segs[i], b = segs[i + 1];
    if (b.start - a.end < o.mergeGapMs) {
      // touching or overlapping: hand over at the next lead-in, the camera pans between them
      a.end = Math.max(a.start, b.start);
    }
  }
  return segs;
}

/** The zoomed view never shows outside the screen. */
export function clampCenter(c: Pt, scale: number): Pt {
  const half = 0.5 / Math.max(1, scale);
  return { x: clamp(c.x, half, 1 - half), y: clamp(c.y, half, 1 - half) };
}

/**
 * Moves the view centre only when the cursor walks into the outer band of the zoomed view
 * (deadZone wide, from the edge), and then only as far as needed to keep it at that band.
 */
export function followDeadZone(center: Pt, cursor: Pt, scale: number, deadZone: number): Pt {
  const half = 0.5 / Math.max(1, scale);
  const limit = half * (1 - deadZone);
  const axis = (c: number, p: number) => {
    const d = p - c;
    if (d > limit) return p - limit;
    if (d < -limit) return p + limit;
    return c;
  };
  return clampCenter({ x: axis(center.x, cursor.x), y: axis(center.y, cursor.y) }, scale);
}

export interface Spring { value: number; velocity: number }

/** Exact step of a critically damped spring: no overshoot, frame-rate independent. */
export function springStep(s: Spring, target: number, dtMs: number, omega: number): Spring {
  const dt = Math.max(0, dtMs) / 1000;
  const x = s.value - target;
  const e = Math.exp(-omega * dt);
  const k = s.velocity + omega * x;
  return { value: target + (x + k * dt) * e, velocity: (s.velocity - omega * k * dt) * e };
}

/** Linear interpolation of cursor samples at time t (null when there are none). */
export function cursorAt(samples: TimedPt[], t: number): Pt | null {
  if (!samples.length) return null;
  if (t <= samples[0].t) return samples[0];
  const last = samples[samples.length - 1];
  if (t >= last.t) return last;
  let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = samples[lo], b = samples[hi];
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

export interface CameraFrame { t: number; scale: number; x: number; y: number }

export interface Camera { scale: Spring; x: Spring; y: Spring; focus: Pt }
export const restingCamera = (): Camera => ({
  scale: { value: 1, velocity: 0 },
  x: { value: 0.5, velocity: 0 },
  y: { value: 0.5, velocity: 0 },
  focus: { x: 0.5, y: 0.5 },
});

/** One camera step toward a target scale and focus; the result is clamped to the screen. */
export function stepCamera(cam: Camera, targetScale: number, focus: Pt, dtMs: number, omega: number): { cam: Camera; frame: Omit<CameraFrame, "t"> } {
  const scale = springStep(cam.scale, targetScale, dtMs, omega);
  const x = springStep(cam.x, focus.x, dtMs, omega);
  const y = springStep(cam.y, focus.y, dtMs, omega);
  const s = Math.max(1, scale.value);
  const c = clampCenter({ x: x.value, y: y.value }, s);
  return { cam: { scale, x, y, focus }, frame: { scale: s, x: c.x, y: c.y } };
}

/**
 * Replays a recording's clicks and cursor into one camera frame per output frame.
 * The export uses this, so it can anticipate clicks (leadMs) where the live preview cannot.
 */
export function simulateCamera(clicks: TimedPt[], cursor: TimedPt[], durationMs: number, fps: number, o: ZoomOpts = DEFAULT_ZOOM): CameraFrame[] {
  const segs = planZoomSegments(clicks, o);
  const step = 1000 / fps;
  const frames: CameraFrame[] = [];
  let cam = restingCamera();
  let segIdx = -1;
  let focus: Pt = { x: 0.5, y: 0.5 };
  for (let t = 0; t <= durationMs + 1e-6; t += step) {
    const i = segs.findIndex((s) => t >= s.start && t < s.end);
    if (i >= 0) {
      if (i !== segIdx) { segIdx = i; focus = clampCenter(segs[i], o.scale); }
      // follow the cursor only once the click it zoomed for has happened
      const p = t >= segs[i].start + o.leadMs ? cursorAt(cursor, t) : null;
      if (p) focus = followDeadZone(focus, p, o.scale, o.deadZone);
    } else {
      segIdx = -1;
      focus = { x: 0.5, y: 0.5 };
    }
    const r = stepCamera(cam, i >= 0 ? segs[i].scale : 1, focus, frames.length ? step : 0, o.omega);
    cam = r.cam;
    frames.push({ t, ...r.frame });
  }
  return frames;
}

/** Live zoom for the preview and the recording: reacts to clicks as they come. */
export class LiveZoom {
  private cam = restingCamera();
  private focus: Pt = { x: 0.5, y: 0.5 };
  private lastClick = -Infinity;
  private lastMove = -Infinity;
  private lastT: number | null = null;
  /** moving the mouse keeps a zoom alive this long after it stops, up to maxHoldMs after the click */
  idleMs = 1200;
  maxHoldMs = 6000;
  constructor(public opts: ZoomOpts = DEFAULT_ZOOM) {}

  click(p: Pt, t: number) {
    // a click far from the current focus moves it; a click nearby keeps the view still
    if (!this.zoomedAt(t) || dist(p, this.focus) > this.opts.clusterRadius) this.focus = clampCenter(p, this.opts.scale);
    this.lastClick = t;
  }

  move(t: number) { this.lastMove = t; }

  zoomedAt(t: number) {
    const since = t - this.lastClick;
    return since < this.opts.holdMs || (since < this.maxHoldMs && t - this.lastMove < this.idleMs);
  }

  update(t: number, cursor: Pt | null): Omit<CameraFrame, "t"> {
    const dt = this.lastT == null ? 0 : Math.min(100, Math.max(0, t - this.lastT));
    this.lastT = t;
    const zoomed = this.zoomedAt(t);
    if (zoomed && cursor) this.focus = followDeadZone(this.focus, cursor, this.opts.scale, this.opts.deadZone);
    if (!zoomed) this.focus = { x: 0.5, y: 0.5 };
    const r = stepCamera(this.cam, zoomed ? this.opts.scale : 1, this.focus, dt, this.opts.omega);
    this.cam = r.cam;
    return r.frame;
  }

  reset() { this.cam = restingCamera(); this.focus = { x: 0.5, y: 0.5 }; this.lastClick = -Infinity; this.lastMove = -Infinity; this.lastT = null; }
}

/**
 * Without global mouse hooks we only see the cursor. A move that travels and then rests is
 * almost always a click target, so a rest after travel stands in for a click.
 */
export class DwellDetector {
  private anchor: Pt | null = null;
  private rest: TimedPt | null = null;
  private emitted = false;
  constructor(private o = { minTravel: 0.03, dwellMs: 400, still: 0.004 }) {}

  /** Feed a cursor sample; returns a stand-in click when one completes. */
  push(s: TimedPt): TimedPt | null {
    if (!this.anchor) { this.anchor = s; this.rest = s; return null; }
    if (this.rest && dist(s, this.rest) <= this.o.still) return this.tick(s.t);
    this.rest = s;
    this.emitted = false;
    return null;
  }

  /** Time passes without samples (the cursor is still): may complete a dwell. */
  tick(t: number): TimedPt | null {
    const r = this.rest;
    if (!r || !this.anchor || this.emitted) return null;
    if (t - r.t >= this.o.dwellMs && dist(r, this.anchor) >= this.o.minTravel) {
      this.emitted = true;
      this.anchor = r;
      return { ...r };
    }
    return null;
  }
}

export function estimateDwellClicks(samples: TimedPt[], o = { minTravel: 0.03, dwellMs: 400, still: 0.004 }): TimedPt[] {
  const d = new DwellDetector(o);
  const out: TimedPt[] = [];
  for (const s of samples) {
    const c = d.push(s);
    if (c) out.push(c);
  }
  return out;
}

/** Source rectangle (in source pixels) a camera frame shows from a w x h screen. Even sizes for yuv420. */
export function cropRect(f: Pick<CameraFrame, "scale" | "x" | "y">, w: number, h: number) {
  const even = (v: number) => Math.floor(v / 2) * 2;
  const cw = Math.max(2, even(w / f.scale)), ch = Math.max(2, even(h / f.scale));
  const x = even(clamp(f.x * w - cw / 2, 0, w - cw));
  const y = even(clamp(f.y * h - ch / 2, 0, h - ch));
  return { x: Math.min(x, w - cw), y: Math.min(y, h - ch), w: cw, h: ch };
}
