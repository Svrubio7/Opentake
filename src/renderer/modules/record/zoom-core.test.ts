import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM, LiveZoom, clampCenter, clusterClicks, cropRect, cursorAt, estimateDwellClicks,
  followDeadZone, planZoomSegments, simulateCamera, springStep,
} from "./zoom-core";

describe("clusterClicks", () => {
  it("joins clicks close in space and time", () => {
    const c = clusterClicks([{ t: 0, x: 0.5, y: 0.5 }, { t: 500, x: 0.52, y: 0.5 }, { t: 900, x: 0.5, y: 0.52 }]);
    expect(c).toHaveLength(1);
    expect(c[0].count).toBe(3);
    expect(c[0].end).toBe(900);
  });
  it("splits on distance and on a long gap", () => {
    expect(clusterClicks([{ t: 0, x: 0.1, y: 0.1 }, { t: 200, x: 0.9, y: 0.9 }])).toHaveLength(2);
    expect(clusterClicks([{ t: 0, x: 0.5, y: 0.5 }, { t: 5000, x: 0.5, y: 0.5 }])).toHaveLength(2);
  });
  it("sorts unsorted input", () => {
    const c = clusterClicks([{ t: 5000, x: 0.5, y: 0.5 }, { t: 0, x: 0.1, y: 0.1 }]);
    expect(c[0].start).toBe(0);
  });
});

describe("planZoomSegments", () => {
  it("leads in before the click and holds after it", () => {
    const [s] = planZoomSegments([{ t: 2000, x: 0.3, y: 0.3 }]);
    expect(s.start).toBe(2000 - DEFAULT_ZOOM.leadMs);
    expect(s.end).toBe(2000 + DEFAULT_ZOOM.holdMs);
    expect(s.scale).toBe(DEFAULT_ZOOM.scale);
  });
  it("never starts before zero", () => {
    expect(planZoomSegments([{ t: 100, x: 0.3, y: 0.3 }])[0].start).toBe(0);
  });
  it("hands over to a close next zoom so the camera pans instead of bouncing out", () => {
    const s = planZoomSegments([{ t: 1000, x: 0.1, y: 0.1 }, { t: 3600, x: 0.9, y: 0.9 }]);
    expect(s).toHaveLength(2);
    expect(s[0].end).toBe(s[1].start);
  });
  it("leaves far apart zooms alone", () => {
    const s = planZoomSegments([{ t: 1000, x: 0.1, y: 0.1 }, { t: 20000, x: 0.9, y: 0.9 }]);
    expect(s[0].end).toBe(1000 + DEFAULT_ZOOM.holdMs);
  });
});

describe("geometry", () => {
  it("clamps the view inside the screen", () => {
    expect(clampCenter({ x: 0, y: 1 }, 2)).toEqual({ x: 0.25, y: 0.75 });
    expect(clampCenter({ x: 0.1, y: 0.1 }, 1)).toEqual({ x: 0.5, y: 0.5 });
  });
  it("does not move inside the dead zone", () => {
    expect(followDeadZone({ x: 0.5, y: 0.5 }, { x: 0.55, y: 0.45 }, 2, 0.25)).toEqual({ x: 0.5, y: 0.5 });
  });
  it("follows a cursor that leaves the dead zone just enough", () => {
    const c = followDeadZone({ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.5 }, 2, 0.25);
    // half view = 0.25, allowed offset = 0.1875
    expect(c.x).toBeCloseTo(0.7 - 0.1875);
    expect(c.y).toBe(0.5);
  });
  it("crops even sizes inside the source", () => {
    const r = cropRect({ scale: 2, x: 1, y: 0 }, 1921, 1081);
    expect(r.w % 2).toBe(0);
    expect(r.h % 2).toBe(0);
    expect(r.x + r.w).toBeLessThanOrEqual(1921);
    expect(r.y).toBe(0);
  });
  it("interpolates cursor samples", () => {
    const s = [{ t: 0, x: 0, y: 0 }, { t: 100, x: 1, y: 0.5 }];
    expect(cursorAt(s, 50)).toEqual({ x: 0.5, y: 0.25 });
    expect(cursorAt(s, -5)).toEqual(s[0]);
    expect(cursorAt([], 5)).toBeNull();
  });
});

