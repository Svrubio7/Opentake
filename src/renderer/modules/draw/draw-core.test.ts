import { describe, expect, it } from "vitest";
import {
  FADE_HOLD_MS, FADE_OUT_MS, addPoint, arrowHead, arrowPath, distToSegment, fadeOpacity, freehandPath, hitStroke, liveStrokes,
  nextExpiry, rectFrom, smooth, strokeAt, strokePath, type Stroke,
} from "./draw-core";

const s = (p: Partial<Stroke>): Stroke => ({ id: 1, tool: "pen", color: "#ff3b30", points: [], ...p });

describe("freehand", () => {
  it("drops samples closer than the minimum distance", () => {
    let pts = addPoint([], { x: 0, y: 0 });
    pts = addPoint(pts, { x: 1, y: 0 });
    pts = addPoint(pts, { x: 3, y: 0 });
    expect(pts).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }]);
  });
  it("smooths jitter but keeps the ends", () => {
    const zig = [{ x: 0, y: 0 }, { x: 10, y: 6 }, { x: 20, y: -6 }, { x: 30, y: 6 }, { x: 40, y: 0 }];
    const out = smooth(zig);
    expect(out[0]).toEqual(zig[0]);
    expect(out[4]).toEqual(zig[4]);
    const spread = (p: { y: number }[]) => Math.max(...p.map((q) => q.y)) - Math.min(...p.map((q) => q.y));
    expect(spread(out)).toBeLessThan(spread(zig));
  });
  it("draws a dot for a tap and curves for a line", () => {
    expect(freehandPath([{ x: 5, y: 5 }])).toMatch(/^M5 5L5\.1 5$/);
    expect(freehandPath([])).toBe("");
    expect(freehandPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }])).toMatch(/^M0 0Q.*L20 10$/);
  });
});

describe("shapes", () => {
  it("puts the arrow head symmetric around the shaft, behind the tip", () => {
    const [l, r] = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 5);
    expect(l.x).toBeCloseTo(r.x);
    expect(l.y).toBeCloseTo(-r.y);
    expect(l.x).toBeLessThan(100);
  });
  it("keeps the head shorter than half a short shaft", () => {
    const [l] = arrowHead({ x: 0, y: 0 }, { x: 10, y: 0 }, 5);
    expect(Math.hypot(10 - l.x, l.y)).toBeLessThanOrEqual(5.0001);
  });
  it("draws nothing for an arrow with no length", () => {
    expect(arrowPath({ x: 3, y: 3 }, { x: 3, y: 3 }, 5)).toBe("");
  });
  it("normalises a rectangle dragged backwards", () => {
    expect(rectFrom({ x: 50, y: 40 }, { x: 10, y: 0 })).toEqual({ x: 10, y: 0, w: 40, h: 40 });
    expect(strokePath(s({ tool: "rect", points: [{ x: 50, y: 40 }, { x: 10, y: 0 }] }))).toBe("M10 0h40v40h-40Z");
  });
});

describe("fading", () => {
  const done = s({ doneAt: 1000 });
  it("holds, then fades to zero", () => {
    expect(fadeOpacity(done, 1000 + FADE_HOLD_MS, true)).toBe(1);
    expect(fadeOpacity(done, 1000 + FADE_HOLD_MS + FADE_OUT_MS / 2, true)).toBeCloseTo(0.5);
    expect(fadeOpacity(done, 1000 + FADE_HOLD_MS + FADE_OUT_MS, true)).toBe(0);
  });
  it("never fades a stroke being drawn or with fading off", () => {
    expect(fadeOpacity(s({}), 1e9, true)).toBe(1);
    expect(fadeOpacity(done, 1e9, false)).toBe(1);
  });
  it("drops gone strokes and says when the next one goes", () => {
    const list = [s({ id: 1, doneAt: 0 }), s({ id: 2, doneAt: 3000 }), s({ id: 3 })];
    const now = FADE_HOLD_MS + FADE_OUT_MS + 1;
    expect(liveStrokes(list, now, true).map((x) => x.id)).toEqual([2, 3]);
    expect(liveStrokes(list, now, false)).toHaveLength(3);
    expect(nextExpiry(list, now, true)).toBe(3000 + FADE_HOLD_MS + FADE_OUT_MS - now);
    expect(nextExpiry(list, now, false)).toBeNull();
  });
});

describe("hit testing", () => {
  it("measures distance to a segment, clamped at its ends", () => {
    expect(distToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(3);
    expect(distToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
  it("hits a line near it, not far from it", () => {
    const line = s({ points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
    expect(hitStroke(line, { x: 50, y: 6 })).toBe(true);
    expect(hitStroke(line, { x: 50, y: 30 })).toBe(false);
  });
  it("hits a rectangle on its edge, not in its middle", () => {
    const box = s({ tool: "rect", points: [{ x: 0, y: 0 }, { x: 100, y: 100 }] });
    expect(hitStroke(box, { x: 100, y: 50 })).toBe(true);
    expect(hitStroke(box, { x: 50, y: 50 })).toBe(false);
  });
  it("finds the last drawn stroke first", () => {
    const a = s({ id: 1, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }] });
    const b = s({ id: 2, tool: "arrow", points: [{ x: 50, y: -50 }, { x: 50, y: 50 }] });
    expect(strokeAt([a, b], { x: 50, y: 0 })).toBe(1);
    expect(strokeAt([a, b], { x: 10, y: 0 })).toBe(0);
    expect(strokeAt([a, b], { x: 300, y: 300 })).toBe(-1);
  });
});
