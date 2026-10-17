import { describe, expect, it } from "vitest";
import {
  PRESETS, applyPreset, bandDb, feedbackStep, initialFeedback, clippedRuns, defaultSettings, detectHum, integratedLoudness, measureMic,
  peakDb, planFromMetrics, powerSpectrum, sanitizeSettings, type MicMetrics,
} from "./audio-core";
import { Agc, Biquad, Compressor, Deesser, Gate, Limiter, LoudnessMeter, VoiceChain, compressorGainDb, dbToGain, gainToDb } from "./dsp";

const FS = 48000;

/** Deterministic white noise with a given RMS in dBFS. */
function noise(seconds: number, rmsDb: number, seed = 1) {
  const n = Math.round(seconds * FS), out = new Float32Array(n);
  let s = seed >>> 0;
  const amp = dbToGain(rmsDb) * Math.sqrt(3); // uniform [-1,1] has RMS 1/sqrt(3)
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; out[i] = ((s / 2 ** 32) * 2 - 1) * amp; }
  return out;
}
function sine(seconds: number, hz: number, peak: number) {
  const n = Math.round(seconds * FS), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = peak * Math.sin((2 * Math.PI * hz * i) / FS);
  return out;
}
const rmsDb = (x: Float32Array, from = 0) => {
  let s = 0; for (let i = from; i < x.length; i++) s += x[i] * x[i];
  return gainToDb(Math.sqrt(s / (x.length - from)));
};
const run = (x: Float32Array, f: (v: number) => number) => x.map((v) => f(v));
const add = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0));

/** A voice-like test signal: a harmonic buzz at 140 Hz, syllables of ~200 ms with short gaps. */
function voice(seconds: number, rms: number, seed = 7) {
  const n = Math.round(seconds * FS), out = new Float32Array(n);
  const air = noise(seconds, -40, seed);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 30; h++) v += Math.sin((2 * Math.PI * 140 * h * i) / FS) / h;
    const t = i / FS, syl = Math.sin(Math.PI * ((t * 4) % 1)); // 4 syllables a second
    out[i] = (v * 0.3 + air[i]) * (syl > 0.2 ? syl : 0);
  }
  const g = dbToGain(rms) / dbToGain(rmsDb(out));
  return out.map((v) => v * g);
}

describe("loudness", () => {
  it("reads a full-scale 1 kHz sine as -3.01 LUFS (BS.1770 calibration)", () => {
    expect(integratedLoudness(sine(3, 1000, 1), FS)).toBeCloseTo(-3.01, 1);
  });
  it("reads a -20 dBFS 997 Hz sine as -23 LUFS", () => {
    expect(integratedLoudness(sine(3, 997, 0.1), FS)).toBeCloseTo(-23.01, 1);
  });
  it("gates out silence so pauses do not lower the reading", () => {
    const tone = sine(3, 1000, 0.1);
    const withGap = new Float32Array(tone.length * 2); withGap.set(tone, 0);
    expect(integratedLoudness(withGap, FS)).toBeCloseTo(integratedLoudness(tone, FS), 0);
  });
  it("short-term meter agrees with the integrated reading on a steady tone", () => {
    const m = new LoudnessMeter(FS);
    sine(4, 1000, 0.1).forEach((v) => m.process(v));
    expect(m.shortTerm).toBeCloseTo(-23, 0);
  });
});

describe("spectrum", () => {
  it("keeps Parseval: bins add up to the mean square", () => {
    const x = noise(2, -20);
    const s = powerSpectrum(x, FS, 2048);
    const total = s.power.reduce((a, b) => a + b, 0);
    expect(10 * Math.log10(total)).toBeCloseTo(rmsDb(x), 0);
  });
  it("puts a sine's energy in its band", () => {
    const s = powerSpectrum(sine(1, 3000, 0.5), FS, 2048);
    expect(bandDb(s, 2000, 5000)).toBeGreaterThan(bandDb(s, 100, 1500) + 40);
  });
  it("finds 50 Hz hum and ignores plain hiss", () => {
    const hiss = noise(5, -60);
    expect(detectHum(powerSpectrum(hiss, FS, 16384))).toBeNull();
    const hum = add(hiss, sine(5, 50, dbToGain(-55)));
    expect(detectHum(powerSpectrum(hum, FS, 16384))).toBe(50);
  });
});

