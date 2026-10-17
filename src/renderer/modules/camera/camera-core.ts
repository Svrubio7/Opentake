// Pure camera math: no DOM, no WebGL. Measurement, auto lighting control, looks (3D LUTs),
// framing and resolution helpers. The shader in gl.ts mirrors toneCurve/wbGains exactly.
import { t } from "../../../shared/i18n";

/* ------------------------------------------------------------------ adjustments */

export interface Adjust {
  /** stops, -2..2 */
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  /** -1 cool .. 1 warm */
  temperature: number;
  /** -1 green .. 1 magenta */
  tint: number;
  saturation: number;
  vibrance: number;
  sharpen: number;
  vignette: number;
  smoothing: number;
}
export type AdjustKey = keyof Adjust;

export const AUTO_KEYS = ["exposure", "shadows", "highlights", "temperature", "tint"] as const;
export type AutoKey = (typeof AUTO_KEYS)[number];
export type AutoValues = Pick<Adjust, AutoKey>;

export const NEUTRAL: Adjust = {
  exposure: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0,
  saturation: 0, vibrance: 0, sharpen: 0.25, vignette: 0, smoothing: 0,
};

// each label is read in the current language when it is shown (the app switches language live)
export const ADJUST_META: Record<AdjustKey, { readonly label: string; min: number; max: number; step: number }> = {
  exposure: { get label() { return t("camera.adjust.exposure"); }, min: -2, max: 2, step: 0.01 },
  shadows: { get label() { return t("camera.adjust.shadows"); }, min: -1, max: 1, step: 0.01 },
  highlights: { get label() { return t("camera.adjust.highlights"); }, min: -1, max: 1, step: 0.01 },
  temperature: { get label() { return t("camera.adjust.temperature"); }, min: -1, max: 1, step: 0.01 },
  tint: { get label() { return t("camera.adjust.tint"); }, min: -1, max: 1, step: 0.01 },
  contrast: { get label() { return t("camera.adjust.contrast"); }, min: -1, max: 1, step: 0.01 },
  saturation: { get label() { return t("camera.adjust.saturation"); }, min: -1, max: 1, step: 0.01 },
  vibrance: { get label() { return t("camera.adjust.vibrance"); }, min: -1, max: 1, step: 0.01 },
  sharpen: { get label() { return t("camera.adjust.sharpen"); }, min: 0, max: 1, step: 0.01 },
  smoothing: { get label() { return t("camera.adjust.smoothing"); }, min: 0, max: 1, step: 0.01 },
  vignette: { get label() { return t("camera.adjust.vignette"); }, min: 0, max: 1, step: 0.01 },
};

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Manual values, with the auto-driven keys replaced by the live auto values. */
export function effectiveAdjust(manual: Adjust, auto: AutoValues, autoOn: boolean, autoKeys: Record<AutoKey, boolean>): Adjust {
  const out = { ...manual };
  if (!autoOn) return out;
  for (const k of AUTO_KEYS) if (autoKeys[k]) out[k] = auto[k];
  return out;
}

/* ------------------------------------------------------------------ colour helpers */

