// The live voice engine: one AudioContext for the life of the app, a mic source, the processing
// chain, and a MediaStreamAudioDestinationNode published as the "mic" stream. The published
// stream object never changes when the device or the settings change, so the recorder can hold it.
import { RnnoiseWorkletNode, SpeexWorkletNode } from "@sapphi-red/web-noise-suppressor";
import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import speexWorkletUrl from "@sapphi-red/web-noise-suppressor/speexWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseSimdWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";
import speexWasmUrl from "@sapphi-red/web-noise-suppressor/speex.wasm?url";
import { publishStream } from "@core/streams";
import voiceWorkletUrl from "./voice.worklet.ts?worker&url";
import type { ChainSettings, NsMode } from "./audio-core";
import { useAudioStore } from "./store";

const SAMPLE_RATE = 48000;
/** RNNoise buffers 480-sample frames inside 128-sample render quanta: its output trails by 512 samples. */
const RNNOISE_LATENCY = 512;

export interface InputMeter { peakDb: number; rmsDb: number; clips: number }
export interface OutputMeter {
  peakDb: number; rmsDb: number; gateDb: number; deessDb: number; compDb: number; limDb: number;
  agcDb: number; lufsS: number; lufsM: number;
}

// ---------------------------------------------------------------- loading

/** fetch() is not allowed on file:// in Electron production builds; XHR is. Try both. */
function loadBinary(url: string): Promise<ArrayBuffer> {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.arrayBuffer();
  }).catch(() => new Promise<ArrayBuffer>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    xhr.responseType = "arraybuffer";
    xhr.onload = () => (xhr.response ? resolve(xhr.response as ArrayBuffer) : reject(new Error(`could not load ${url}`)));
    xhr.onerror = () => reject(new Error(`could not load ${url}`));
    xhr.send();
  }));
}

/** addModule by URL, falling back to a blob: copy of the same code (the page CSP allows blob scripts). */
async function addWorklet(ctx: BaseAudioContext, url: string) {
  try {
    await ctx.audioWorklet.addModule(url);
  } catch {
    const code = new TextDecoder().decode(await loadBinary(url));
    const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    try { await ctx.audioWorklet.addModule(blobUrl); } finally { URL.revokeObjectURL(blobUrl); }
  }
}

const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);

interface Assets { rnnoise: ArrayBuffer | null; speex: ArrayBuffer | null }

async function loadAssets(ctx: AudioContext): Promise<Assets> {
  await addWorklet(ctx, voiceWorkletUrl);
  const [rnnoise, speex] = await Promise.all([
    (async () => {
      if (ctx.sampleRate !== SAMPLE_RATE) return null; // RNNoise is trained on 48 kHz only
      await addWorklet(ctx, rnnoiseWorkletUrl);
      return loadBinary(WebAssembly.validate(SIMD_PROBE) ? rnnoiseSimdWasmUrl : rnnoiseWasmUrl);
    })().catch((e) => { console.warn("[audio] RNNoise unavailable", e); return null; }),
    (async () => { await addWorklet(ctx, speexWorkletUrl); return loadBinary(speexWasmUrl); })()
      .catch((e) => { console.warn("[audio] Speex unavailable", e); return null; }),
  ]);
  return { rnnoise, speex };
}

// ---------------------------------------------------------------- the chain

/** Picks the noise suppressor that can actually run: RNNoise, then Speex, then nothing. */
export function resolveNs(mode: NsMode, assets: Assets): NsMode {
  if (mode === "off") return "off";
  if (mode === "rnnoise" && assets.rnnoise) return "rnnoise";
  if (assets.speex) return "speex";
  return assets.rnnoise ? "rnnoise" : "off";
}

/** high-pass > noise suppression (dry/wet) > voice worklet. Built the same way live and for previews. */
class Chain {
  readonly input: GainNode;
  readonly output: AudioWorkletNode;
  private hp: BiquadFilterNode;
  private nsIn: GainNode; private dryDelay: DelayNode; private dry: GainNode; private wet: GainNode;
  private ns: (AudioWorkletNode & { destroy(): void }) | null = null;
  nsRunning: NsMode = "off";
  private hpOn: boolean | null = null;

