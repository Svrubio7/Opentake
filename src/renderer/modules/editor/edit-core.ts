// Cuts as pure functions (tested in edit-core.test.ts). A take's edit is the list of stretches that
// stay, in ms on the recording clock. Neighbouring stretches may touch: that is a split, and each
// side can be selected and deleted on its own. The main process imports this for the export.
import type { TakeEdit, TimeRange } from "@shared/types";

/** Shorter than this, a stretch is a slip of the mouse, not a cut. */
export const MIN_RANGE_MS = 40;

export const wholeTake = (durationMs: number): TimeRange[] => [{ start: 0, end: Math.max(0, durationMs) }];

/** Sorted, clamped to the take, overlaps folded together, slivers dropped. Touching stretches stay apart. */
export function normalizeKeep(keep: TimeRange[], durationMs: number): TimeRange[] {
  const out: TimeRange[] = [];
  const sorted = keep
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r) => ({ start: Math.max(0, Math.round(r.start)), end: Math.min(durationMs, Math.round(r.end)) }))
    .filter((r) => r.end - r.start >= MIN_RANGE_MS)
    .sort((a, b) => a.start - b.start);
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start < last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Touching stretches joined: what the export needs (one trim per real cut). */
export function mergeTouching(keep: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of keep) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export const keptDuration = (keep: TimeRange[]) => keep.reduce((a, r) => a + (r.end - r.start), 0);

/** True when the edit cuts nothing out of the take. */
export function isWhole(keep: TimeRange[], durationMs: number): boolean {
  const m = mergeTouching(keep);
  return m.length === 1 && m[0].start <= 1 && m[0].end >= durationMs - 1;
}

export const indexAt = (keep: TimeRange[], t: number) => keep.findIndex((r) => t >= r.start && t < r.end);

/** A recording-clock time on the edited timeline, or null when it was cut. */
export function toEdited(t: number, keep: TimeRange[]): number | null {
  let acc = 0;
  for (const r of keep) {
    if (t < r.start) return null;
    if (t < r.end) return acc + (t - r.start);
    acc += r.end - r.start;
  }
  return t === keep[keep.length - 1]?.end ? acc : null;
}

/** An edited-timeline time back on the recording clock. */
export function toSource(t: number, keep: TimeRange[]): number {
  let acc = 0;
  for (const r of keep) {
    const len = r.end - r.start;
    if (t < acc + len) return r.start + Math.max(0, t - acc);
    acc += len;
  }
  return keep[keep.length - 1]?.end ?? 0;
}

/**
 * Where playback goes from here: the same time when it is kept, the start of the next stretch when
 * it falls in a cut, null past the last stretch.
 */
export function playableAt(t: number, keep: TimeRange[]): number | null {
  for (const r of keep) {
    if (t < r.start) return r.start;
    if (t < r.end) return t;
  }
  return null;
}

/** Splits the stretch under t in two. Nothing changes too close to an edge. */
export function splitAt(keep: TimeRange[], t: number): TimeRange[] {
  const i = indexAt(keep, t);
  if (i < 0) return keep;
  const r = keep[i];
  if (t - r.start < MIN_RANGE_MS || r.end - t < MIN_RANGE_MS) return keep;
  return [...keep.slice(0, i), { start: r.start, end: t }, { start: t, end: r.end }, ...keep.slice(i + 1)];
}

export const removeAt = (keep: TimeRange[], i: number): TimeRange[] => keep.filter((_, j) => j !== i);

/** Everything before t is cut (the in point). */
export function setIn(keep: TimeRange[], t: number): TimeRange[] {
  return keep.map((r) => ({ start: Math.max(r.start, t), end: r.end })).filter((r) => r.end - r.start >= MIN_RANGE_MS);
}

/** Everything after t is cut (the out point). */
export function setOut(keep: TimeRange[], t: number): TimeRange[] {
  return keep.map((r) => ({ start: r.start, end: Math.min(r.end, t) })).filter((r) => r.end - r.start >= MIN_RANGE_MS);
}

/** The cut stretches between the kept ones (for drawing and restoring). */
export function gaps(keep: TimeRange[], durationMs: number): TimeRange[] {
  const out: TimeRange[] = [];
  let at = 0;
  for (const r of keep) {
    if (r.start - at >= 1) out.push({ start: at, end: r.start });
    at = Math.max(at, r.end);
  }
  if (durationMs - at >= 1) out.push({ start: at, end: durationMs });
  return out;
}

/** Puts a cut stretch back. */
export function restore(keep: TimeRange[], gap: TimeRange, durationMs: number): TimeRange[] {
  const next = [...keep, gap].sort((a, b) => a.start - b.start);
  // the restored stretch touches its neighbours: keep them apart so the old splits survive
  return normalizeKeep(next, durationMs);
}

/** Keeps only what lies between two edited-timeline times (silence trimmed off the edited result). */
export function clipEdited(keep: TimeRange[], startMs: number, endMs: number | null): TimeRange[] {
  const lo = Math.max(0, startMs);
  const hi = endMs ?? Infinity;
  const out: TimeRange[] = [];
  let acc = 0;
  for (const r of keep) {
    const len = r.end - r.start;
    const a = Math.max(acc, lo), b = Math.min(acc + len, hi);
    if (b - a >= 1) out.push({ start: r.start + (a - acc), end: r.start + (b - acc) });
    acc += len;
  }
  return out;
}

export function parseEdit(raw: unknown, durationMs: number): TakeEdit | null {
  const e = raw as TakeEdit | null;
  if (!e || e.version !== 1 || !Array.isArray(e.keep)) return null;
  const keep = normalizeKeep(e.keep.filter((r) => r && typeof r.start === "number" && typeof r.end === "number"), durationMs);
  return { version: 1, keep };
}

// ---- undo history ----

export interface History<T> { past: T[]; present: T; future: T[] }

export const history = <T>(present: T): History<T> => ({ past: [], present, future: [] });

const LIMIT = 200;

export function push<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: [...h.past, h.present].slice(-LIMIT), present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) };
}

/** 1:05.3 style, for the editor's clock and the timeline ruler. */
export function formatTime(ms: number, tenths = true): string {
  // whole seconds round to the nearest (6.999 s reads 0:07), tenths to the nearest tenth
  const t = Math.max(0, tenths ? Math.round(ms / 100) * 100 : Math.round(ms / 1000) * 1000);
  const m = Math.floor(t / 60000);
  const s = (t % 60000) / 1000;
  const sec = tenths ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0");
  return `${m}:${sec}`;
}

/** A ruler step that leaves at least `minPx` between labels. */
export function rulerStep(pxPerSec: number, minPx = 80): number {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return steps.find((s) => s * pxPerSec >= minPx) ?? 1200;
}