export function srgbToLinear(x: number) {
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(x: number) {
  if (x <= 0) return 0;
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}
export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * White balance gains (linear light) for a temperature/tint pair, normalised to keep luminance.
 * In log2: r = +0.5 t, b = -0.5 t, g = -0.4 tint. invertWb() is its exact inverse.
 */
export function wbGains(temperature: number, tint: number): [number, number, number] {
  const r = Math.pow(2, 0.5 * temperature);
  const b = Math.pow(2, -0.5 * temperature);
  const g = Math.pow(2, -0.4 * tint);
  const y = luma(r, g, b);
  return [r / y, g / y, b / y];
}

/** temperature/tint that turn an illuminant estimate (linear rgb) into neutral grey. */
export function invertWb(illum: [number, number, number]): { temperature: number; tint: number } {
  const [r, g, b] = illum.map((v) => Math.max(v, 1e-5));
  const A = Math.log2(g / r); // desired log2(gainR/gainG)
  const B = Math.log2(g / b); // desired log2(gainB/gainG)
  return { temperature: A - B, tint: (A + B) / 0.8 };
}

/** Gamma-domain tone curve on luma. Mirrored in the fragment shader (toneCurve). */
export function toneCurve(L: number, shadows: number, highlights: number, contrast: number) {
  const ws = L * (1 - L) * (1 - L) * 4; // peaks near 1/3, zero at black and white
  const wh = L * L * (1 - L) * 6.75; // peaks near 2/3
  let y = L + shadows * 0.4 * ws + highlights * 0.15 * wh;
  y = clamp(y, 0, 1);
  if (contrast >= 0) y = lerp(y, y * y * (3 - 2 * y), contrast);
  else y = lerp(y, 0.5 + (y - 0.5) * 0.5, -contrast);
  return clamp(y, 0, 1);
}

/** Linear-light soft shoulder: values above the knee roll off to 1 instead of clipping. */
export function shoulder(x: number, recovery: number) {
  const k = 0.8 - 0.3 * clamp(recovery, 0, 1);
  if (x <= k) return x;
  return k + (1 - k) * (1 - Math.exp(-(x - k) / (1 - k)));
}

/* ------------------------------------------------------------------ looks */

export type LookId = "natural" | "warm" | "cool" | "cinematic" | "bright" | "bw";

export interface LookDef {
  id: LookId;
  readonly label: string;
  /** what Auto steers toward */
  target: { faceLuma: number; warmth: number; tint: number; shadowFloor: number };
  /** creative grade baked into the 3D LUT */
  grade: {
    gain: [number, number, number];
    shadowTint: [number, number, number];
    highTint: [number, number, number];
    gamma: number;
    contrast: number;
    saturation: number;
    fade: number;
    mono: boolean;
  };
}

const g0 = { gain: [1, 1, 1] as [number, number, number], shadowTint: [0, 0, 0] as [number, number, number], highTint: [0, 0, 0] as [number, number, number], gamma: 1, contrast: 0, saturation: 1, fade: 0, mono: false };

export const LOOKS: LookDef[] = [
  { id: "natural", get label() { return t("camera.look.natural"); }, target: { faceLuma: 0.56, warmth: 0.03, tint: 0, shadowFloor: 0.06 }, grade: { ...g0, contrast: 0.06 } },
  { id: "warm", get label() { return t("camera.look.warm"); }, target: { faceLuma: 0.57, warmth: 0.14, tint: 0.02, shadowFloor: 0.07 },
    grade: { ...g0, gain: [1.03, 1.0, 0.95], highTint: [0.03, 0.015, -0.02], gamma: 0.97, contrast: 0.08, saturation: 1.05 } },
  { id: "cool", get label() { return t("camera.look.cool"); }, target: { faceLuma: 0.55, warmth: -0.08, tint: 0, shadowFloor: 0.05 },
    grade: { ...g0, gain: [0.98, 1.0, 1.03], shadowTint: [-0.03, 0.01, 0.04], contrast: 0.14, saturation: 0.94 } },
  { id: "cinematic", get label() { return t("camera.look.cinematic"); }, target: { faceLuma: 0.5, warmth: 0.04, tint: 0, shadowFloor: 0.04 },
    grade: { ...g0, shadowTint: [-0.04, 0.015, 0.05], highTint: [0.05, 0.015, -0.04], contrast: 0.2, saturation: 0.9, fade: 0.03 } },
  { id: "bright", get label() { return t("camera.look.bright"); }, target: { faceLuma: 0.62, warmth: 0.02, tint: 0, shadowFloor: 0.1 },
    grade: { ...g0, gamma: 0.9, contrast: 0.04, saturation: 1.04, highTint: [0.01, 0.01, 0.01] } },
  { id: "bw", get label() { return t("camera.look.bw"); }, target: { faceLuma: 0.54, warmth: 0, tint: 0, shadowFloor: 0.05 },
    grade: { ...g0, contrast: 0.18, mono: true } },
];

export const lookById = (id: LookId) => LOOKS.find((l) => l.id === id) ?? LOOKS[0];

/** The look's creative transform on one gamma-encoded pixel. */
export function applyLook(rgb: [number, number, number], look: LookDef): [number, number, number] {
  const gr = look.grade;
  let [r, g, b] = rgb;
  r *= gr.gain[0]; g *= gr.gain[1]; b *= gr.gain[2];
  const L0 = clamp(luma(r, g, b), 0, 1);
  const ws = (1 - L0) * (1 - L0);
  const wh = L0 * L0;
  r += gr.shadowTint[0] * ws + gr.highTint[0] * wh;
  g += gr.shadowTint[1] * ws + gr.highTint[1] * wh;
  b += gr.shadowTint[2] * ws + gr.highTint[2] * wh;
  let c = [r, g, b].map((v) => Math.pow(clamp(v, 0, 1), gr.gamma));
  c = c.map((v) => lerp(v, v * v * (3 - 2 * v), gr.contrast));
  const L = luma(c[0], c[1], c[2]);
  const sat = gr.mono ? 0 : gr.saturation;
  c = c.map((v) => L + (v - L) * sat);
  c = c.map((v) => clamp(gr.fade + v * (1 - gr.fade), 0, 1));
  return [c[0], c[1], c[2]];
}

/** RGB8 3D LUT, red fastest, then green, then blue (texImage3D width=r, height=g, depth=b). */
export function generateLut(look: LookDef, size = 33): Uint8Array {
  const out = new Uint8Array(size * size * size * 3);
  let i = 0;
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const c = applyLook([r / (size - 1), g / (size - 1), b / (size - 1)], look);
        out[i++] = Math.round(c[0] * 255);
        out[i++] = Math.round(c[1] * 255);
        out[i++] = Math.round(c[2] * 255);
      }
  return out;
}