describe("springStep", () => {
  it("settles on the target without overshoot", () => {
    let s = { value: 1, velocity: 0 };
    let max = 1;
    for (let i = 0; i < 120; i++) { s = springStep(s, 2, 1000 / 60, 7); max = Math.max(max, s.value); }
    expect(s.value).toBeCloseTo(2, 3);
    expect(max).toBeLessThanOrEqual(2 + 1e-9);
  });
  it("is frame rate independent", () => {
    let a = { value: 0, velocity: 0 }, b = { value: 0, velocity: 0 };
    for (let i = 0; i < 30; i++) a = springStep(a, 1, 1000 / 30, 7);
    for (let i = 0; i < 60; i++) b = springStep(b, 1, 1000 / 60, 7);
    expect(a.value).toBeCloseTo(b.value, 6);
  });
});

describe("simulateCamera", () => {
  it("zooms in around a click and back out after", () => {
    const frames = simulateCamera([{ t: 1000, x: 0.8, y: 0.2 }], [], 8000, 30);
    const at = (t: number) => frames.reduce((p, f) => (Math.abs(f.t - t) < Math.abs(p.t - t) ? f : p));
    expect(at(0).scale).toBe(1);
    expect(at(2500).scale).toBeGreaterThan(1.7);
    expect(at(2500).x).toBeGreaterThan(0.65);
    expect(at(2500).y).toBeLessThan(0.35);
    expect(at(8000).scale).toBeLessThan(1.05);
  });
  it("follows the cursor while zoomed", () => {
    const cursor = [{ t: 1000, x: 0.3, y: 0.5 }, { t: 1500, x: 0.3, y: 0.5 }, { t: 2500, x: 0.75, y: 0.5 }];
    const frames = simulateCamera([{ t: 1000, x: 0.3, y: 0.5 }], cursor, 3000, 60);
    const end = frames[frames.length - 1];
    expect(end.x).toBeGreaterThan(0.45);
  });
});

describe("LiveZoom", () => {
  it("zooms on a click and zooms out after inactivity", () => {
    const z = new LiveZoom();
    z.update(0, null);
    z.click({ x: 0.2, y: 0.2 }, 0);
    let f = z.update(0, null);
    for (let t = 16; t <= 1500; t += 16) f = z.update(t, { x: 0.2, y: 0.2 });
    expect(f.scale).toBeGreaterThan(1.7);
    for (let t = 1500; t <= 6000; t += 16) f = z.update(t, { x: 0.2, y: 0.2 });
    expect(f.scale).toBeLessThan(1.05);
  });
  it("stays zoomed while the mouse keeps moving, up to the cap", () => {
    const z = new LiveZoom();
    z.click({ x: 0.5, y: 0.5 }, 0);
    for (let t = 0; t <= 4000; t += 100) z.move(t);
    expect(z.zoomedAt(4000)).toBe(true);
    expect(z.zoomedAt(z.maxHoldMs + 10)).toBe(false);
  });
});

describe("estimateDwellClicks", () => {
  it("turns a travel then a rest into one click", () => {
    const s: { t: number; x: number; y: number }[] = [];
    for (let i = 0; i <= 10; i++) s.push({ t: i * 20, x: 0.1 + i * 0.03, y: 0.5 });
    for (let i = 1; i <= 30; i++) s.push({ t: 200 + i * 20, x: 0.4, y: 0.5 });
    const c = estimateDwellClicks(s);
    expect(c).toHaveLength(1);
    expect(c[0].x).toBeCloseTo(0.4);
  });
  it("ignores a cursor that never moves", () => {
    const s = Array.from({ length: 50 }, (_, i) => ({ t: i * 20, x: 0.5, y: 0.5 }));
    expect(estimateDwellClicks(s)).toHaveLength(0);
  });
});
