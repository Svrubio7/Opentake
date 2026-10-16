// AudioWorklet module (bundled on its own by Vite through `?worker&url`). Two processors:
//  - "take-tap": reads the raw mic for the input meter and records raw PCM for the Mic check.
//  - "take-voice": gate, de-esser, EQ, compressor, AGC, limiter, plus the output meters.
import type { ChainSettings } from "./audio-core";
import { LoudnessMeter, VoiceChain, gainToDb } from "./dsp";

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
interface WorkletOptions { processorOptions?: Record<string, unknown> }

/** Meters are posted about 20 times a second. */
const METER_EVERY = () => Math.round(sampleRate / 20);

class TapProcessor extends AudioWorkletProcessor {
  private peak = 0; private sum = 0; private n = 0; private clips = 0;
  private capturing = false; private chunk = new Float32Array(4800); private fill = 0;
  private every = METER_EVERY();
  constructor(o: WorkletOptions) {
    super(o);
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: string; on?: boolean };
      if (d.type === "capture") {
        if (!d.on && this.fill) this.flush();
        this.capturing = !!d.on;
        if (this.capturing) this.fill = 0;
      }
    };
  }
  private flush() {
    const out = this.chunk.slice(0, this.fill);
    this.port.postMessage({ type: "pcm", data: out }, [out.buffer]);
    this.fill = 0;
  }
  process(inputs: Float32Array[][]) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i], a = Math.abs(x);
      if (a > this.peak) this.peak = a;
      if (a >= 0.999) this.clips++;
      this.sum += x * x;
      if (this.capturing) {
        this.chunk[this.fill++] = x;
        if (this.fill === this.chunk.length) this.flush();
      }
    }
    this.n += ch.length;
    if (this.n >= this.every) {
      this.port.postMessage({ type: "meter", peakDb: gainToDb(this.peak), rmsDb: gainToDb(Math.sqrt(this.sum / this.n)), clips: this.clips });
      this.peak = 0; this.sum = 0; this.n = 0; this.clips = 0;
    }
    return true;
  }
}

class VoiceProcessor extends AudioWorkletProcessor {
  private chain: VoiceChain;
  private meter = new LoudnessMeter(sampleRate);
  private peak = 0; private sum = 0; private n = 0;
  private every = METER_EVERY();

  constructor(o: WorkletOptions) {
    super(o);
    const opts = o.processorOptions ?? {};
    this.chain = new VoiceChain(sampleRate, opts.settings as ChainSettings, Number(opts.agcStartGainDb ?? 0));
    this.port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type: string; settings?: ChainSettings; gainDb?: number };
      if (d.type === "settings" && d.settings) this.chain.set(d.settings);
      if (d.type === "agc") this.chain.agc.reset(d.gainDb ?? 0);
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]) {
    const inp = inputs[0]?.[0], out = outputs[0]?.[0];
    if (!out) return true;
    for (let i = 0; i < out.length; i++) {
      const x = this.chain.process(inp ? inp[i] : 0);
      out[i] = x;
      const a = Math.abs(x);
      if (a > this.peak) this.peak = a;
      this.sum += x * x;
      this.meter.process(x);
    }
    this.n += out.length;
    if (this.n >= this.every) {
      this.port.postMessage({
        type: "meter",
        peakDb: gainToDb(this.peak), rmsDb: gainToDb(Math.sqrt(this.sum / this.n)),
        ...this.chain.takeReductions(),
        lufsS: this.meter.shortTerm, lufsM: this.meter.momentary,
      });
      this.peak = 0; this.sum = 0; this.n = 0;
    }
    return true;
  }
}

registerProcessor("take-tap", TapProcessor);
registerProcessor("take-voice", VoiceProcessor);
