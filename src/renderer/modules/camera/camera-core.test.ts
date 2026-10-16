import { describe, expect, it } from "vitest";
import {
  AUTO_KEYS, LOOKS, NEUTRAL, applyLook, approach, assessLighting, autoFrameStep, autoTarget, coverFit, cropFor, easeAuto,
  effectiveAdjust, fpsOptions, generateLut, histogram, initialAutoState, initialFrameState, invertWb, linearToSrgb, lookById,
  measureFrame, resolutionOptions, segmentationInterval, shoulder, srgbToLinear, toneCurve, updateAutoGoal, wbGains,
  type AutoValues, type FrameStats, type Rect,
} from "./camera-core";

/** w x h RGBA frame filled by fn(nx, ny) -> [r,g,b] in 0..255 */
function frame(w: number, h: number, fn: (x: number, y: number) => [number, number, number]) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn((x + 0.5) / w, (y + 0.5) / h);
      const i = (y * w + x) * 4;
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  return d;
}
const FACE: Rect = { x: 0.4, y: 0.25, w: 0.2, h: 0.35 };
const inFace = (x: number, y: number) => x >= FACE.x && x < FACE.x + FACE.w && y >= FACE.y && y < FACE.y + FACE.h;
const target = (natural = lookById("natural")) => (s: FrameStats) => autoTarget(s, natural);

describe("colour helpers", () => {
  it("sRGB round trips", () => {
    for (const v of [0, 0.01, 0.2, 0.5, 0.9, 1]) expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 5);
  });
  it("wb gains keep luminance and invertWb neutralises an illuminant", () => {
    const [r, g, b] = wbGains(0.4, -0.2);
    expect(0.2126 * r + 0.7152 * g + 0.0722 * b).toBeCloseTo(1, 6);
    const illum: [number, number, number] = [0.6, 0.5, 0.3]; // warm light
    const { temperature, tint } = invertWb(illum);
    expect(temperature).toBeLessThan(0); // cool it down
    const k = wbGains(temperature, tint);
    const out = illum.map((v, i) => v * k[i]);
    expect(out[0] / out[1]).toBeCloseTo(1, 5);
    expect(out[2] / out[1]).toBeCloseTo(1, 5);
  });
  it("tone curve is identity at zero and keeps black and white", () => {
    for (const L of [0, 0.25, 0.5, 0.75, 1]) expect(toneCurve(L, 0, 0, 0)).toBeCloseTo(L, 6);
    expect(toneCurve(0, 1, 1, 1)).toBe(0);
    expect(toneCurve(1, 1, 1, 1)).toBe(1);
    expect(toneCurve(0.2, 0.5, 0, 0)).toBeGreaterThan(0.2);
    expect(toneCurve(0.8, 0, -1, 0)).toBeLessThan(0.8);
    expect(toneCurve(0.2, 0, 0, 1)).toBeLessThan(0.2);
  });
  it("shoulder never exceeds 1 and is continuous at the knee", () => {
    expect(shoulder(0.5, 0)).toBe(0.5);
    expect(shoulder(10, 1)).toBeLessThanOrEqual(1);
    expect(shoulder(0.8 + 1e-6, 0)).toBeCloseTo(0.8, 4);
  });
});

describe("looks", () => {
  it("natural is close to identity, B&W has no colour", () => {
    const n = applyLook([0.6, 0.4, 0.3], lookById("natural"));
    expect(Math.abs(n[0] - 0.6)).toBeLessThan(0.05);
    const m = applyLook([0.8, 0.3, 0.1], lookById("bw"));
    expect(m[0]).toBeCloseTo(m[1], 6);
    expect(m[1]).toBeCloseTo(m[2], 6);
  });
  it("warm studio warms a grey", () => {
    const w = applyLook([0.5, 0.5, 0.5], lookById("warm"));
    expect(w[0]).toBeGreaterThan(w[2]);
  });
  it("generates a full LUT for every look", () => {
    for (const l of LOOKS) {
      const lut = generateLut(l, 17);
      expect(lut.length).toBe(17 ** 3 * 3);
    }
    // natural LUT: corner black stays near black, white near white
    const lut = generateLut(lookById("natural"), 9);
    expect(lut[0]).toBeLessThan(5);
    expect(lut[lut.length - 1]).toBeGreaterThan(250);
  });
});

describe("measurement", () => {
  it("finds a dark face in front of a bright window", () => {
    const d = frame(64, 36, (x, y) => (inFace(x, y) ? [50, 40, 35] : [245, 245, 245]));
    const s = measureFrame(d, 64, 36, FACE);
    expect(s.hasFace).toBe(true);
    expect(s.faceLuma!).toBeLessThan(0.2);
    expect(s.bgLuma).toBeGreaterThan(0.9);
    const rep = assessLighting(s, true);
    expect(rep.tip).toMatch(/Backlit|dark/);
    expect(rep.level).not.toBe("good");
  });
  it("uses centre weighting without a face", () => {
    const d = frame(64, 36, (x, y) => (Math.abs(x - 0.5) < 0.2 && Math.abs(y - 0.45) < 0.25 ? [200, 200, 200] : [20, 20, 20]));
    const s = measureFrame(d, 64, 36, null);
    expect(s.hasFace).toBe(false);
    expect(s.meanLuma).toBeGreaterThan(0.35); // a plain mean would be about 0.22
  });
  it("histogram counts every pixel", () => {
    const d = frame(10, 10, () => [128, 128, 128]);
    const h = histogram(d, 10, 10);
    expect(h.l.reduce((a, b) => a + b, 0)).toBe(100);
  });
  it("well lit neutral scene scores good", () => {
    const d = frame(64, 36, (x, y) => (inFace(x, y) ? [190, 150, 130] : [128, 128, 128]));
    const s = measureFrame(d, 64, 36, FACE);
    const rep = assessLighting(s, true);
    expect(rep.level).toBe("good");
    expect(rep.tip).toBe("Lighting looks good");
  });
  it("flags one side of the face in shadow", () => {
    const d = frame(64, 36, (x, y) => (inFace(x, y) ? (x < 0.5 ? [190, 150, 130] : [45, 35, 30]) : [120, 120, 120]));
    const rep = assessLighting(measureFrame(d, 64, 36, FACE), true);
    expect(rep.score).toBeLessThan(100);
  });
});