/* ------------------------------------------------------------------ measurement */

/** Normalised rectangle in the source frame, 0..1. */
export interface Rect { x: number; y: number; w: number; h: number }

export interface FrameStats {
  /** face luma if a face is known, else centre-weighted (gamma, 0..1) */
  meanLuma: number;
  faceLuma: number | null;
  faceLeft: number | null;
  faceRight: number | null;
  /** luma of everything outside the (expanded) face, or the outer ring */
  bgLuma: number;
  bgClip: number;
  faceClip: number;
  p5: number;
  p50: number;
  p95: number;
  clipHigh: number;
  clipLow: number;
  /** linear rgb average of near-neutral pixels, null when too few */
  neutral: [number, number, number] | null;
  /** linear rgb average of all mid-tone pixels */
  grey: [number, number, number];
  hasFace: boolean;
}

export const HIST_BINS = 64;
export interface Histogram { l: number[]; r: number[]; g: number[]; b: number[] }

export function histogram(data: Uint8ClampedArray | Uint8Array, w: number, h: number, bins = HIST_BINS): Histogram {
  const l = new Array(bins).fill(0), r = new Array(bins).fill(0), g = new Array(bins).fill(0), b = new Array(bins).fill(0);
  const s = bins / 256;
  for (let i = 0, n = w * h * 4; i < n; i += 4) {
    const R = data[i], G = data[i + 1], B = data[i + 2];
    r[(R * s) | 0]++; g[(G * s) | 0]++; b[(B * s) | 0]++;
    l[(luma(R, G, B) * s) | 0]++;
  }
  return { l, r, g, b };
}

