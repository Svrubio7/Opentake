import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM, FULL_VIEW, LiveZoom, ViewFilter, ZoomDirector, clampCenter, cropRect, cursorAt, estimateDwellClicks,
  followDeadZone, frameOf, simulateCamera, springStep, viewAt, type CameraFrame, type Pt, type View,
} from "./zoom-core";

describe("geometry", () => {
  it("clamps the view inside the screen", () => {
    expect(clampCenter({ x: 0, y: 1 }, 2)).toEqual({ x: 0.25, y: 0.75 });
    expect(clampCenter({ x: 0.1, y: 0.1 }, 1)).toEqual({ x: 0.5, y: 0.5 });
    expect(viewAt({ x: 1, y: 0 }, 2)).toEqual({ left: 0.5, top: 0, size: 0.5 });
    expect(frameOf(viewAt({ x: 0.5, y: 0.5 }, 2))).toEqual({ scale: 2, x: 0.5, y: 0.5 });
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

describe("springStep (the overlay pointer)", () => {
  it("settles on the target without overshoot", () => {
    let s = { value: 1, velocity: 0 };
    let max = 1;
    for (let i = 0; i < 120; i++) { s = springStep(s, 2, 1000 / 60, 7); max = Math.max(max, s.value); }
    expect(s.value).toBeCloseTo(2, 3);
    expect(max).toBeLessThanOrEqual(2 + 1e-9);
  });
});

/** a filter run toward one target, every frame */
function run(from: View, to: View, ms: number, fps: number, rate = DEFAULT_ZOOM.zoomInRate) {
  const f = new ViewFilter(from, rate);
  const out: View[] = [f.view];
  for (let t = 1000 / fps; t <= ms + 1e-9; t += 1000 / fps) out.push(f.step(to, rate, 1000 / fps));
  return out;
}

describe("ViewFilter", () => {
  const target = viewAt({ x: 0.7, y: 0.3 }, 1.8);

  it("eases in: the first frames barely move (no jolt), then it settles without overshoot", () => {
    const v = run(FULL_VIEW, target, 2500, 60);
    const total = FULL_VIEW.size - target.size;
    expect(FULL_VIEW.size - v[1].size).toBeLessThan(total * 0.001);
    expect(FULL_VIEW.size - v[3].size).toBeLessThan(total * 0.02);
    for (let i = 1; i < v.length; i++) {
      expect(v[i].size).toBeLessThanOrEqual(v[i - 1].size + 1e-12);
      expect(v[i].size).toBeGreaterThanOrEqual(target.size - 1e-12);
    }
    expect(v[v.length - 1].size).toBeCloseTo(target.size, 4);
  });

  it("takes about a second to zoom in (95% at 7.75 / rate)", () => {
    const v = run(FULL_VIEW, target, 2000, 60);
    const i95 = v.findIndex((x) => (FULL_VIEW.size - x.size) / (FULL_VIEW.size - target.size) >= 0.95);
    expect(i95 / 60).toBeCloseTo(7.75 / DEFAULT_ZOOM.zoomInRate, 1);
  });

  it("is frame rate independent", () => {
    const a = run(FULL_VIEW, target, 600, 30), b = run(FULL_VIEW, target, 600, 60);
    expect(a[a.length - 1].size).toBeCloseTo(b[b.length - 1].size, 9);
    expect(a[a.length - 1].left).toBeCloseTo(b[b.length - 1].left, 9);
  });

  it("is a pure zoom: the clicked point travels a straight line, never swoops", () => {
    const p = { x: 0.9, y: 0.12 }; // near the corner, so the view is clamped
    const v = run(FULL_VIEW, viewAt(p, 2.4), 2000, 60);
    const scr = (w: View) => ({ x: ((p.x - w.left) / w.size) * 1920, y: ((p.y - w.top) / w.size) * 1080 });
    const a = scr(v[0]), b = scr(v[v.length - 1]);
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    let along = 0;
    for (const w of v) {
      const s = scr(w);
      const perp = Math.abs(-(s.x - a.x) * (b.y - a.y) + (s.y - a.y) * (b.x - a.x)) / L;
      expect(perp).toBeLessThan(0.5);
      const d = ((s.x - a.x) * (b.x - a.x) + (s.y - a.y) * (b.y - a.y)) / L;
      expect(d).toBeGreaterThanOrEqual(along - 1e-6);
      along = d;
    }
  });

  it("never shows outside the screen, whatever the targets and the timing", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const f = new ViewFilter();
    let target = FULL_VIEW;
    for (let i = 0; i < 3000; i++) {
      if (rnd() < 0.05) target = rnd() < 0.3 ? FULL_VIEW : viewAt({ x: rnd(), y: rnd() }, 1 + rnd() * 1.4);
      const v = f.step(target, rnd() < 0.5 ? 6 : 8, 5 + rnd() * 60);
      expect(v.left).toBeGreaterThanOrEqual(-1e-12);
      expect(v.top).toBeGreaterThanOrEqual(-1e-12);
      expect(v.left + v.size).toBeLessThanOrEqual(1 + 1e-12);
      expect(v.top + v.size).toBeLessThanOrEqual(1 + 1e-12);
      expect(v.size).toBeGreaterThanOrEqual(1 / 2.4 - 1e-12);
    }
  });

  it("bends without a kink when the target changes mid-move", () => {
    const f = new ViewFilter();
    const dt = 1000 / 60;
    const xs: number[] = [];
    for (let i = 0; i < 120; i++) xs.push(f.step(i < 30 ? viewAt({ x: 0.2, y: 0.5 }, 2) : viewAt({ x: 0.8, y: 0.5 }, 2), 8, dt).left);
    const vel = xs.slice(1).map((x, i) => x - xs[i]);
    const peak = Math.max(...vel.map(Math.abs));
    for (let i = 1; i < vel.length; i++) expect(Math.abs(vel[i] - vel[i - 1])).toBeLessThan(peak * 0.15);
  });
});

/** the worst frame-to-frame change of the camera's speed, against its peak (0 = perfectly smooth) */
function velocityJump(fr: CameraFrame[]) {
  const z = fr.map((f) => Math.log(f.scale)), x = fr.map((f) => f.x * 1920), y = fr.map((f) => f.y * 1080);
  const d = (a: number[]) => a.slice(1).map((v, i) => v - a[i]);
  const vz = d(z), vx = d(x), vy = d(y);
  const pz = Math.max(1e-12, ...vz.map(Math.abs)), pp = Math.max(1e-12, ...vx.map((v, i) => Math.hypot(v, vy[i])));
  let worst = 0;
  for (let i = 1; i < vz.length; i++) worst = Math.max(worst, Math.abs(vz[i] - vz[i - 1]) / pz, Math.hypot(vx[i] - vx[i - 1], vy[i] - vy[i - 1]) / pp);
  return worst;
}

describe("simulateCamera (the export)", () => {
  const at = (frames: CameraFrame[], t: number) => frames.reduce((p, f) => (Math.abs(f.t - t) < Math.abs(p.t - t) ? f : p));

  it("starts zooming before the click so it is mostly in when the click happens, then goes back out", () => {
    const frames = simulateCamera([{ t: 2000, x: 0.8, y: 0.2 }], [], 9000, 30);
    expect(at(frames, 2000 - DEFAULT_ZOOM.leadMs - 50).scale).toBe(1);
    expect(at(frames, 2000).scale).toBeGreaterThan(1.6);
    expect(at(frames, 3000).scale).toBeCloseTo(1.8, 2);
    expect(at(frames, 3000).x).toBeGreaterThan(0.65);
    expect(at(frames, 3000).y).toBeLessThan(0.35);
    expect(at(frames, 9000).scale).toBeLessThan(1.01);
    expect(velocityJump(frames)).toBeLessThan(0.2);
  });

  it("keeps a dragged cursor in the picture (it follows where the cursor is going)", () => {
    const cursor: { t: number; x: number; y: number }[] = [];
    for (let t = 0; t <= 6000; t += 16) {
      const u = Math.min(1, Math.max(0, (t - 1700) / 1800));
      cursor.push({ t, x: 0.25 + 0.55 * u * u * (3 - 2 * u), y: 0.5 });
    }
    const frames = simulateCamera([{ t: 1500, x: 0.25, y: 0.5 }], cursor, 4000, 60);
    for (const f of frames.filter((f) => f.t >= 1500)) {
      const p = cursorAt(cursor, f.t)!;
      expect(Math.abs(p.x - f.x)).toBeLessThan(0.5 / f.scale);
    }
  });

  it("pans from one click to a nearby one instead of zooming out and back in", () => {
    const frames = simulateCamera([{ t: 1500, x: 0.3, y: 0.3 }, { t: 3500, x: 0.7, y: 0.6 }], [], 6000, 30);
    const mid = frames.filter((f) => f.t > 2500 && f.t < 4000);
    expect(Math.min(...mid.map((f) => f.scale))).toBeGreaterThan(1.75);
    expect(at(frames, 4500).x).toBeGreaterThan(0.6);
  });

  it("does not move while you type in the field you clicked", () => {
    const cursor = [{ t: 0, x: 0.35, y: 0.3 }, { t: 9000, x: 0.35, y: 0.3 }];
    const frames = simulateCamera([{ t: 1500, x: 0.35, y: 0.3 }], cursor, 3500, 30).filter((f) => f.t > 2500);
    for (const f of frames) { expect(f.x).toBeCloseTo(frames[0].x, 3); expect(f.y).toBeCloseTo(frames[0].y, 3); }
  });
});

describe("ZoomDirector", () => {
  it("keeps the view still for a click inside it and moves for one outside", () => {
    const d = new ZoomDirector({ ...DEFAULT_ZOOM, leadMs: 0 });
    d.click({ x: 0.5, y: 0.5 }, 0);
    const v0 = d.target(0, null).view;
    d.click({ x: 0.55, y: 0.48 }, 500);
    expect(d.target(500, null).view).toEqual(v0);
    d.click({ x: 0.9, y: 0.9 }, 900);
    expect(d.target(900, null).view.left).toBeGreaterThan(v0.left);
  });
  it("acts on a future click leadMs before it", () => {
    const d = new ZoomDirector();
    d.click({ x: 0.3, y: 0.3 }, 5000);
    expect(d.target(5000 - DEFAULT_ZOOM.leadMs - 1, null).zoomed).toBe(false);
    expect(d.target(5000 - DEFAULT_ZOOM.leadMs, null).zoomed).toBe(true);
  });
  it("stays zoomed while the mouse keeps moving, up to the cap, then goes out", () => {
    const d = new ZoomDirector({ ...DEFAULT_ZOOM, leadMs: 0 });
    d.click({ x: 0.5, y: 0.5 }, 0);
    let zoomed = true;
    for (let t = 0; t <= 4000; t += 100) zoomed = d.target(t, { x: 0.5 + t / 40000, y: 0.5 }).zoomed;
    expect(zoomed).toBe(true);
    let z = true;
    for (let t = 4000; t <= DEFAULT_ZOOM.maxHoldMs + 50; t += 100) z = d.target(t, { x: 0.6 + t / 40000, y: 0.5 }).zoomed;
    expect(z).toBe(false);
  });
});

describe("LiveZoom (the recording)", () => {
  it("zooms on a click and zooms out after inactivity, smoothly", () => {
    const z = new LiveZoom();
    const frames: CameraFrame[] = [];
    const p: Pt = { x: 0.2, y: 0.2 };
    for (let t = 0; t <= 7000; t += 1000 / 30) {
      if (t >= 500 && t < 500 + 1000 / 30) z.click(p, t);
      frames.push({ t, ...z.update(t, p) });
    }
    const at = (t: number) => frames.reduce((a, f) => (Math.abs(f.t - t) < Math.abs(a.t - t) ? f : a));
    expect(at(2000).scale).toBeGreaterThan(1.7);
    expect(at(7000).scale).toBeLessThan(1.05);
    expect(velocityJump(frames)).toBeLessThan(0.2);
  });
  it("moves the same way as the export when the click is known as it happens", () => {
    const z = new LiveZoom({ ...DEFAULT_ZOOM, leadMs: 0, cursorLeadMs: 0 });
    const live: CameraFrame[] = [];
    for (let t = 0; t <= 4000; t += 1000 / 30) {
      if (Math.abs(t - 1000) < 1) z.click({ x: 0.7, y: 0.4 }, 1000);
      live.push({ t, ...z.update(t, null) });
    }
    const exp = simulateCamera([{ t: 1000, x: 0.7, y: 0.4 }], [], 4000, 30, { ...DEFAULT_ZOOM, leadMs: 0, cursorLeadMs: 0 });
    live.forEach((f, i) => { expect(f.scale).toBeCloseTo(exp[i].scale, 9); expect(f.x).toBeCloseTo(exp[i].x, 9); });
  });
});

describe("LiveZoom behind real time (a delayed take)", () => {
  it("moves exactly like the export when the picture runs leadMs behind the clicks", () => {
    const clicks = [{ t: 1500, x: 0.25, y: 0.5 }, { t: 5200, x: 0.8, y: 0.3 }];
    const cursor: { t: number; x: number; y: number }[] = [];
    for (let t = 0; t <= 9000; t += 16) {
      const u = Math.min(1, Math.max(0, (t - 1700) / 1800));
      cursor.push({ t, x: 0.25 + 0.55 * u * u * (3 - 2 * u), y: 0.5 });
    }
    const D = DEFAULT_ZOOM.leadMs;
    const z = new LiveZoom();
    const live: CameraFrame[] = [];
    let ci = 0;
    for (let i = 0; i * (1000 / 30) <= 8000; i++) {
      const t = i * (1000 / 30);
      // a click reaches the engine at its real time, which the picture shows D later
      while (ci < clicks.length && clicks[ci].t <= t + D) { z.click(clicks[ci], clicks[ci].t); ci++; }
      live.push({ t, ...z.update(t, cursorAt(cursor, t), cursorAt(cursor, t + DEFAULT_ZOOM.cursorLeadMs)) });
    }
    const exp = simulateCamera(clicks, cursor, 8000, 30);
    live.forEach((f, i) => { expect(f.scale).toBeCloseTo(exp[i].scale, 9); expect(f.x).toBeCloseTo(exp[i].x, 9); expect(f.y).toBeCloseTo(exp[i].y, 9); });
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
