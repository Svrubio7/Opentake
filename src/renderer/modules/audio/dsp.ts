import type { ChainSettings } from "./audio-core";

// Sample-by-sample voice DSP. Pure TypeScript, no DOM: the AudioWorklet runs it live
// and vitest runs it on synthetic signals. Every class processes one mono sample at a time.

export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g > 1e-10 ? 20 * Math.log10(g) : -200);
export const powerToDb = (p: number) => (p > 1e-20 ? 10 * Math.log10(p) : -200);

/** One-pole smoothing coefficient for a time constant in ms. */
export const timeCoef = (ms: number, sampleRate: number) =>
  ms <= 0 ? 0 : Math.exp(-1 / ((ms / 1000) * sampleRate));

/** RBJ cookbook biquad, transposed direct form II. */
export class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  private z1 = 0; private z2 = 0;

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
    return this;
  }
  highpass(fs: number, f: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * f) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  lowpass(fs: number, f: number, q = Math.SQRT1_2) {
    const w = (2 * Math.PI * f) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  bandpass(fs: number, f: number, q: number) {
    const w = (2 * Math.PI * f) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }
  peaking(fs: number, f: number, q: number, gainDb: number) {
    const A = Math.pow(10, gainDb / 40), w = (2 * Math.PI * f) / fs, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this.set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
  lowshelf(fs: number, f: number, gainDb: number, q = Math.SQRT1_2) {
    const A = Math.pow(10, gainDb / 40), w = (2 * Math.PI * f) / fs, c = Math.cos(w), s = Math.sin(w);
    const al = s / (2 * q), k = 2 * Math.sqrt(A) * al;
    return this.set(
      A * (A + 1 - (A - 1) * c + k), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - k),
      A + 1 + (A - 1) * c + k, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - k,
    );
  }
  highshelf(fs: number, f: number, gainDb: number, q = Math.SQRT1_2) {
    const A = Math.pow(10, gainDb / 40), w = (2 * Math.PI * f) / fs, c = Math.cos(w), s = Math.sin(w);
    const al = s / (2 * q), k = 2 * Math.sqrt(A) * al;
    return this.set(
      A * (A + 1 + (A - 1) * c + k), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - k),
      A + 1 - (A - 1) * c + k, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - k,
    );
  }
  /** Raw normalized coefficients (a0 = 1). */
  coefs(b0: number, b1: number, b2: number, a1: number, a2: number) { return this.set(b0, b1, b2, 1, a1, a2); }
  process(x: number) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = 0; this.z2 = 0; }
}

/**
 * ITU-R BS.1770 K-weighting (pre-filter shelf + RLB high-pass) at any sample rate, using the
 * analog-prototype derivation libebur128 uses; at 48 kHz it reproduces the spec's coefficients.
 */