const inside = (x: number, y: number, r: Rect) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export function expandRect(r: Rect, k: number): Rect {
  const w = r.w * k, h = r.h * k;
  return { x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
}

/** Measures one downscaled RGBA frame. `face` is in normalised source coordinates. */
export function measureFrame(data: Uint8ClampedArray | Uint8Array, w: number, h: number, face: Rect | null): FrameStats {
  const lumaHist = new Array(256).fill(0);
  const core = face ? expandRect(face, 0.7) : null; // skip hair, ears and background
  const outer = face ? expandRect(face, 1.6) : null;
  let wSum = 0, wL = 0;
  let fN = 0, fL = 0, fClip = 0, lN = 0, lL = 0, rN = 0, rL = 0;
  let bN = 0, bL = 0, bClip = 0;
  let nN = 0, nR = 0, nG = 0, nB = 0, gN = 0, gR = 0, gG = 0, gB = 0;
  let total = 0, hi = 0, lo = 0;
  for (let y = 0; y < h; y++) {
    const ny = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const nx = (x + 0.5) / w;
      const i = (y * w + x) * 4;
      const R = data[i] / 255, G = data[i + 1] / 255, B = data[i + 2] / 255;
      const L = luma(R, G, B);
      lumaHist[Math.min(255, (L * 255) | 0)]++;
      total++;
      if (L > 0.97) hi++;
      if (L < 0.03) lo++;
      // centre weighting (portrait framing: the subject sits a bit above centre)
      const dx = (nx - 0.5) / 0.3, dy = (ny - 0.45) / 0.35;
      const cw = Math.exp(-(dx * dx + dy * dy));
      wSum += cw; wL += cw * L;
      if (core && inside(nx, ny, core)) {
        fN++; fL += L; if (L > 0.96) fClip++;
        if (nx < core.x + core.w / 2) { lN++; lL += L; } else { rN++; rL += L; }
      }
      const isBg = outer ? !inside(nx, ny, outer) : cw < 0.15;
      if (isBg) { bN++; bL += L; if (L > 0.96) bClip++; }
      // white balance sources, linear light, ignoring clipped and near-black pixels
      if (L > 0.08 && L < 0.92 && Math.max(R, G, B) < 0.98) {
        const lr = srgbToLinear(R), lg = srgbToLinear(G), lb = srgbToLinear(B);
        gN++; gR += lr; gG += lg; gB += lb;
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        if ((mx - mn) / Math.max(mx, 1e-3) < 0.18) { nN++; nR += lr; nG += lg; nB += lb; }
      }
    }
  }
  const pct = (p: number) => {
    const target = p * total;
    let acc = 0;
    for (let i = 0; i < 256; i++) { acc += lumaHist[i]; if (acc >= target) return i / 255; }
    return 1;
  };
  const faceOk = fN > 8;
  const faceLuma = faceOk ? fL / fN : null;
  const centre = wSum > 0 ? wL / wSum : 0.5;
  return {
    meanLuma: faceLuma ?? centre,
    faceLuma,
    faceLeft: faceOk && lN > 0 ? lL / lN : null,
    faceRight: faceOk && rN > 0 ? rL / rN : null,
    bgLuma: bN > 0 ? bL / bN : centre,
    bgClip: bN > 0 ? bClip / bN : 0,
    faceClip: faceOk ? fClip / fN : 0,
    p5: pct(0.05),
    p50: pct(0.5),
    p95: pct(0.95),
    clipHigh: total ? hi / total : 0,
    clipLow: total ? lo / total : 0,
    neutral: nN > total * 0.04 && nN > 20 ? [nR / nN, nG / nN, nB / nN] : null,
    grey: gN > 0 ? [gR / gN, gG / gN, gB / gN] : [1, 1, 1],
    hasFace: faceOk,
  };
}

/* ------------------------------------------------------------------ auto lighting */

/** stops between two gamma luma values (positive when `a` is brighter) */
export const stopsBetween = (a: number, b: number) => Math.log2(Math.max(srgbToLinear(a), 1e-4) / Math.max(srgbToLinear(b), 1e-4));