describe("levels", () => {
  it("measures peak and counts flat-topped clipping", () => {
    const x = sine(0.1, 100, 1.4).map((v) => Math.max(-1, Math.min(1, v)));
    expect(peakDb(x)).toBeCloseTo(0, 3);
    expect(clippedRuns(x)).toBeGreaterThan(5);
    expect(clippedRuns(sine(0.1, 100, 0.5))).toBe(0);
  });
});

describe("dsp blocks", () => {
  it("high-pass removes rumble and keeps the voice", () => {
    const hp = new Biquad().highpass(FS, 80);
    expect(rmsDb(run(sine(1, 20, 0.5), (v) => hp.process(v)), FS / 2)).toBeLessThan(rmsDb(sine(1, 20, 0.5)) - 20);
    const hp2 = new Biquad().highpass(FS, 80);
    expect(rmsDb(run(sine(1, 1000, 0.5), (v) => hp2.process(v)), FS / 2)).toBeCloseTo(rmsDb(sine(1, 1000, 0.5)), 0);
  });
  it("compressor static curve: 10 dB over a 4:1 threshold comes out 2.5 dB over", () => {
    expect(compressorGainDb(-10, -20, 4, 0)).toBeCloseTo(-7.5, 5);
    expect(compressorGainDb(-30, -20, 4, 6)).toBe(0);
  });
  it("compressor reduces a loud tone toward its curve", () => {
    const c = new Compressor(FS, { thresholdDb: -20, ratio: 4, kneeDb: 0, attackMs: 5, releaseMs: 100, makeupDb: 0 });
    const y = run(sine(1, 500, dbToGain(-10 + 3.01)), (v) => c.process(v)); // RMS -10 dBFS
    expect(rmsDb(y, FS / 2)).toBeCloseTo(-17.5, 0);
  });
  it("gate closes on room noise and opens for speech", () => {
    const p = { thresholdDb: -50, rangeDb: 15, attackMs: 2, holdMs: 100, releaseMs: 80 };
    const g = new Gate(FS, p);
    const quiet = noise(1, -65);
    expect(rmsDb(run(quiet, (v) => g.process(v)), FS / 2)).toBeCloseTo(-80, 0);
    const g2 = new Gate(FS, p);
    expect(rmsDb(run(noise(1, -25), (v) => g2.process(v)), FS / 2)).toBeCloseTo(-25, 0);
  });
  it("de-esser cuts loud sibilance and leaves the low voice alone", () => {
    const p = { freq: 6500, thresholdDb: -40, ratio: 4, maxReductionDb: 10 };
    const d = new Deesser(FS, p);
    const ess = sine(1, 7000, 0.3);
    expect(rmsDb(run(ess, (v) => d.process(v)), FS / 2)).toBeLessThan(rmsDb(ess) - 6);
    const d2 = new Deesser(FS, p);
    const low = sine(1, 300, 0.3);
    expect(rmsDb(run(low, (v) => d2.process(v)), FS / 2)).toBeCloseTo(rmsDb(low), 0);
  });
  it("AGC brings a quiet voice to the target slowly and does not rise in silence", () => {
    const agc = new Agc(FS, { targetLufs: -16, maxGainDb: 20, minGainDb: -12, speedDbPerSec: 1.5 });
    const quiet = sine(20, 1000, dbToGain(-30 + 3.01 - 0.69)); // about -30 LUFS
    const out = run(quiet, (v) => agc.process(v));
    expect(agc.currentGainDb).toBeGreaterThan(12);
    expect(integratedLoudness(out.subarray(out.length - 3 * FS), FS)).toBeCloseTo(-16, 0);
    // after one second, gain has moved no more than the speed allows
    const agc2 = new Agc(FS, { targetLufs: -16, maxGainDb: 20, minGainDb: -12, speedDbPerSec: 1.5 });
    sine(1, 1000, 0.03).forEach((v) => agc2.process(v));
    expect(agc2.currentGainDb).toBeLessThanOrEqual(1.6);
    const before = agc.currentGainDb;
    new Float32Array(5 * FS).forEach((v) => agc.process(v));
    expect(agc.currentGainDb).toBeLessThanOrEqual(before + 1e-6);
  });
  it("limiter never lets a sample past the ceiling", () => {
    const l = new Limiter(FS, -1, 80);
    const loud = noise(2, -2).map((v, i) => v * (i % 9000 < 300 ? 6 : 1));
    const y = run(loud, (v) => l.process(v));
    expect(peakDb(y)).toBeLessThanOrEqual(-1 + 1e-4);
    // and leaves quiet material untouched (apart from its delay)
    const l2 = new Limiter(FS, -1, 80);
    const q = sine(0.5, 440, 0.2);
    const yq = run(q, (v) => l2.process(v));
    expect(yq[1000 + l2.latency]).toBeCloseTo(q[1000], 5);
  });
});

