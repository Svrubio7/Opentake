// The delayed picture, as pure math (tested in delay-core.test.ts). During a take with auto zoom,
// the compositor draws everything DELAY_MS behind real time: a click is then known before the
// picture reaches it, so the live recording zooms ahead of each click like the hi-res export does.
// The screen and camera frames wait in rings of canvases (frame-ring.ts), the sound waits in a
// DelayNode, and the composite recorder starts, pauses and stops DELAY_MS after the others, so the
// file's clock is still the take's clock (timeline, ISO tracks and exports need no shift).
import type { RecordMode } from "@shared/types";
import { t } from "../../../shared/i18n";

/** How far behind the picture runs: the zoom's lead, so a live zoom lands as the export's does. */
export const DELAY_MS = 800;

/** Slots a ring needs to hold `delayMs` of frames drawn every `tickMs` (and one spare each side). */
export const ringSlots = (delayMs: number, tickMs: number) => Math.ceil(delayMs / tickMs) + 2;

/**
 * The size a stored frame needs: what the compositor can show of it. The screen is drawn into a
 * window of `box` pixels and enlarged up to `zoom` times inside it; storing more than that (a 4K
 * screen in a 1080p take) only costs memory. Keeps the source's shape, never above its own size.
 */
export function storeSize(native: { w: number; h: number }, box: { w: number; h: number }, zoom = 1): { w: number; h: number } {
  if (!native.w || !native.h) return { w: 0, h: 0 };
  const need = Math.max((box.w * zoom) / native.w, (box.h * zoom) / native.h);
  const s = Math.min(1, need);
  return { w: Math.max(2, Math.round(native.w * s)), h: Math.max(2, Math.round(native.h * s)) };
}

export interface DelayInput {
  zoomEnabled: boolean;
  /** the pointer is tracked on the captured display (a single window has no zoom) */
  normalized: boolean;
  mode: RecordMode;
  fps: number;
  /**
   * The largest stored sizes of one screen frame and one camera frame over every scene the take can
   * switch to (0 x 0 when there is none): a ring keeps its canvases at the largest size it was given,
   * so a take started on the screen alone still grows its camera ring after a switch to the camera.
   */
  screen: { w: number; h: number };
  camera: { w: number; h: number };
  /** the screen and camera are also recorded on their own tracks (ISO) */
  isoTracks?: boolean;
  /** navigator.deviceMemory (GB, rounded down, at most 8), when the browser says */
  deviceMemoryGb?: number;
}

/**
 * What a canvas costs the GPU beyond its RGBA pixels: measured in the app with nvidia-smi, the rings
 * of a 1080p60 take took 775 MB against 490 MB of pixels, a 1080p30 take 470 MB against 255 MB.
 */
export const RING_OVERHEAD = 1.7;

/** Memory the rings take for a take (RGBA canvases and what the GPU keeps around them). */
export function ringBytes(i: Pick<DelayInput, "fps" | "screen" | "camera">, delayMs = DELAY_MS): number {
  return ringSlots(delayMs, 1000 / i.fps) * 4 * (i.screen.w * i.screen.h + i.camera.w * i.camera.h) * RING_OVERHEAD;
}

/** Never more than this for the rings, and never more than a share of the computer's memory. */
export const RING_BUDGET = 1.5 * 1024 ** 3;

/**
 * How far the stored frames may shrink (each side) to fit the budget before the delay is given up:
 * at 0.8 a zoomed-in 4K screen is still sharper than the 1080p picture it is shown in.
 */
export const MIN_STORE_SCALE = 0.8;

/** A stored size shrunk by `scale` (each side), never below 2 x 2 unless there is none. */
export const scaleStore = (s: { w: number; h: number }, scale: number) =>
  !s.w || !s.h || scale >= 1 ? s : { w: Math.max(2, Math.round(s.w * scale)), h: Math.max(2, Math.round(s.h * scale)) };

/**
 * A stored size kept within the pixels the budget was planned for (`cap`), keeping its shape: a
 * camera that opens bigger than assumed, or a scene planned smaller, never grows the rings past it.
 */
export function capStore(s: { w: number; h: number }, cap: { w: number; h: number }): { w: number; h: number } {
  const area = s.w * s.h, max = cap.w * cap.h;
  if (!area || area <= max) return s;
  if (!max) return { w: 0, h: 0 };
  return scaleStore(s, Math.sqrt(max / area));
}

/** The larger of two stored sizes, each kind on its own (the ring holds the largest it was given). */
export const largerStore = (a: { w: number; h: number }, b: { w: number; h: number }) => (a.w * a.h >= b.w * b.h ? a : b);

/**
 * Whether this take draws its picture behind real time, when the rings fit in memory: with auto zoom
 * on a tracked screen (the zoom arrives with each click), and in any take that also records ISO
 * tracks. Started at the same moment as the ISO recorders, the composite lost 0.4-0.6 s of picture
 * at the start of every take while their encoders set up; started DELAY_MS later it loses none.
 * `reason` says why the zoom cannot run ahead, for a hint (null: delay on, or nothing to say).
 */