/** Where Auto wants the controls for this frame (open loop: measured on the RAW camera frame). */
export function autoTarget(s: FrameStats, look: LookDef): AutoValues {
  const t = look.target;
  const metered = Math.max(s.meanLuma, 0.01);
  let exposure = Math.log2(srgbToLinear(t.faceLuma) / srgbToLinear(metered));
  if (!s.hasFace) exposure *= 0.8; // centre-weighting is a guess: correct a little less
  exposure = clamp(exposure, -1.5, 2);
  const gain = Math.pow(2, exposure);

  // highlights: recover what the exposure push (or a bright window) would clip
  const p95After = srgbToLinear(s.p95) * gain;
  let highlights = 0;
  if (p95After > 0.9) highlights -= clamp(Math.log2(p95After / 0.9) * 0.7, 0, 0.8);
  if (s.hasFace && s.bgClip > 0.1) highlights -= clamp((s.bgClip - 0.1) * 2, 0, 0.4);
  highlights = clamp(highlights, -1, 0);

  // shadows: lift until the darkest 5% reaches the look's floor
  const p5After = linearToSrgb(srgbToLinear(s.p5) * gain);
  const shadows = clamp((t.shadowFloor - p5After) * 3, 0, 0.6);

  // white balance: grey of near-neutral pixels, else a gentler grey world
  let temperature = 0, tint = 0;
  const src = s.neutral ?? s.grey;
  const strength = s.neutral ? 0.75 : 0.45;
  const wb = invertWb(src);
  temperature = clamp(wb.temperature * strength, -0.8, 0.8) + t.warmth;
  tint = clamp(wb.tint * strength, -0.6, 0.6) + t.tint;
  return { exposure, highlights, shadows, temperature: clamp(temperature, -1, 1), tint: clamp(tint, -1, 1) };
}

/** How far a target must move before Auto follows (hysteresis against flicker). */
export const DEADBAND: AutoValues = { exposure: 0.15, shadows: 0.05, highlights: 0.06, temperature: 0.05, tint: 0.05 };
/** Per-second slew limits and time constants for the per-frame easing. */
export const SLEW: Record<AutoKey, { tauMs: number; maxPerSec: number }> = {
  exposure: { tauMs: 900, maxPerSec: 1.2 },
  shadows: { tauMs: 1200, maxPerSec: 0.5 },
  highlights: { tauMs: 1200, maxPerSec: 0.6 },
  temperature: { tauMs: 1500, maxPerSec: 0.4 },
  tint: { tauMs: 1500, maxPerSec: 0.4 },
};

export interface AutoState {
  /** smoothed measurement target */
  filtered: AutoValues | null;
  /** what the per-frame easing heads toward */
  goal: AutoValues;
  moving: Record<AutoKey, boolean>;
}

export function initialAutoState(): AutoState {
  return {
    filtered: null,
    goal: { exposure: 0, shadows: 0, highlights: 0, temperature: 0, tint: 0 },
    moving: { exposure: false, shadows: false, highlights: false, temperature: false, tint: false },
  };
}

/**
 * Feeds one measurement (about every 300 ms). The goal only moves once the smoothed target leaves
 * the deadband, then tracks it until it has settled to a quarter of the deadband.
 * The first measurement jumps straight to the target so the picture is right at once.
 */
export function updateAutoGoal(state: AutoState, target: AutoValues, alpha = 0.35): AutoState {
  if (!state.filtered) {
    return { filtered: { ...target }, goal: { ...target }, moving: { ...state.moving } };
  }
  const filtered = { ...state.filtered };
  const goal = { ...state.goal };
  const moving = { ...state.moving };
  for (const k of AUTO_KEYS) {
    filtered[k] = lerp(filtered[k], target[k], alpha);
    const diff = Math.abs(filtered[k] - goal[k]);
    if (moving[k]) {
      goal[k] = filtered[k];
      if (Math.abs(target[k] - filtered[k]) < DEADBAND[k] * 0.25) moving[k] = false;
    } else if (diff > DEADBAND[k]) {
      moving[k] = true;
      goal[k] = filtered[k];
    }
  }
  return { filtered, goal, moving };
}