describe("Mic check", () => {
  it("measures noise floor, speech level and the gain to apply", () => {
    const silence = noise(5, -62, 3);
    const speech = add(voice(10, -32), noise(10, -62, 4));
    const m = measureMic(silence, speech, FS);
    expect(m.noiseFloorDb).toBeGreaterThan(-64);
    expect(m.noiseFloorDb).toBeLessThan(-60);
    expect(m.speechDb).toBeGreaterThan(-33);
    expect(m.speechDb).toBeLessThan(-27);
    expect(m.clippedRuns).toBe(0);
    const plan = planFromMetrics(m, defaultSettings());
    expect(plan.ok).toBe(true);
    expect(plan.settings.inputGainDb).toBeGreaterThanOrEqual(7);
    expect(plan.findings.some((f) => f.text.startsWith("You're quiet, +"))).toBe(true);
    expect(plan.settings.gate.thresholdDb).toBeGreaterThan(m.noiseFloorDb + plan.settings.inputGainDb - 20);
    expect(plan.settings.gate.thresholdDb).toBeLessThan(m.speechDb + plan.settings.inputGainDb - 14);
  });

  it("sees a boomy voice in the spectrum", () => {
    const silence = noise(5, -70, 3);
    const clean = voice(10, -22);
    const boom = new Biquad().lowshelf(FS, 200, 12);
    const boomy = clean.map((v) => boom.process(v));
    const a = measureMic(silence, clean, FS), b = measureMic(silence, boomy, FS);
    expect(b.balance.low).toBeGreaterThan(a.balance.low + 6);
  });

  const metrics = (over: Partial<MicMetrics>): MicMetrics => ({
    sampleRate: FS, noiseFloorDb: -70, speechDb: -20, speechLufs: -20, peakDb: -6, clippedRuns: 0, snrDb: 50,
    voicedRatio: 0.7, humHz: null, balance: { low: 0, presence: 0, sibilance: 0, air: 0 }, sibilanceP95Db: -35, ...over,
  });

  it("turns a noisy room into strong suppression and a deeper gate", () => {
    const plan = planFromMetrics(metrics({ noiseFloorDb: -42, snrDb: 22 }), defaultSettings());
    expect(plan.settings.ns).toEqual({ mode: "rnnoise", mix: 1 });
    expect(plan.settings.gate.rangeDb).toBeGreaterThanOrEqual(18);
    expect(plan.findings.some((f) => f.tone === "warn" && f.text.includes("noisy"))).toBe(true);
  });
  it("keeps suppression light in a quiet room", () => {
    const plan = planFromMetrics(metrics({}), PRESETS.broadcast.settings);
    expect(plan.settings.ns.mix).toBeLessThanOrEqual(0.6);
  });
  it("warns about clipping and does not add gain on top", () => {
    const plan = planFromMetrics(metrics({ peakDb: 0, clippedRuns: 12, speechDb: -14 }), defaultSettings());
    expect(plan.findings[0].tone).toBe("warn");
    expect(plan.findings[0].text).toContain("clipping");
    expect(plan.settings.inputGainDb).toBeLessThan(0);
  });
  it("cuts boom, softens harshness, adds air, firms the de-esser", () => {
    const plan = planFromMetrics(metrics({ balance: { low: 9, presence: 7, sibilance: 8, air: -14 } }), defaultSettings());
    expect(plan.settings.eq.lowGainDb).toBeLessThan(-3);
    expect(plan.settings.eq.presenceGainDb).toBeLessThan(-3);
    expect(plan.settings.eq.airGainDb).toBeGreaterThan(1);
    expect(plan.settings.deesser.maxReductionDb).toBeGreaterThanOrEqual(10);
  });
  it("raises the low cut over mains hum", () => {
    const plan = planFromMetrics(metrics({ humHz: 60 }), defaultSettings());
    expect(plan.settings.highpass.freq).toBe(120);
  });
  it("refuses to guess when it could not hear the voice", () => {
    const plan = planFromMetrics(metrics({ voicedRatio: 0.05, snrDb: 3 }), defaultSettings());
    expect(plan.ok).toBe(false);
  });
  it("starts the AGC near the gain the take needs", () => {
    const plan = planFromMetrics(metrics({ speechLufs: -30, speechDb: -30 }), PRESETS.podcast.settings);
    // gain +10 brings it to -20, compressor estimate +2, target -16 leaves about +2
    expect(plan.agcStartGainDb).toBeCloseTo(2, 0);
  });
});