export function planDelay(i: DelayInput): { delayMs: number; bytes: number; scale: number; reason: string | null } {
  const off = { delayMs: 0, bytes: 0, scale: 1, reason: null };
  if (i.mode === "camera") return off;
  const zoom = i.zoomEnabled && i.normalized;
  if (!zoom && !i.isoTracks) return off;
  const fit = fitRings(i);
  // only the zoom has something to say: a staggered start that does not fit just starts together
  if (!zoom) return fit.reason ? { ...fit, delayMs: 0, scale: 1, reason: null } : fit;
  return fit;
}

function fitRings(i: DelayInput): { delayMs: number; bytes: number; scale: number; reason: string | null } {
  const bytes = ringBytes(i);
  // the browser reports at most 8 GB: a quarter of it (2 GB) is never the limit, the budget is
  const share = i.deviceMemoryGb ? i.deviceMemoryGb * 1024 ** 3 * 0.25 : Infinity;
  if (i.deviceMemoryGb && i.deviceMemoryGb < 4) {
    return { delayMs: 0, bytes, scale: 1, reason: t("record.delay.lowMemory") };
  }
  const budget = Math.min(RING_BUDGET, share);
  if (bytes <= budget) return { delayMs: DELAY_MS, bytes, scale: 1, reason: null };
  // a little over: store every frame a little smaller instead of giving the delay up
  const scale = Math.floor(Math.sqrt(budget / bytes) * 100) / 100;
  if (scale >= MIN_STORE_SCALE) {
    const fitted = ringBytes({ fps: i.fps, screen: scaleStore(i.screen, scale), camera: scaleStore(i.camera, scale) });
    if (fitted <= budget) return { delayMs: DELAY_MS, bytes: fitted, scale, reason: null };
  }
  return { delayMs: 0, bytes, scale: 1, reason: t("record.delay.tooBig") };
}

/** Values stamped with a real time, read back as they were at a delayed time. */
export class History<T> {
  private items: { t: number; v: T }[] = [];
  constructor(private keepMs = 5000) {}
  push(t: number, v: T) {
    this.items.push({ t, v });
    const cut = t - this.keepMs;
    let n = 0;
    // keep one entry from before the window, so a value set long ago is still known
    while (n + 1 < this.items.length && this.items[n + 1].t <= cut) n++;
    if (n) this.items.splice(0, n);
  }
  /** the value in force at time t (the first one when t is before all of them) */
  at(t: number): T | undefined {
    let v = this.items[0]?.v;
    for (const it of this.items) { if (it.t <= t) v = it.v; else break; }
    return v;
  }
  clear() { this.items = []; }
}

/** Events stamped with a real time, handed out once the delayed clock reaches them. */
export class Pending<T> {
  private items: { t: number; v: T }[] = [];
  push(t: number, v: T) { this.items.push({ t, v }); }
  /** the events due at time t, oldest first; they are removed */
  due(t: number): { t: number; v: T }[] {
    let n = 0;
    while (n < this.items.length && this.items[n].t <= t) n++;
    return n ? this.items.splice(0, n) : [];
  }
  clear() { this.items = []; }
}

/** Index of the stored frame to show at time t: the newest stored no later than t (+ half a tick). */
export function pickFrame(times: readonly number[], t: number, tickMs: number): number {
  let best = -1, bestT = -Infinity;
  for (let i = 0; i < times.length; i++) {
    const s = times[i];
    if (s <= t + tickMs / 2 && s > bestT) { best = i; bestT = s; }
  }
  return best;
}

/**
 * The composite recorder runs DELAY_MS behind the others: each of its start / pause / resume /
 * stop happens that long after the button, in order. Returns a function that schedules one.
 */
export function laterQueue(delayMs: number, timer: (fn: () => void, ms: number) => unknown = setTimeout) {
  let last = 0;
  return (fn: () => void, now = Date.now()) => {
    if (delayMs <= 0) return fn();
    // same delay for each, so they keep their order; never before the one before it
    const at = Math.max(now + delayMs, last);
    last = at;
    timer(fn, at - now);
  };
}


/**
 * Where a take's composite sound gets its delay. It must be delayed inside the graph that makes it:
 * the computer-sound mix when there is one ("mix"), else the voice engine ("voice"). Only a mic
 * opened without the engine goes through an audio context of its own ("hop"), which adds 50 ms.
 */
export function delayedSoundPath(o: { delayMs: number; hasSound: boolean; systemMix: boolean; voiceEngine: boolean }): "none" | "mix" | "voice" | "hop" {
  if (!o.delayMs || !o.hasSound) return "none";
  if (o.systemMix) return "mix";
  return o.voiceEngine ? "voice" : "hop";
}