  constructor(private ctx: AudioContext, private assets: Assets, settings: ChainSettings, agcStartGainDb = 0) {
    const mono = { channelCount: 1, channelCountMode: "explicit" as const, channelInterpretation: "speakers" as const };
    this.input = new GainNode(ctx, mono);
    this.hp = new BiquadFilterNode(ctx, { ...mono, type: "highpass", Q: Math.SQRT1_2 });
    this.nsIn = new GainNode(ctx, mono);
    this.dryDelay = new DelayNode(ctx, { ...mono, maxDelayTime: 0.05 });
    this.dry = new GainNode(ctx, mono);
    this.wet = new GainNode(ctx, { ...mono, gain: 0 });
    this.output = new AudioWorkletNode(ctx, "take-voice", {
      ...mono, numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
      processorOptions: { settings, agcStartGainDb },
    });
    this.hp.connect(this.nsIn);
    this.nsIn.connect(this.dryDelay).connect(this.dry).connect(this.output);
    this.wet.connect(this.output);
    this.update(settings);
  }

  update(s: ChainSettings) {
    const t = this.ctx.currentTime;
    this.input.gain.setTargetAtTime(Math.pow(10, s.inputGainDb / 20), t, 0.02);
    this.hp.frequency.setTargetAtTime(s.highpass.freq, t, 0.02);
    if (this.hpOn !== s.highpass.on) {
      this.input.disconnect();
      this.input.connect(s.highpass.on ? this.hp : this.nsIn);
      this.hpOn = s.highpass.on;
    }
    const mode = resolveNs(s.ns.mode, this.assets);
    if (mode !== this.nsRunning) this.swapNs(mode);
    const mix = mode === "off" ? 0 : s.ns.mix;
    this.wet.gain.setTargetAtTime(mix, t, 0.03);
    this.dry.gain.setTargetAtTime(1 - mix, t, 0.03);
    this.output.port.postMessage({ type: "settings", settings: s });
  }

  private swapNs(mode: NsMode) {
    if (this.ns) { this.nsIn.disconnect(this.ns); this.ns.disconnect(); this.ns.destroy(); this.ns = null; }
    if (mode === "rnnoise" && this.assets.rnnoise) {
      this.ns = new RnnoiseWorkletNode(this.ctx, { maxChannels: 1, wasmBinary: this.assets.rnnoise });
    } else if (mode === "speex" && this.assets.speex) {
      this.ns = new SpeexWorkletNode(this.ctx, { maxChannels: 1, wasmBinary: this.assets.speex });
    }
    if (this.ns) { this.nsIn.connect(this.ns); this.ns.connect(this.wet); }
    // The dry path waits for the suppressor so the blend never combs.
    this.dryDelay.delayTime.value = mode === "rnnoise" ? RNNOISE_LATENCY / this.ctx.sampleRate : 0;
    this.nsRunning = this.ns ? mode : "off";
  }

  resetAgc(gainDb: number) { this.output.port.postMessage({ type: "agc", gainDb }); }

  dispose() {
    this.input.disconnect(); this.hp.disconnect(); this.nsIn.disconnect(); this.dryDelay.disconnect();
    this.dry.disconnect(); this.wet.disconnect(); this.output.disconnect();
    this.output.port.onmessage = null;
    this.ns?.disconnect(); this.ns?.destroy();
  }
}

// ---------------------------------------------------------------- errors

export function describeMicError(e: unknown): string {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Take can't use the microphone. Allow microphone access in Windows Settings, Privacy and security, Microphone, then press Try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found. Plug one in and press Try again.";
  if (name === "NotReadableError" || name === "AbortError") {
    return "The microphone is busy or failed to start. Close other apps that use it and press Try again.";
  }
  return `The microphone could not start${e instanceof Error && e.message ? ` (${e.message})` : ""}.`;
}

// ---------------------------------------------------------------- the engine

type Listener<T> = (v: T) => void;

class VoiceEngine {
  ctx: AudioContext | null = null;
  private assets: Assets = { rnnoise: null, speex: null };
  private chain: Chain | null = null;
  private tap: AudioWorkletNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private monitor: GainNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private booting: Promise<void> | null = null;
  private opening = 0;
  private inputListeners = new Set<Listener<InputMeter>>();
  private outputListeners = new Set<Listener<OutputMeter>>();
  private pcmListener: ((chunk: Float32Array) => void) | null = null;

  onInput(l: Listener<InputMeter>) { this.inputListeners.add(l); return () => { this.inputListeners.delete(l); }; }
  onOutput(l: Listener<OutputMeter>) { this.outputListeners.add(l); return () => { this.outputListeners.delete(l); }; }

  /** Idempotent: builds the graph once, then opens the saved device. */
  start() {
    this.booting ??= this.boot().catch((e) => {
      this.booting = null;
      useAudioStore.getState().set({ status: "error", error: `Audio engine failed to start (${(e as Error).message}).` });
    });
    return this.booting;
  }