/** Exponential approach with a slew limit; per frame. */
export function approach(current: number, goal: number, dtMs: number, tauMs: number, maxPerSec: number) {
  const k = 1 - Math.exp(-Math.max(dtMs, 0) / tauMs);
  const maxStep = (maxPerSec * dtMs) / 1000;
  return current + clamp((goal - current) * k, -maxStep, maxStep);
}

export function easeAuto(current: AutoValues, goal: AutoValues, dtMs: number): AutoValues {
  const out = { ...current };
  for (const k of AUTO_KEYS) out[k] = approach(current[k], goal[k], dtMs, SLEW[k].tauMs, SLEW[k].maxPerSec);
  return out;
}

/* ------------------------------------------------------------------ lighting score */

export interface LightingReport { score: number; level: "good" | "ok" | "poor"; tip: string }

/** Judges the light in the room (raw frame), not the corrected picture: correction cannot add detail. */
export function assessLighting(s: FrameStats, faceExpected: boolean): LightingReport {
  const tips: { p: number; tip: string }[] = [];
  let score = 100;
  const f = s.meanLuma;
  if (f < 0.32) {
    const pen = ((0.32 - f) / 0.32) * 55;
    score -= pen;
    tips.push({ p: pen + (f < 0.2 ? 40 : 0), tip: f < 0.2 ? t("camera.tip.tooDark") : t("camera.tip.dim") });
  }
  if (s.hasFace && s.faceClip > 0.04) {
    const pen = clamp(s.faceClip * 300, 0, 35);
    score -= pen;
    tips.push({ p: pen + 10, tip: t("camera.tip.faceBright") });
  } else if (f > 0.8) {
    score -= 20;
    tips.push({ p: 20, tip: t("camera.tip.veryBright") });
  }
  const backlight = stopsBetween(s.bgLuma, f);
  if ((s.hasFace || !faceExpected) && (backlight > 1.1 || (s.bgClip > 0.15 && s.faceClip < 0.02))) {
    const pen = clamp((backlight - 1.1) * 25 + s.bgClip * 40, 8, 40);
    score -= pen;
    tips.push({ p: pen + 15, tip: t("camera.tip.backlit") });
  }
  if (s.faceLeft != null && s.faceRight != null) {
    const uneven = Math.abs(stopsBetween(s.faceLeft, s.faceRight));
    if (uneven > 0.9) {
      const pen = clamp((uneven - 0.9) * 20, 4, 20);
      score -= pen;
      tips.push({ p: pen, tip: t("camera.tip.uneven") });
    }
  }
  const wb = invertWb(s.neutral ?? s.grey);
  const cast = Math.abs(wb.temperature) + Math.abs(wb.tint) * 0.6;
  if (cast > 0.7) {
    const pen = clamp((cast - 0.7) * 20, 3, 15);
    score -= pen;
    tips.push({ p: pen, tip: t("camera.tip.cast") });
  }
  if (faceExpected && !s.hasFace) {
    score -= 10;
    tips.push({ p: 12, tip: t("camera.tip.noFace") });
  }
  score = Math.round(clamp(score, 0, 100));
  tips.sort((a, b) => b.p - a.p);
  const level = score >= 80 ? "good" : score >= 55 ? "ok" : "poor";
  return { score, level, tip: tips[0]?.tip ?? t("camera.tip.good") };
}

/* ------------------------------------------------------------------ framing */

