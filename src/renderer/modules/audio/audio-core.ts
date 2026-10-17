// Voice chain settings, presets and the Mic check analysis. Pure functions, no DOM.
import { KWeighting, msToLufs, powerToDb } from "./dsp";
// relative, not @shared: vitest runs this file without the vite aliases
import { num, t } from "../../../shared/i18n";

// ---------------------------------------------------------------- settings

export type NsMode = "rnnoise" | "speex" | "off";
export type PresetId = "natural" | "podcast" | "broadcast" | "noisy";

export interface ChainSettings {
  preset: PresetId | "custom";
  inputGainDb: number;
  highpass: { on: boolean; freq: number };
  ns: { mode: NsMode; /** 0..1 wet amount; RNNoise has no strength knob, so strength is a dry/wet blend */ mix: number };
  gate: { on: boolean; thresholdDb: number; rangeDb: number; attackMs: number; holdMs: number; releaseMs: number };
  deesser: { on: boolean; freq: number; thresholdDb: number; ratio: number; maxReductionDb: number };
  eq: { on: boolean; lowFreq: number; lowGainDb: number; presenceFreq: number; presenceGainDb: number; presenceQ: number; airFreq: number; airGainDb: number };
  comp: { on: boolean; thresholdDb: number; ratio: number; kneeDb: number; attackMs: number; releaseMs: number; makeupDb: number };
  agc: { on: boolean; targetLufs: number; maxGainDb: number; minGainDb: number; speedDbPerSec: number };
  limiter: { on: boolean; ceilingDb: number; releaseMs: number };
}

/** Speech level (RMS of voiced frames, dBFS) the input gain aims for. Preset thresholds assume it. */
export const TARGET_SPEECH_DB = -20;

const BASE: ChainSettings = {
  preset: "natural",
  inputGainDb: 0,
  highpass: { on: true, freq: 80 },
  ns: { mode: "rnnoise", mix: 0.7 },
  gate: { on: true, thresholdDb: -55, rangeDb: 12, attackMs: 2, holdMs: 150, releaseMs: 120 },
  deesser: { on: true, freq: 6500, thresholdDb: -32, ratio: 4, maxReductionDb: 8 },
  eq: { on: true, lowFreq: 120, lowGainDb: 0, presenceFreq: 3500, presenceGainDb: 0, presenceQ: 1, airFreq: 10000, airGainDb: 0 },
  comp: { on: true, thresholdDb: -18, ratio: 2, kneeDb: 6, attackMs: 10, releaseMs: 150, makeupDb: 2 },
  agc: { on: true, targetLufs: -18, maxGainDb: 18, minGainDb: -12, speedDbPerSec: 1.5 },
  limiter: { on: true, ceilingDb: -1, releaseMs: 80 },
};

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A preset's name and its one-line hint, in the app's language. */
export const presetLabel = (id: PresetId) => t(`audio.preset.${id}`);
export const presetHint = (id: PresetId) => t(`audio.preset.${id}.hint`);

export const PRESETS: Record<PresetId, { settings: ChainSettings }> = {
  natural: { settings: clone(BASE) },
  podcast: {
    settings: {
      ...clone(BASE), preset: "podcast",
      ns: { mode: "rnnoise", mix: 0.9 },
      eq: { ...BASE.eq, lowGainDb: 1.5, presenceGainDb: 1.5, airGainDb: 2 },
      comp: { ...BASE.comp, thresholdDb: -22, ratio: 3, attackMs: 8, releaseMs: 120, makeupDb: 4 },
      agc: { ...BASE.agc, targetLufs: -16 },
    },
  },
  broadcast: {
    settings: {
      ...clone(BASE), preset: "broadcast",
      highpass: { on: true, freq: 90 },
      ns: { mode: "rnnoise", mix: 1 },
      gate: { ...BASE.gate, rangeDb: 18 },
      deesser: { ...BASE.deesser, thresholdDb: -34, maxReductionDb: 10 },
      eq: { ...BASE.eq, lowGainDb: 2, presenceGainDb: 2.5, airGainDb: 3 },
      comp: { ...BASE.comp, thresholdDb: -26, ratio: 4, kneeDb: 4, attackMs: 5, releaseMs: 100, makeupDb: 6 },
      agc: { ...BASE.agc, targetLufs: -16, speedDbPerSec: 2 },
    },
  },
  noisy: {
    settings: {
      ...clone(BASE), preset: "noisy",
      highpass: { on: true, freq: 100 },
      ns: { mode: "rnnoise", mix: 1 },
      gate: { ...BASE.gate, thresholdDb: -48, rangeDb: 20, releaseMs: 90 },
      eq: { ...BASE.eq, lowGainDb: -1.5, presenceGainDb: 1.5, airGainDb: 0 },
      comp: { ...BASE.comp, thresholdDb: -22, ratio: 3, makeupDb: 4 },
      agc: { ...BASE.agc, targetLufs: -16, maxGainDb: 12 },
    },
  },
};