describe("auto lighting", () => {
  it("brightens a dark face and darkens a bright one", () => {
    const dark = measureFrame(frame(64, 36, (x, y) => (inFace(x, y) ? [60, 50, 45] : [60, 60, 60])), 64, 36, FACE);
    const bright = measureFrame(frame(64, 36, (x, y) => (inFace(x, y) ? [235, 225, 220] : [120, 120, 120])), 64, 36, FACE);
    expect(target()(dark).exposure).toBeGreaterThan(0.8);
    expect(target()(bright).exposure).toBeLessThan(-0.3);
  });
  it("corrects a warm cast toward neutral", () => {
    const s = measureFrame(frame(64, 36, () => [200, 160, 110]), 64, 36, null);
    const t = autoTarget(s, lookById("bw")); // bw has no warmth bias
    expect(t.temperature).toBeLessThan(-0.2);
  });
  it("hysteresis: small jitter never moves the goal", () => {
    let st = initialAutoState();
    const base: AutoValues = { exposure: 0.5, shadows: 0.1, highlights: 0, temperature: 0.1, tint: 0 };
    st = updateAutoGoal(st, base);
    const g0 = { ...st.goal };
    for (let i = 0; i < 50; i++) {
      const j = (i % 2 ? 1 : -1) * 0.05;
      st = updateAutoGoal(st, { ...base, exposure: base.exposure + j, temperature: base.temperature + j * 0.5 });
    }
    expect(st.goal).toEqual(g0);
  });
  it("hysteresis: a real change is followed and then settles", () => {
    let st = initialAutoState();
    const base: AutoValues = { exposure: 0, shadows: 0, highlights: 0, temperature: 0, tint: 0 };
    st = updateAutoGoal(st, base);
    for (let i = 0; i < 30; i++) st = updateAutoGoal(st, { ...base, exposure: 1 });
    expect(st.goal.exposure).toBeGreaterThan(0.95);
    expect(st.moving.exposure).toBe(false);
  });
  it("easing is slew limited and converges", () => {
    expect(approach(0, 10, 16, 900, 1.2)).toBeCloseTo((1.2 * 16) / 1000, 6);
    let cur: AutoValues = { exposure: 0, shadows: 0, highlights: 0, temperature: 0, tint: 0 };
    const goal: AutoValues = { exposure: 1, shadows: 0.3, highlights: -0.2, temperature: 0.2, tint: -0.1 };
    for (let i = 0; i < 60 * 15; i++) cur = easeAuto(cur, goal, 16.7);
    for (const k of AUTO_KEYS) expect(cur[k]).toBeCloseTo(goal[k], 2);
  });
  it("manual keys override auto values", () => {
    const auto: AutoValues = { exposure: 1, shadows: 0.2, highlights: -0.1, temperature: 0.3, tint: 0 };
    const keys = { exposure: true, shadows: false, highlights: true, temperature: true, tint: true };
    const e = effectiveAdjust({ ...NEUTRAL, shadows: -0.5 }, auto, true, keys);
    expect(e.exposure).toBe(1);
    expect(e.shadows).toBe(-0.5);
    expect(effectiveAdjust(NEUTRAL, auto, false, keys).exposure).toBe(0);
  });
});

describe("framing", () => {
  it("crop stays inside the frame", () => {
    const c = cropFor(2, 0.95, 0.05);
    expect(c.x + c.w).toBeLessThanOrEqual(1);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(cropFor(1, 0.3, 0.3)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
  it("auto-frame ignores tiny moves and follows big ones slowly", () => {
    let st = initialFrameState();
    const near: Rect = { x: 0.48, y: 0.37, w: 0.06, h: 0.1 }; // wants (0.51, 0.50)
    for (let i = 0; i < 30; i++) st = autoFrameStep(st, near, 1.5, 16);
    expect(st.goalX).toBe(0.5);
    const far: Rect = { x: 0.7, y: 0.3, w: 0.1, h: 0.15 };
    st = autoFrameStep(st, far, 1.5, 16);
    expect(st.goalX).toBeCloseTo(0.75, 5);
    expect(st.cx).toBeLessThan(0.51); // glides, never jumps
    for (let i = 0; i < 60 * 10; i++) st = autoFrameStep(st, far, 1.5, 16);
    expect(st.cx).toBeCloseTo(0.75, 2);
  });
});

describe("options and fit", () => {
  it("resolutions follow device caps", () => {
    expect(resolutionOptions(1920, 1080)[0]).toBe("1920x1080");
    expect(resolutionOptions()[0]).toBe("3840x2160");
    expect(fpsOptions(30)).toEqual([30]);
    expect(fpsOptions(60)).toEqual([30, 60]);
  });
  it("cover fit crops the long side", () => {
    const f = coverFit(2, 16 / 9);
    expect(f.sy).toBe(1);
    expect(f.sx).toBeLessThan(1);
    expect(f.ox).toBeCloseTo((1 - f.sx) / 2, 6);
  });
  it("segmentation slows down when it is expensive", () => {
    expect(segmentationInterval(5)).toBeLessThan(segmentationInterval(30));
  });
});