/** Crop in normalised source coordinates for a zoom (1 = full frame) centred near (cx, cy). */
export function cropFor(zoom: number, cx: number, cy: number): Rect {
  const z = Math.max(1, zoom);
  const w = 1 / z, h = 1 / z;
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h };
}

export interface FrameState { cx: number; cy: number; goalX: number; goalY: number; moving: boolean }
export const initialFrameState = (): FrameState => ({ cx: 0.5, cy: 0.5, goalX: 0.5, goalY: 0.5, moving: false });

/** Smallest zoom auto-frame uses, so there is room to follow you. */
export const AUTO_FRAME_MIN_ZOOM = 1.25;

/**
 * Auto-frame: keeps the face centred horizontally with the eyes near the upper third.
 * A deadzone holds still while you move a little, then the crop glides (tau 1.6 s).
 */
export function autoFrameStep(st: FrameState, face: Rect | null, zoom: number, dtMs: number): FrameState {
  const z = Math.max(zoom, 1);
  let { goalX, goalY, moving } = st;
  if (face) {
    const tx = face.x + face.w / 2;
    const ty = face.y + face.h / 2 + 0.12 / z; // face centre sits above the crop centre
    const dead = 0.06 / z;
    const off = Math.max(Math.abs(tx - goalX), Math.abs(ty - goalY));
    if (moving || off > dead) { goalX = tx; goalY = ty; moving = off > dead * 0.2; }
  }
  const cx = approach(st.cx, goalX, dtMs, 1600, 0.25);
  const cy = approach(st.cy, goalY, dtMs, 1600, 0.25);
  return { cx, cy, goalX, goalY, moving };
}

/** Exponential smoothing of a face box between detections. */
export function smoothRect(prev: Rect | null, next: Rect, alpha = 0.4): Rect {
  if (!prev) return next;
  return { x: lerp(prev.x, next.x, alpha), y: lerp(prev.y, next.y, alpha), w: lerp(prev.w, next.w, alpha), h: lerp(prev.h, next.h, alpha) };
}

/* ------------------------------------------------------------------ resolution, fit */

export const RESOLUTIONS: [number, number][] = [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720], [960, 540], [640, 360]];
export const resKey = (w: number, h: number) => `${w}x${h}`;
export function parseRes(key: string): [number, number] | null {
  const m = /^(\d+)x(\d+)$/.exec(key);
  return m ? [Number(m[1]), Number(m[2])] : null;
}
export function resLabel(key: string) {
  const r = parseRes(key);
  if (!r) return key;
  const named: Record<number, string> = { 2160: "4K", 1440: "1440p", 1080: "1080p", 720: "720p", 540: "540p", 360: "360p" };
  return named[r[1]] ?? `${r[0]} x ${r[1]}`;
}

/** Standard 16:9 sizes the device can reach, highest first. Unknown caps: offer all. */
export function resolutionOptions(maxW?: number, maxH?: number): string[] {
  return RESOLUTIONS.filter(([w, h]) => (maxW == null || w <= maxW) && (maxH == null || h <= maxH)).map(([w, h]) => resKey(w, h));
}

/** Frame rates offered for a device max. */
export function fpsOptions(maxFps?: number): number[] {
  return [30, 60].filter((f) => maxFps == null || f <= Math.round(maxFps) + 1);
}

/** uv transform that makes an image of aspect `src` cover a frame of aspect `dst`. */
export function coverFit(src: number, dst: number): { sx: number; sy: number; ox: number; oy: number } {
  if (src > dst) { const sx = dst / src; return { sx, sy: 1, ox: (1 - sx) / 2, oy: 0 }; }
  const sy = src / dst;
  return { sx: 1, sy, ox: 0, oy: (1 - sy) / 2 };
}

/** Segmentation rate from how long one run takes, so the frame rate never pays for it. */
export function segmentationInterval(avgMs: number): number {
  if (avgMs < 8) return 33;
  if (avgMs < 14) return 50;
  if (avgMs < 22) return 80;
  return 120;
}