/** A preset's chain, keeping the measured input gain and gate threshold the Mic check found. */
export function applyPreset(id: PresetId, current?: ChainSettings): ChainSettings {
  const next = clone(PRESETS[id].settings);
  if (current) {
    next.inputGainDb = current.inputGainDb;
    next.gate.thresholdDb = current.gate.thresholdDb;
    next.highpass.freq = Math.max(next.highpass.freq, current.highpass.freq);
  }
  return next;
}

export const defaultSettings = () => clone(BASE);

/** Accepts anything from storage and returns a complete, sane settings object. */
export function sanitizeSettings(raw: unknown): ChainSettings {
  const base = defaultSettings();
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const out = clone(base) as unknown as Record<string, unknown>;
  for (const key of Object.keys(base) as (keyof ChainSettings)[]) {
    const b = base[key], v = r[key];
    if (v === undefined) continue;
    if (typeof b === "object" && b && typeof v === "object" && v) {
      const merged: Record<string, unknown> = { ...(b as object) };
      for (const [k, bv] of Object.entries(b as object)) {
        const vv = (v as Record<string, unknown>)[k];
        if (typeof vv === typeof bv && (typeof vv !== "number" || Number.isFinite(vv))) merged[k] = vv;
      }
      out[key] = merged;
    } else if (typeof v === typeof b && (typeof v !== "number" || Number.isFinite(v))) out[key] = v;
  }
  const s = out as unknown as ChainSettings;
  if (!["rnnoise", "speex", "off"].includes(s.ns.mode)) s.ns.mode = "rnnoise";
  s.ns.mix = clamp(s.ns.mix, 0, 1);
  s.inputGainDb = clamp(s.inputGainDb, -24, 30);
  s.limiter.ceilingDb = clamp(s.limiter.ceilingDb, -12, -0.1);
  return s;
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------- measurement

export function peakDb(x: Float32Array) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p > 0 ? 20 * Math.log10(p) : -200;
}

/** Runs of 3+ consecutive samples at full scale: flat tops left by an overloaded converter. */
export function clippedRuns(x: Float32Array, level = 0.995) {
  let runs = 0, len = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) >= level) { len++; if (len === 3) runs++; } else len = 0;
  }
  return runs;
}

/** RMS level in dBFS of consecutive frames. */
export function frameLevels(x: Float32Array, sampleRate: number, frameMs = 50) {
  const n = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const out: number[] = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let k = i; k < i + n; k++) s += x[k] * x[k];
    out.push(powerToDb(s / n));
  }
  return out;
}

