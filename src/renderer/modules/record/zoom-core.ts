// Auto zoom on clicks, as pure math. No DOM: the live compositor (engine.ts) and the
// full-quality export (src/main/record/export.ts) run the same functions, so both move alike.
// Coordinates are 0..1 inside the captured screen; times are ms.
//
// Two parts:
//  - ZoomDirector decides where the camera should be (zoomed or not, and on what). It reads
//    clicks that may lie in the future: the export knows every click, so it starts a zoom leadMs
//    before the click it serves; the live path learns of a click when it happens.
//  - ViewFilter moves the camera there. It smooths the view's edges (left, top, width) through
//    four first-order stages in series, the response of two critically damped springs in a row:
//    the motion leaves rest with no jolt (velocity, acceleration and jerk all start at zero),
//    eases into place without overshoot, and a target changed mid-move bends the path without a
//    kink. Smoothing the edges, not scale and centre apart, makes a zoom a pure zoom about one
//    fixed point: every point of the screen travels in a straight line, the clicked point never
//    swoops, and the view never leaves the screen (each stage only averages valid views).

export interface Pt { x: number; y: number }
export interface TimedPt extends Pt { t: number }

export interface ZoomOpts {
  /** how far in a zoom goes (1.6-2x reads as "focused" without losing context) */
  scale: number;
  /** a click this close (screen fraction) to the view's focus, while zoomed, keeps the view still */
  clusterRadius: number;
  /** the export starts a zoom this long before its click, so it lands as the click happens */
  leadMs: number;
  /** stay zoomed at least this long after the last click */
  holdMs: number;
  /** a moving mouse keeps the zoom until it rests this long, up to maxHoldMs after the click */
  idleMs: number;
  maxHoldMs: number;
  /** fraction of the zoomed view (from its edge) the cursor may enter before the view follows */
  deadZone: number;
  /** filter rate (1/s) while zoomed (zoom in and pans) and while going back out: 95% of a zoom
   *  in takes about 7.75 / zoomInRate seconds; going out is a little slower */
  zoomInRate: number;
  zoomOutRate: number;
  /** the export follows where the cursor will be this much later: the filter's own lag
   *  (4 / zoomInRate), so the view keeps up with a drag instead of trailing it */
  cursorLeadMs: number;
}