describe("whole chain", () => {
  it("a quiet voice in a noisy room comes out on target, under the ceiling, with the gaps quieter", () => {
    const silence = noise(5, -50, 11);
    const speech = add(voice(12, -34, 5), noise(12, -50, 12));
    const plan = planFromMetrics(measureMic(silence, speech, FS), PRESETS.podcast.settings);
    expect(plan.ok).toBe(true);
    const chain = new VoiceChain(FS, plan.settings, plan.agcStartGainDb);
    const g = dbToGain(plan.settings.inputGainDb);
    // The worklet sits after noise suppression; stand in for it with the reduction the plan assumes.
    const left = dbToGain(-20 * plan.settings.ns.mix);
    const take = new Float32Array(speech.length + silence.length);
    take.set(add(voice(12, -34, 5), noise(12, -50, 12).map((v) => v * left)));
    take.set(silence.map((v) => v * left), speech.length);
    const out = take.map((v) => chain.process(v * g));
    expect(peakDb(out)).toBeLessThanOrEqual(plan.settings.limiter.ceilingDb + 1e-4);
    expect(integratedLoudness(out.subarray(6 * FS, 12 * FS), FS)).toBeGreaterThan(plan.settings.agc.targetLufs - 3);
    expect(integratedLoudness(out.subarray(6 * FS, 12 * FS), FS)).toBeLessThan(plan.settings.agc.targetLufs + 3);
    // room tone between takes: the gate pushes it down by its depth
    const roomIn = rmsDb(take.subarray(speech.length + FS)) + plan.settings.inputGainDb;
    expect(rmsDb(out.subarray(speech.length + FS))).toBeLessThan(roomIn - 6);
  });
});

describe("settings", () => {
  it("sanitizes junk from storage into a full chain", () => {
    const s = sanitizeSettings({ inputGainDb: "loud", ns: { mode: "magic", mix: 5 }, gate: { thresholdDb: -40 } });
    expect(s.inputGainDb).toBe(0);
    expect(s.ns.mode).toBe("rnnoise");
    expect(s.ns.mix).toBe(1);
    expect(s.gate.thresholdDb).toBe(-40);
    expect(s.gate.rangeDb).toBe(defaultSettings().gate.rangeDb);
    expect(sanitizeSettings(null)).toEqual(defaultSettings());
  });
  it("switching preset keeps what the Mic check measured", () => {
    const cur = { ...defaultSettings(), inputGainDb: 9, gate: { ...defaultSettings().gate, thresholdDb: -47 } };
    const next = applyPreset("broadcast", cur);
    expect(next.inputGainDb).toBe(9);
    expect(next.gate.thresholdDb).toBe(-47);
    expect(next.comp.ratio).toBe(PRESETS.broadcast.settings.comp.ratio);
  });
});

describe("feedback guard", () => {
  const run = (levels: number[], dt = 50) => {
    let s = initialFeedback();
    for (const db of levels) {
      const r = feedbackStep(s, db, dt);
      s = r.state;
      if (r.tripped) return true;
    }
    return false;
  };
  it("mutes a howl that holds near full scale", () => {
    expect(run(Array(10).fill(-4))).toBe(true);
  });
  it("leaves loud speech alone: it has gaps", () => {
    const speech = Array.from({ length: 200 }, (_, i) => (i % 6 < 4 ? -9 : -30));
    expect(run(speech)).toBe(false);
  });
  it("leaves normal speech alone", () => {
    expect(run(Array(200).fill(-18))).toBe(false);
  });
  it("does not count a long pause between readings as loud time", () => {
    expect(run([-4, -4], 5000)).toBe(false);
  });
});