  private async boot() {
    const store = useAudioStore.getState();
    store.set({ status: "starting", error: null });
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    this.ctx = ctx;
    // Electron may create the context suspended until the first gesture.
    const resume = () => { if (ctx.state === "suspended") void ctx.resume(); };
    window.addEventListener("pointerdown", resume, true);
    window.addEventListener("keydown", resume, true);
    resume();

    this.assets = await loadAssets(ctx);
    const s = useAudioStore.getState().settings;
    this.chain = new Chain(ctx, this.assets, s, useAudioStore.getState().agcStartGainDb);
    this.dest = new MediaStreamAudioDestinationNode(ctx); // stereo: the mono voice is up-mixed to both sides
    this.monitor = new GainNode(ctx, { gain: 0 });
    this.chain.output.connect(this.dest);
    this.chain.output.connect(this.monitor).connect(ctx.destination);
    this.chain.output.port.onmessage = (e) => {
      if (e.data?.type === "meter") this.outputListeners.forEach((l) => l(e.data as OutputMeter));
    };

    this.tap = new AudioWorkletNode(ctx, "take-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit" });
    // A silent route to a sink keeps the tap pulled by the graph without making a sound.
    const silent = new GainNode(ctx, { gain: 0 });
    this.tap.connect(silent).connect(this.dest);
    this.tap.port.onmessage = (e) => {
      const d = e.data as { type: string; data?: Float32Array };
      if (d.type === "meter") this.inputListeners.forEach((l) => l(e.data as InputMeter));
      else if (d.type === "pcm" && d.data) this.pcmListener?.(d.data);
    };