export const DEFAULT_ZOOM: ZoomOpts = {
  scale: 1.8,
  clusterRadius: 0.12,
  leadMs: 800,
  holdMs: 2200,
  idleMs: 1200,
  maxHoldMs: 6000,
  deadZone: 0.25,
  zoomInRate: 8,
  zoomOutRate: 6,
  cursorLeadMs: 500,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

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

/** A view as its top-left corner and its width (and height: the view keeps the screen's shape). */
export interface View { left: number; top: number; size: number }

export const FULL_VIEW: View = { left: 0, top: 0, size: 1 };

/** The view that shows `scale` x around `center`, kept inside the screen. */
export function viewAt(center: Pt, scale: number): View {
  const size = 1 / Math.max(1, scale);
  return { left: clamp(center.x - size / 2, 0, 1 - size), top: clamp(center.y - size / 2, 0, 1 - size), size };
}

export const frameOf = (v: View): Omit<CameraFrame, "t"> => ({ scale: 1 / v.size, x: v.left + v.size / 2, y: v.top + v.size / 2 });

const STAGES = 4;

/** One exact step of n first-order stages in series toward a fixed target (state relative to it). */
function cascadeStep(d: number[], k: number) {
  // d_n(t) = e^-wt * sum_j d_j(0) (wt)^(n-j) / (n-j)!
  const e = Math.exp(-k);
  const next = d.map((_, n) => {
    let sum = 0, term = 1;
    for (let j = n; j >= 0; j--) {
      sum += d[j] * term;
      term *= k / (n - j + 1);
    }
    return sum * e;
  });
  for (let i = 0; i < d.length; i++) d[i] = next[i];
}

/**
 * Moves a view toward a target view. The rate itself glides (over about rateGlideMs) when the
 * director switches between zooming in and going out, so the speed never jumps either.
 */
export class ViewFilter {
  private stages: number[][];
  private rate: number;
  private rateLag: number;
  constructor(start: View = FULL_VIEW, rate = DEFAULT_ZOOM.zoomOutRate, private rateGlideMs = 250) {
    this.stages = [start.left, start.top, start.size].map((v) => new Array<number>(STAGES).fill(v));
    this.rate = this.rateLag = rate;
  }

  get view(): View {
    const s = this.stages;
    return { left: s[0][STAGES - 1], top: s[1][STAGES - 1], size: s[2][STAGES - 1] };
  }

  private atRest() { return this.stages.every((st) => st.every((v) => Math.abs(v - st[0]) < 1e-7)); }

  step(target: View, rate: number, dtMs: number): View {
    const dt = Math.max(0, dtMs) / 1000;
    if (dt > 0) {
      // the rate glides through two short lags of its own (its speed is continuous too)
      // (at rest the rate can change at once: nothing is moving)
      const g = this.atRest() ? 1 : 1 - Math.exp(-dtMs / (this.rateGlideMs / 2));
      this.rateLag += (rate - this.rateLag) * g;
      this.rate += (this.rateLag - this.rate) * g;
      const k = this.rate * dt;
      const goal = [target.left, target.top, target.size];
      this.stages.forEach((st, i) => {
        const d = st.map((v) => v - goal[i]);
        cascadeStep(d, k);
        for (let n = 0; n < STAGES; n++) st[n] = goal[i] + d[n];
      });
    }
    return this.view;
  }
}

/** Where the camera should be, decided from clicks (also future ones) and the cursor. */
export class ZoomDirector {
  private clicks: TimedPt[] = [];
  private armed = 0;
  private focus: Pt = { x: 0.5, y: 0.5 };
  private zoomed = false;
  private lastClick = -Infinity;
  /** the cursor is not followed before the click a zoom was started for */
  private followFrom = -Infinity;
  private lastMove = -Infinity;
  private lastCursor: Pt | null = null;
  constructor(public opts: ZoomOpts = DEFAULT_ZOOM) {}

  /** A click at time t; it may be in the future (the export, a delayed picture). */
  click(p: Pt, t: number) {
    const c = { x: p.x, y: p.y, t };
    let i = this.clicks.length;
    while (i > this.armed && this.clicks[i - 1].t > t) i--;
    this.clicks.splice(i, 0, c);
  }

  isZoomed() { return this.zoomed; }

  /**
   * The view to aim for at time `now`, with the cursor where it is at that time; `ahead` is where
   * it will be cursorLeadMs later, when that is known (the export), and is what the view follows.
   */
  target(now: number, cursor: Pt | null, ahead: Pt | null = cursor): { view: View; zoomed: boolean } {
    const o = this.opts;
    // clicks start acting leadMs before they happen
    while (this.armed < this.clicks.length && this.clicks[this.armed].t - o.leadMs <= now) {
      const c = this.clicks[this.armed++];
      const keep = this.zoomed && this.insideComfort(c);
      if (!keep && (!this.zoomed || dist(c, this.focus) > o.clusterRadius)) this.focus = clampCenter(c, o.scale);
      this.zoomed = true;
      this.lastClick = Math.max(this.lastClick, c.t);
      this.followFrom = Math.max(this.followFrom, c.t);
    }
    if (cursor) {
      if (!this.lastCursor || dist(cursor, this.lastCursor) > 0.002) this.lastMove = now;
      this.lastCursor = cursor;
    }
    if (this.zoomed) {
      const since = now - this.lastClick;
      const alive = since < o.holdMs || (since < o.maxHoldMs && now - this.lastMove < o.idleMs);
      if (!alive) { this.zoomed = false; this.focus = { x: 0.5, y: 0.5 }; }
    }
    if (this.zoomed && ahead && now >= this.followFrom) this.focus = followDeadZone(this.focus, ahead, o.scale, o.deadZone);
    return { view: this.zoomed ? viewAt(this.focus, o.scale) : FULL_VIEW, zoomed: this.zoomed };
  }

  /** The click lands well inside the view already shown (its dead zone): no need to move. */
  private insideComfort(c: Pt) {
    const half = 0.5 / Math.max(1, this.opts.scale);
    const limit = half * (1 - this.opts.deadZone);
    return Math.abs(c.x - this.focus.x) <= limit && Math.abs(c.y - this.focus.y) <= limit;
  }

  reset() {
    this.clicks = []; this.armed = 0; this.focus = { x: 0.5, y: 0.5 }; this.zoomed = false;
    this.lastClick = this.followFrom = this.lastMove = -Infinity; this.lastCursor = null;
  }
}

/** The director and the filter together: one camera, stepped one frame at a time. */
export class ZoomCamera {
  readonly director: ZoomDirector;
  private filter: ViewFilter;
  private lastT: number | null = null;
  constructor(private o: ZoomOpts = DEFAULT_ZOOM) {
    this.director = new ZoomDirector(o);
    this.filter = new ViewFilter(FULL_VIEW, o.zoomOutRate);
  }
  get opts() { return this.o; }
  set opts(o: ZoomOpts) { this.o = o; this.director.opts = o; }

  /** dtMs caps a long gap (a stalled frame), so the camera never jumps. */
  step(t: number, cursor: Pt | null, ahead: Pt | null = cursor, maxDtMs = Infinity): Omit<CameraFrame, "t"> {
    const dt = this.lastT == null ? 0 : Math.min(maxDtMs, Math.max(0, t - this.lastT));
    this.lastT = t;
    const { view, zoomed } = this.director.target(t, cursor, ahead);
    return frameOf(this.filter.step(view, zoomed ? this.o.zoomInRate : this.o.zoomOutRate, dt));
  }

  reset() { this.director.reset(); this.filter = new ViewFilter(FULL_VIEW, this.o.zoomOutRate); this.lastT = null; }
}

/**
 * Replays a recording's clicks and cursor into one camera frame per output frame. The same
 * camera as the live path; here every click is known ahead, so each zoom starts leadMs early.
 */
export function simulateCamera(clicks: TimedPt[], cursor: TimedPt[], durationMs: number, fps: number, o: ZoomOpts = DEFAULT_ZOOM): CameraFrame[] {
  const cam = new ZoomCamera(o);
  for (const c of [...clicks].sort((a, b) => a.t - b.t)) cam.director.click(c, c.t);
  const step = 1000 / fps;
  const frames: CameraFrame[] = [];
  for (let i = 0; i * step <= durationMs + 1e-6; i++) {
    const t = i * step;
    frames.push({ t, ...cam.step(t, cursorAt(cursor, t), cursorAt(cursor, t + o.cursorLeadMs)) });
  }
  return frames;
}

/**
 * Live zoom for the preview and the recording: the same camera, fed as things happen.
 * The engine passes a click when it arrives and the cursor every frame.
 */
export class LiveZoom {
  private cam: ZoomCamera;
  constructor(opts: ZoomOpts = DEFAULT_ZOOM) { this.cam = new ZoomCamera(opts); }
  get opts() { return this.cam.opts; }
  set opts(o: ZoomOpts) { this.cam.opts = o; }

  click(p: Pt, t: number) { this.cam.director.click(p, t); }

  /** kept for callers that report movement on its own; the cursor passed to update() decides */
  move(_t: number) {}

  zoomedAt() { return this.cam.director.isZoomed(); }

  /** `ahead`: where the cursor is cursorLeadMs later, when the picture runs behind real time and knows it */
  update(t: number, cursor: Pt | null, ahead: Pt | null = cursor): Omit<CameraFrame, "t"> { return this.cam.step(t, cursor, ahead, 100); }

  reset() { this.cam.reset(); }
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