export function percentile(values: number[], p: number) {
  if (!values.length) return -200;
  const s = [...values].sort((a, b) => a - b);
  const idx = clamp((p / 100) * (s.length - 1), 0, s.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}

const meanPowerDb = (dbs: number[]) =>
  dbs.length ? powerToDb(dbs.reduce((s, d) => s + Math.pow(10, d / 10), 0) / dbs.length) : -200;

/** BS.1770-4 integrated loudness (mono): 400 ms blocks, 75% overlap, -70 LUFS absolute and -10 LU relative gates. */
export function integratedLoudness(x: Float32Array, sampleRate: number) {
  const k = new KWeighting(sampleRate);
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = k.process(x[i]);
  const block = Math.round(0.4 * sampleRate), hop = Math.round(0.1 * sampleRate);
  const ms: number[] = [];
  for (let i = 0; i + block <= y.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + block; j++) s += y[j] * y[j];
    ms.push(s / block);
  }
  const abs = ms.filter((m) => msToLufs(m) > -70);
  if (!abs.length) return -70;
  const rel = msToLufs(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((m) => msToLufs(m) > rel);
  return msToLufs(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** In-place iterative radix-2 FFT. `re` and `im` must have a power-of-two length. */
export function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

export interface Spectrum {
  /** One-sided power per bin, scaled so that summing bins gives the mean square of the signal. */
  power: Float64Array;
  binHz: number;
  frames: number;
}

/**
 * Welch averaged power spectrum with a Hann window. `keep(frameMeanSquare)` chooses which frames
 * count (speech only, for example). Summing `power` over all bins returns the signal's mean square.
 */
export function powerSpectrum(x: Float32Array, sampleRate: number, size = 2048, keep?: (ms: number) => boolean): Spectrum {
  const hop = size / 2;
  const win = new Float64Array(size);
  let wss = 0;
  for (let i = 0; i < size; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size); wss += win[i] * win[i]; }
  const power = new Float64Array(size / 2 + 1);
  const re = new Float64Array(size), im = new Float64Array(size);
  let frames = 0;
  for (let start = 0; start + size <= x.length; start += hop) {
    let ms = 0;
    for (let i = 0; i < size; i++) ms += x[start + i] * x[start + i];
    if (keep && !keep(ms / size)) continue;
    for (let i = 0; i < size; i++) { re[i] = x[start + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) {
      const p = (re[k] * re[k] + im[k] * im[k]) / (size * wss);
      power[k] += k === 0 || k === size / 2 ? p : 2 * p;
    }
    frames++;
  }
  if (frames) for (let k = 0; k < power.length; k++) power[k] /= frames;
  return { power, binHz: sampleRate / size, frames };
}

/** Total power in [lo, hi) Hz, in dB. */
export function bandDb(s: Spectrum, lo: number, hi: number) {
  let p = 0;
  for (let k = Math.ceil(lo / s.binHz); k * s.binHz < hi && k < s.power.length; k++) p += s.power[k];
  return powerToDb(p);
}

/** Mains hum: a line at 50 or 60 Hz (or its 2nd/3rd harmonic) standing well above its neighbours. */
export function detectHum(s: Spectrum): 50 | 60 | null {
  const at = (f: number) => s.power[Math.round(f / s.binHz)] ?? 0;
  const around = (f: number) => {
    const pts = [-12, -9, 9, 12].map((d) => at(f + d));
    return pts.reduce((a, b) => a + b, 0) / pts.length;
  };
  let best: { hz: 50 | 60; score: number } | null = null;
  for (const hz of [50, 60] as const) {
    const score = Math.max(...[1, 2, 3].map((h) => powerToDb(at(hz * h)) - powerToDb(around(hz * h))));
    if (score > 12 && (!best || score > best.score)) best = { hz, score };
  }
  return best?.hz ?? null;
}

// ---------------------------------------------------------------- Mic check

/**
 * Long-term average speech spectrum (Byrne et al. 1994, male and female averaged, approximate),
 * summed into our bands and expressed relative to the 500-2000 Hz band. A microphone and room that
 * are "neutral" land near these; the tolerances below are deliberately wide.
 */
export const VOICE_BANDS = {
  low: { lo: 100, hi: 250, ref: 0.3 },
  presence: { lo: 2000, hi: 5000, ref: -10.4 },
  sibilance: { lo: 5000, hi: 9000, ref: -16.2 },
  air: { lo: 10000, hi: 16000, ref: -21 },
} as const;
const MID = { lo: 500, hi: 2000 };

export interface MicMetrics {
  sampleRate: number;
  noiseFloorDb: number;
  speechDb: number;
  speechLufs: number;
  peakDb: number;
  clippedRuns: number;
  snrDb: number;
  voicedRatio: number;
  humHz: 50 | 60 | null;
  /** Each band's level relative to mid, minus the speech reference: positive = more than a typical voice. */
  balance: { low: number; presence: number; sibilance: number; air: number };
  /** Loud end (95th percentile) of the sibilance band's frame level, dBFS RMS. */
  sibilanceP95Db: number;
}

export interface Finding { tone: "good" | "info" | "warn"; text: string }

export interface MicCheckResult {
  ok: boolean;
  metrics: MicMetrics;
  findings: Finding[];
  settings: ChainSettings;
  /** Where the AGC should start so the first seconds already sit near the target. */
  agcStartGainDb: number;
}

export function measureMic(silence: Float32Array, speech: Float32Array, sampleRate: number): MicMetrics {
  const silentFrames = frameLevels(silence, sampleRate, 50);
  const speechFrames = frameLevels(speech, sampleRate, 50);
  // The median of the quiet take is robust to a cough; the quiet gaps of the reading are a second
  // opinion in case the person kept talking during the silence step.
  const noiseFloorDb = Math.min(percentile(silentFrames, 50), percentile(speechFrames, 10) + 3);
  const voicedGate = Math.max(noiseFloorDb + 10, -65);
  const voiced = speechFrames.filter((d) => d > voicedGate);
  const speechDb = meanPowerDb(voiced);
  const speechLufs = integratedLoudness(speech, sampleRate);
  const gateMs = Math.pow(10, voicedGate / 10);
  const spec = powerSpectrum(speech, sampleRate, 2048, (ms) => ms > gateMs);
  const mid = bandDb(spec, MID.lo, MID.hi);
  const rel = (b: { lo: number; hi: number; ref: number }) => round1(bandDb(spec, b.lo, b.hi) - mid - b.ref);
  const noiseSpec = powerSpectrum(silence, sampleRate, 16384);

  // Frame-by-frame level of the sibilance band, for the de-esser threshold.
  const sib: number[] = [];
  const size = 1024;
  const re = new Float64Array(size), im = new Float64Array(size);
  const binHz = sampleRate / size;
  for (let start = 0; start + size <= speech.length; start += size / 2) {
    for (let i = 0; i < size; i++) { re[i] = speech[start + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)); im[i] = 0; }
    fft(re, im);
    let p = 0;
    for (let k = Math.ceil(5000 / binHz); k * binHz < 9000 && k < size / 2; k++) p += 2 * (re[k] * re[k] + im[k] * im[k]);
    sib.push(powerToDb(p / (size * size * 0.375))); // 0.375 = mean of the Hann window squared
  }

  return {
    sampleRate,
    noiseFloorDb: round1(noiseFloorDb),
    speechDb: round1(speechDb),
    speechLufs: round1(speechLufs),
    peakDb: round1(peakDb(speech)),
    clippedRuns: clippedRuns(speech),
    snrDb: round1(speechDb - noiseFloorDb),
    voicedRatio: speechFrames.length ? voiced.length / speechFrames.length : 0,
    humHz: noiseFloorDb > -90 ? detectHum(noiseSpec) : null,
    balance: {
      low: rel(VOICE_BANDS.low), presence: rel(VOICE_BANDS.presence),
      sibilance: rel(VOICE_BANDS.sibilance), air: rel(VOICE_BANDS.air),
    },
    sibilanceP95Db: round1(percentile(sib, 95)),
  };
}

const signed = (db: number) => `${db > 0 ? "+" : ""}${Math.round(db)} dB`;

/** Turns measurements into a chain and plain-words findings. `base` supplies the preset's style. */
export function planFromMetrics(m: MicMetrics, base: ChainSettings): MicCheckResult {
  const s = clone(base);
  const findings: Finding[] = [];

  if (m.voicedRatio < 0.15 || m.snrDb < 6) {
    findings.push({ tone: "warn", text: t("audio.find.unclear") });
    return { ok: false, metrics: m, findings, settings: s, agcStartGainDb: 0 };
  }

  // Clipping comes first: no setting here can undo distortion that happened inside the mic.
  if (m.clippedRuns > 0 || m.peakDb > -0.3) {
    findings.push({ tone: "warn", text: t("audio.find.clipping") });
  }

  // Input gain: bring speech to the level every threshold assumes.
  const gain = clamp(Math.round(TARGET_SPEECH_DB - m.speechDb), -12, 24);
  s.inputGainDb = gain;
  if (gain >= 3) findings.push({ tone: "info", text: t(gain > 15 ? "audio.find.quietCloser" : "audio.find.quiet", { gain: signed(gain) }) });
  else if (gain <= -3) findings.push({ tone: "info", text: t("audio.find.loud", { gain: signed(gain) }) });
  else findings.push({ tone: "good", text: t("audio.find.levelRight") });

  const speechPost = m.speechDb + gain;
  const noisePost = m.noiseFloorDb + gain;

  // Noise suppression strength from signal to noise.
  if (m.snrDb >= 45) {
    s.ns = { mode: "rnnoise", mix: Math.min(s.ns.mix, 0.6) };
    findings.push({ tone: "good", text: t("audio.find.roomQuiet") });
  } else if (m.snrDb >= 30) {
    s.ns = { mode: "rnnoise", mix: Math.max(s.ns.mix, 0.85) };
    findings.push({ tone: "info", text: t("audio.find.roomSome") });
  } else {
    s.ns = { mode: "rnnoise", mix: 1 };
    findings.push({ tone: "warn", text: t("audio.find.roomNoisy") });
  }

  // Gate between what is left of the noise after suppression and the quiet end of speech.
  const residual = noisePost - 20 * s.ns.mix;
  s.gate.on = true;
  s.gate.thresholdDb = round1(clamp(residual + 0.35 * (speechPost - residual), Math.max(residual + 6, -75), speechPost - 15));
  s.gate.rangeDb = m.snrDb < 30 ? Math.max(s.gate.rangeDb, 18) : s.gate.rangeDb;

  // Hum.
  s.highpass.on = true;
  if (m.humHz) {
    s.highpass.freq = Math.max(s.highpass.freq, m.humHz * 2);
    findings.push({ tone: "warn", text: t("audio.find.hum", { hum: m.humHz, freq: s.highpass.freq }) });
  }

  // Tone.
  s.eq.on = true;
  const b = m.balance;
  if (b.low > 5) {
    const cut = clamp(b.low - 2, 2, 6);
    s.eq.lowGainDb = round1(Math.min(s.eq.lowGainDb, 0) - cut);
    findings.push({ tone: "info", text: t("audio.find.boomy", { gain: signed(-cut) }) });
  } else if (b.low < -8) {
    s.eq.lowGainDb = round1(Math.max(s.eq.lowGainDb, 0) + 2);
    findings.push({ tone: "info", text: t("audio.find.thin") });
  }
  if (b.presence > 4) {
    const cut = clamp(b.presence - 1, 1.5, 5);
    s.eq.presenceGainDb = round1(Math.min(s.eq.presenceGainDb, 0) - cut);
    findings.push({ tone: "info", text: t("audio.find.harsh", { gain: signed(-cut) }) });
  } else if (b.presence < -6) {
    const lift = clamp(-b.presence - 3, 1.5, 4);
    s.eq.presenceGainDb = round1(Math.max(s.eq.presenceGainDb, 0) + lift);
    findings.push({ tone: "info", text: t("audio.find.muffled", { gain: signed(lift) }) });
  }
  if (b.air < -8) {
    const lift = clamp(-b.air - 5, 1.5, m.snrDb >= 30 ? 4 : 2);
    s.eq.airGainDb = round1(Math.max(s.eq.airGainDb, 0) + lift);
    findings.push({ tone: "info", text: t("audio.find.air", { gain: signed(lift) }) });
  }

  // De-esser: set just under the loud end of the sibilance band, firmer when S sounds stick out.
  const sibilant = b.sibilance > 5;
  s.deesser.on = true;
  s.deesser.thresholdDb = round1(m.sibilanceP95Db + gain - (sibilant ? 8 : 4));
  if (sibilant) {
    s.deesser.maxReductionDb = Math.max(s.deesser.maxReductionDb, 10);
    findings.push({ tone: "info", text: t("audio.find.sibilant") });
  }

  // Loudness: the AGC starts where the measured speech would land, then tracks slowly.
  s.agc.on = true;
  const compEstimateDb = s.comp.on ? -2 + s.comp.makeupDb : 0;
  const agcStartGainDb = round1(clamp(s.agc.targetLufs - (m.speechLufs + gain + compEstimateDb), s.agc.minGainDb, s.agc.maxGainDb));
  findings.push({ tone: "good", text: t("audio.find.loudness", { target: num(s.agc.targetLufs) }) });

  if (s.preset !== "custom") s.preset = base.preset;
  return { ok: true, metrics: m, findings, settings: s, agcStartGainDb };
}

export function analyseMicCheck(silence: Float32Array, speech: Float32Array, sampleRate: number, base: ChainSettings) {
  return planFromMetrics(measureMic(silence, speech, sampleRate), base);
}

/** The line read out loud in the Mic check, in the app's language. */
export const micCheckSentence = () => t("audio.check.sentence");

// ---------------------------------------------------------------- feedback guard

/**
 * Speakers feeding back into the mic while Listen is on: the output sits near full scale and
 * stays there. Speech has gaps and the chain keeps it far below this; a howl does not stop.
 */
export const FEEDBACK = { rmsDb: -10, holdMs: 400 };

export interface FeedbackState { loudMs: number }
export const initialFeedback = (): FeedbackState => ({ loudMs: 0 });

/** One meter reading; `tripped` means mute the monitor now. */
export function feedbackStep(s: FeedbackState, rmsDb: number, dtMs: number): { state: FeedbackState; tripped: boolean } {
  const dt = Math.max(0, Math.min(dtMs, 100)); // readings come every few tens of ms; a gap is not loud time
  const loudMs = rmsDb >= FEEDBACK.rmsDb ? s.loudMs + dt : 0;
  return { state: { loudMs }, tripped: loudMs >= FEEDBACK.holdMs };
}