export class KWeighting {
  private shelf = new Biquad(); private hp = new Biquad();
  constructor(fs: number) {
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan((Math.PI * f0) / fs);
    const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
    let a0 = 1 + K / Q + K * K;
    this.shelf.coefs((Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0,
      (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
    f0 = 38.13547087602444; Q = 0.5003270373238773;
    K = Math.tan((Math.PI * f0) / fs);
    a0 = 1 + K / Q + K * K;
    this.hp.coefs(1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  }
  process(x: number) { return this.hp.process(this.shelf.process(x)); }
}

/** Mean square to LUFS for one channel (BS.1770: -0.691 + 10 log10). */
export const msToLufs = (ms: number) => -0.691 + powerToDb(ms);

/** Momentary (400 ms) and short-term (3 s) loudness, updated every 100 ms block. */
export class LoudnessMeter {
  private k: KWeighting;
  private blockLen: number; private acc = 0; private n = 0;
  private blocks: number[] = [];
  momentary = -200; shortTerm = -200;
  constructor(fs: number) { this.k = new KWeighting(fs); this.blockLen = Math.round(fs / 10); }
  process(x: number) {
    const y = this.k.process(x);
    this.acc += y * y;
    if (++this.n >= this.blockLen) {
      this.blocks.push(this.acc / this.n);
      if (this.blocks.length > 30) this.blocks.shift();
      this.acc = 0; this.n = 0;
      const mean = (from: number) => {
        const b = this.blocks.slice(from);
        return b.reduce((s, v) => s + v, 0) / b.length;
      };
      this.momentary = msToLufs(mean(Math.max(0, this.blocks.length - 4)));
      this.shortTerm = msToLufs(mean(0));
    }
  }
}

export interface GateParams { thresholdDb: number; rangeDb: number; attackMs: number; holdMs: number; releaseMs: number }

/** Downward expander/gate with hysteresis and hold. Opens fast, closes gently to `rangeDb`. */
export class Gate {
  private env = 0; private envCoef: number;
  private open = false; private holdLeft = 0;
  private gainDb = 0;
  private p!: GateParams; private atk = 0; private rel = 0; private hold = 0;
  constructor(private fs: number, p: GateParams) { this.envCoef = timeCoef(5, fs); this.set(p); }
  set(p: GateParams) {
    this.p = p; this.atk = timeCoef(p.attackMs, this.fs); this.rel = timeCoef(p.releaseMs, this.fs);
    this.hold = Math.round((p.holdMs / 1000) * this.fs);
  }
  /** Current attenuation in dB (<= 0). */
  get reductionDb() { return this.gainDb; }
  get isOpen() { return this.open; }
  process(x: number) {
    this.env = this.envCoef * this.env + (1 - this.envCoef) * x * x;
    const lvl = powerToDb(this.env);
    if (lvl >= this.p.thresholdDb) { this.open = true; this.holdLeft = this.hold; }
    else if (lvl < this.p.thresholdDb - 4) {
      if (this.holdLeft > 0) this.holdLeft--; else this.open = false;
    }
    const target = this.open ? 0 : -Math.abs(this.p.rangeDb);
    const c = target > this.gainDb ? this.atk : this.rel;
    this.gainDb = c * this.gainDb + (1 - c) * target;
    return x * dbToGain(this.gainDb);
  }
}

export interface DeesserParams { freq: number; thresholdDb: number; ratio: number; maxReductionDb: number }

/**
 * Dynamic-band de-esser. A band-pass around the sibilance band is both the side chain and the band
 * that gets turned down: y = x + (g - 1) * band(x). With the RBJ 0 dB band-pass, x - band(x) is an
 * exact notch, so at g = 1 the output is x untouched and only the sibilance band ever moves.
 */
export class Deesser {
  private band = new Biquad();
  private env = 0; private envAtk: number; private envRel: number;
  private grDb = 0; private grAtk: number; private grRel: number;
  private p!: DeesserParams;
  constructor(private fs: number, p: DeesserParams) {
    this.envAtk = timeCoef(0.5, fs); this.envRel = timeCoef(40, fs);
    this.grAtk = timeCoef(1, fs); this.grRel = timeCoef(60, fs);
    this.set(p);
  }
  set(p: DeesserParams) {
    this.p = p;
    this.band.bandpass(this.fs, p.freq, 0.9);
  }
  get reductionDb() { return this.grDb; }
  process(x: number) {
    const s = this.band.process(x), s2 = s * s;
    const c = s2 > this.env ? this.envAtk : this.envRel;
    this.env = c * this.env + (1 - c) * s2;
    const over = powerToDb(this.env) - this.p.thresholdDb; // RMS level of the sibilance band
    const want = over > 0 ? -Math.min(over * (1 - 1 / this.p.ratio), this.p.maxReductionDb) : 0;
    const g = want < this.grDb ? this.grAtk : this.grRel;
    this.grDb = g * this.grDb + (1 - g) * want;
    return x + (dbToGain(this.grDb) - 1) * s;
  }
}

export interface EqParams {
  lowFreq: number; lowGainDb: number;
  presenceFreq: number; presenceGainDb: number; presenceQ: number;
  airFreq: number; airGainDb: number;
}

export class ThreeBandEq {
  private low = new Biquad(); private mid = new Biquad(); private air = new Biquad();
  constructor(private fs: number, p: EqParams) { this.set(p); }
  set(p: EqParams) {
    this.low.lowshelf(this.fs, p.lowFreq, p.lowGainDb);
    this.mid.peaking(this.fs, p.presenceFreq, p.presenceQ, p.presenceGainDb);
    this.air.highshelf(this.fs, Math.min(p.airFreq, this.fs * 0.45), p.airGainDb);
  }
  process(x: number) { return this.air.process(this.mid.process(this.low.process(x))); }
}

export interface CompressorParams { thresholdDb: number; ratio: number; kneeDb: number; attackMs: number; releaseMs: number; makeupDb: number }

/** Static curve of a soft-knee compressor (Giannoulis, Massberg, Reiss 2012). Returns gain in dB (<= 0). */
export function compressorGainDb(levelDb: number, thresholdDb: number, ratio: number, kneeDb: number) {
  const over = levelDb - thresholdDb;
  if (kneeDb > 0 && Math.abs(over) <= kneeDb / 2) {
    return ((1 / ratio - 1) * Math.pow(over + kneeDb / 2, 2)) / (2 * kneeDb);
  }
  return over > 0 ? over * (1 / ratio - 1) : 0;
}

/** Feed-forward compressor with an RMS-ish detector and smoothed gain reduction. */
export class Compressor {
  private env = 0; private envCoef: number;
  private grDb = 0; private atk = 0; private rel = 0;
  private p!: CompressorParams;
  constructor(private fs: number, p: CompressorParams) { this.envCoef = timeCoef(2, fs); this.set(p); }
  set(p: CompressorParams) { this.p = p; this.atk = timeCoef(p.attackMs, this.fs); this.rel = timeCoef(p.releaseMs, this.fs); }
  get reductionDb() { return this.grDb; }
  process(x: number) {
    this.env = this.envCoef * this.env + (1 - this.envCoef) * x * x;
    const lvl = powerToDb(this.env); // RMS dBFS, like every other threshold here
    const want = compressorGainDb(lvl, this.p.thresholdDb, this.p.ratio, this.p.kneeDb);
    const c = want < this.grDb ? this.atk : this.rel;
    this.grDb = c * this.grDb + (1 - c) * want;
    return x * dbToGain(this.grDb + this.p.makeupDb);
  }
}

export interface AgcParams { targetLufs: number; maxGainDb: number; minGainDb: number; speedDbPerSec: number }

/**
 * Slow automatic gain control toward a loudness target. Measures K-weighted loudness of its own
 * input in 100 ms blocks, averages only blocks that carry speech (gated like BS.1770), and moves
 * the gain at most `speedDbPerSec`. It never raises the gain during silence, so it cannot pump noise.
 */
export class Agc {
  private k: KWeighting; private blockLen: number; private acc = 0; private n = 0;
  private avgMs = 0; private haveAvg = false; private avgCoef: number;
  private gainDb = 0; private targetGainDb = 0; private step = 0;
  private p!: AgcParams;
  constructor(fs: number, p: AgcParams, startGainDb = 0) {
    this.k = new KWeighting(fs);
    this.blockLen = Math.round(fs / 10);
    this.avgCoef = Math.exp(-0.1 / 3); // 3 s time constant over 100 ms blocks
    this.set(p);
    this.reset(startGainDb);
  }
  set(p: AgcParams) { this.p = p; }
  reset(gainDb: number) {
    this.gainDb = this.targetGainDb = Math.max(this.p.minGainDb, Math.min(this.p.maxGainDb, gainDb));
    this.haveAvg = false; this.step = 0;
  }
  get currentGainDb() { return this.gainDb; }
  /** Loudness the AGC currently believes its input has, or null before speech was heard. */
  get inputLufs() { return this.haveAvg ? msToLufs(this.avgMs) : null; }
  process(x: number) {
    const y = this.k.process(x);
    this.acc += y * y;
    if (++this.n >= this.blockLen) {
      const ms = this.acc / this.n;
      this.acc = 0; this.n = 0;
      const blockLufs = msToLufs(ms);
      // Gate: absolute -60 LUFS, and relative to where the output would land (speech only).
      const isSpeech = blockLufs > -60 && blockLufs + this.gainDb > this.p.targetLufs - 20;
      if (isSpeech) {
        this.avgMs = this.haveAvg ? this.avgCoef * this.avgMs + (1 - this.avgCoef) * ms : ms;
        this.haveAvg = true;
        const want = this.p.targetLufs - msToLufs(this.avgMs);
        this.targetGainDb = Math.max(this.p.minGainDb, Math.min(this.p.maxGainDb, want));
      } else {
        this.targetGainDb = Math.min(this.targetGainDb, this.gainDb); // hold, never rise in silence
      }
      const maxMove = this.p.speedDbPerSec * 0.1;
      const delta = Math.max(-maxMove, Math.min(maxMove, this.targetGainDb - this.gainDb));
      this.step = delta / this.blockLen;
    }
    this.gainDb += this.step;
    return x * dbToGain(this.gainDb);
  }
}

/**
 * Look-ahead brickwall limiter. Running minimum of the required gain over the look-ahead window,
 * a release stage, then a box filter of the same length: the gain applied to each delayed sample
 * is an average of values that are all at or below that sample's own requirement, so the output
 * never passes the ceiling. A final clamp guards rounding.
 */
export class Limiter {
  private L: number; private delay: Float32Array; private req: Float32Array; private box: Float32Array;
  private pos = 0; private boxSum: number; private rel = 0; private relCoef = 0;
  private ceiling = 1; private grDb = 0;
  constructor(fs: number, ceilingDb: number, releaseMs: number, lookaheadMs = 1.5) {
    this.L = Math.max(2, Math.round((lookaheadMs / 1000) * fs));
    this.delay = new Float32Array(this.L);
    this.req = new Float32Array(this.L).fill(1);
    this.box = new Float32Array(this.L).fill(1);
    this.boxSum = this.L;
    this.rel = 1;
    this.set(fs, ceilingDb, releaseMs);
  }
  set(fs: number, ceilingDb: number, releaseMs: number) { this.ceiling = dbToGain(ceilingDb); this.relCoef = timeCoef(releaseMs, fs); }
  /** Latency in samples. */
  get latency() { return this.L - 1; }
  get reductionDb() { return this.grDb; }
  process(x: number) {
    const a = Math.abs(x);
    const need = a > this.ceiling ? this.ceiling / a : 1;
    const i = this.pos;
    this.req[i] = need;
    let h = 1;
    for (let k = 0; k < this.L; k++) if (this.req[k] < h) h = this.req[k];
    this.rel = h < this.rel ? h : this.relCoef * this.rel + (1 - this.relCoef) * h;
    if (this.rel > h) this.rel = h; // release never lifts above the window requirement
    this.boxSum += this.rel - this.box[i];
    this.box[i] = this.rel;
    if (i === 0) { let sum = 0; for (let k = 0; k < this.L; k++) sum += this.box[k]; this.boxSum = sum; } // no drift over hours
    const g = this.boxSum / this.L;
    // Delay line of L-1 samples: read the oldest sample in the ring.
    const next = (i + 1) % this.L;
    this.delay[i] = x;
    const out = this.delay[next] * g;
    this.pos = next;
    this.grDb = gainToDb(g);
    return out > this.ceiling ? this.ceiling : out < -this.ceiling ? -this.ceiling : out;
  }
}

/** The post-suppression chain in its fixed order. The worklet runs exactly this. */
export class VoiceChain {
  gate: Gate; deess: Deesser; eq: ThreeBandEq; comp: Compressor; agc: Agc; lim: Limiter;
  /** Deepest reduction (dB) each stage applied since the last `takeReductions()`. */
  private gr = { gateDb: 0, deessDb: 0, compDb: 0, limDb: 0 };
  constructor(private fs: number, private s: ChainSettings, agcStartGainDb = 0) {
    this.gate = new Gate(fs, s.gate);
    this.deess = new Deesser(fs, s.deesser);
    this.eq = new ThreeBandEq(fs, s.eq);
    this.comp = new Compressor(fs, s.comp);
    this.agc = new Agc(fs, s.agc, agcStartGainDb);
    this.lim = new Limiter(fs, s.limiter.ceilingDb, s.limiter.releaseMs);
  }
  set(s: ChainSettings) {
    this.s = s;
    this.gate.set(s.gate); this.deess.set(s.deesser); this.eq.set(s.eq); this.comp.set(s.comp); this.agc.set(s.agc);
    this.lim.set(this.fs, s.limiter.ceilingDb, s.limiter.releaseMs);
  }
  process(x: number) {
    const s = this.s, gr = this.gr;
    if (s.gate.on) { x = this.gate.process(x); if (this.gate.reductionDb < gr.gateDb) gr.gateDb = this.gate.reductionDb; }
    if (s.deesser.on) { x = this.deess.process(x); if (this.deess.reductionDb < gr.deessDb) gr.deessDb = this.deess.reductionDb; }
    if (s.eq.on) x = this.eq.process(x);
    if (s.comp.on) { x = this.comp.process(x); if (this.comp.reductionDb < gr.compDb) gr.compDb = this.comp.reductionDb; }
    if (s.agc.on) x = this.agc.process(x);
    if (s.limiter.on) { x = this.lim.process(x); if (this.lim.reductionDb < gr.limDb) gr.limDb = this.lim.reductionDb; }
    return x;
  }
  takeReductions() {
    const out = { ...this.gr, agcDb: this.s.agc.on ? this.agc.currentGainDb : 0 };
    this.gr = { gateDb: 0, deessDb: 0, compDb: 0, limDb: 0 };
    return out;
  }
}