    useAudioStore.getState().set({ nsRunning: this.chain.nsRunning, nsAvailable: { rnnoise: !!this.assets.rnnoise, speex: !!this.assets.speex } });
    navigator.mediaDevices.addEventListener("devicechange", () => void this.onDeviceChange());
    await this.open(useAudioStore.getState().deviceId);
  }

  async refreshDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const devices = all.filter((d) => d.kind === "audioinput").map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
      useAudioStore.getState().set({ devices });
      return devices;
    } catch {
      return useAudioStore.getState().devices;
    }
  }

  /** Opens a device (null = system default). Older attempts that resolve late are dropped. */
  async open(deviceId: string | null): Promise<void> {
    if (!this.ctx || !this.chain || !this.tap) return;
    const attempt = ++this.opening;
    const store = useAudioStore.getState();
    store.set({ status: "starting", error: null });
    const constraints = (id: string | null): MediaStreamConstraints => ({
      audio: {
        ...(id ? { deviceId: { exact: id } } : {}),
        // Our chain is the only processing: switch off everything the browser would add.
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
        channelCount: { ideal: 1 }, sampleRate: { ideal: SAMPLE_RATE },
        ...({ voiceIsolation: false } as object),
      },
    });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
    } catch (e) {
      const name = (e as { name?: string }).name;
      // The saved mic is gone: fall back to the system default instead of failing.
      if (deviceId && (name === "NotFoundError" || name === "OverconstrainedError")) return this.open(null);
      if (attempt !== this.opening) return;
      this.detach();
      publishStream("mic", null);
      store.set({ status: "error", error: describeMicError(e) });
      await this.refreshDevices();
      return;
    }
    if (attempt !== this.opening) { stream.getTracks().forEach((t) => t.stop()); return; }

    this.detach();
    this.stream = stream;
    const track = stream.getAudioTracks()[0];
    this.source = new MediaStreamAudioSourceNode(this.ctx, { mediaStream: stream });
    this.source.connect(this.chain.input);
    this.source.connect(this.tap);
    track.addEventListener("ended", () => {
      if (this.stream !== stream) return;
      this.detach();
      publishStream("mic", null);
      useAudioStore.getState().set({ status: "error", error: "Your microphone was disconnected. Plug it back in, or pick another one." });
      void this.onDeviceChange();
    });
    const actualId = track.getSettings().deviceId ?? deviceId;
    const devices = await this.refreshDevices();
    useAudioStore.getState().set({
      status: "running", error: null,
      activeDeviceId: actualId ?? null,
      activeLabel: devices.find((d) => d.id === actualId)?.label ?? track.label,
    });
    if (this.ctx.state === "suspended") void this.ctx.resume();
    publishStream("mic", this.dest!.stream);
  }

  private detach() {
    this.source?.disconnect();
    this.source = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private async onDeviceChange() {
    const devices = await this.refreshDevices();
    const st = useAudioStore.getState();
    if (st.status === "running") {
      // The active mic vanished without an "ended" event: reopen.
      if (st.activeDeviceId && st.activeDeviceId !== "default" && !devices.some((d) => d.id === st.activeDeviceId)) await this.open(null);
      return;
    }
    // Recover on its own when a mic shows up after an unplug.
    if (st.status === "error" && devices.length && !/allow microphone/i.test(st.error ?? "")) {
      const saved = st.deviceId && devices.some((d) => d.id === st.deviceId) ? st.deviceId : null;
      await this.open(saved);
    }
  }

  applySettings(s: ChainSettings) {
    if (!this.chain) return;
    this.chain.update(s);
    useAudioStore.getState().set({ nsRunning: this.chain.nsRunning });
  }

  resetAgc(gainDb: number) { this.chain?.resetAgc(gainDb); }

  setMonitor(on: boolean) {
    if (this.ctx && this.monitor) this.monitor.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.03);
  }

  /** Records `seconds` of the raw mic (before any processing). */
  captureRaw(seconds: number, onProgress?: (fraction: number, chunk: Float32Array) => void, signal?: AbortSignal): Promise<Float32Array> {
    const ctx = this.ctx, tap = this.tap;
    if (!ctx || !tap || useAudioStore.getState().status !== "running") return Promise.reject(new Error("The microphone is not running."));
    const total = Math.round(seconds * ctx.sampleRate);
    const buf = new Float32Array(total);
    let got = 0;
    return new Promise((resolve, reject) => {
      const finish = (err?: Error) => {
        this.pcmListener = null;
        tap.port.postMessage({ type: "capture", on: false });
        signal?.removeEventListener("abort", onAbort);
        if (err) reject(err); else resolve(buf);
      };
      const onAbort = () => finish(new Error("cancelled"));
      signal?.addEventListener("abort", onAbort);
      this.pcmListener = (chunk) => {
        const take = Math.min(chunk.length, total - got);
        buf.set(chunk.subarray(0, take), got);
        got += take;
        onProgress?.(got / total, chunk);
        if (got >= total) finish();
      };
      tap.port.postMessage({ type: "capture", on: true });
    });
  }

  /** A before/after player for one raw take, processed through its own copy of the chain. */
  createPreview(raw: Float32Array, settings: ChainSettings, agcStartGainDb: number) {
    const ctx = this.ctx!;
    const chain = new Chain(ctx, this.assets, settings, agcStartGainDb);
    const buffer = new AudioBuffer({ length: raw.length, numberOfChannels: 1, sampleRate: ctx.sampleRate });
    buffer.copyToChannel(raw as Float32Array<ArrayBuffer>, 0);
    const before = new GainNode(ctx, { gain: 0 });
    const after = new GainNode(ctx, { gain: 1 });
    before.connect(ctx.destination);
    chain.output.connect(after).connect(ctx.destination);
    let sources: AudioBufferSourceNode[] = [];
    let showAfter = true;
    let onEnd: (() => void) | null = null;
    const stop = () => {
      sources.forEach((s) => { s.onended = null; try { s.stop(); } catch { /* already stopped */ } s.disconnect(); });
      sources = [];
    };
    return {
      duration: raw.length / ctx.sampleRate,
      play(ended?: () => void) {
        stop();
        onEnd = ended ?? null;
        if (ctx.state === "suspended") void ctx.resume();
        chain.resetAgc(agcStartGainDb);
        const a = new AudioBufferSourceNode(ctx, { buffer });
        const b = new AudioBufferSourceNode(ctx, { buffer });
        a.connect(before);
        b.connect(chain.input);
        const t = ctx.currentTime + 0.05;
        a.start(t); b.start(t);
        a.onended = () => { stop(); onEnd?.(); };
        sources = [a, b];
        return t;
      },
      stop,
      setAfter(on: boolean) {
        showAfter = on;
        const t = ctx.currentTime;
        after.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
        before.gain.setTargetAtTime(on ? 0 : 1, t, 0.015);
      },
      get after() { return showAfter; },
      currentTime: () => ctx.currentTime,
      dispose() { stop(); chain.dispose(); before.disconnect(); after.disconnect(); },
    };
  }
}

export type Preview = ReturnType<VoiceEngine["createPreview"]>;

let engine: VoiceEngine | null = null;
export function getEngine() { return (engine ??= new VoiceEngine()); }
