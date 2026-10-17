// The prompter's ears, in the main window: mic level for voice pacing and offline speech
// recognition (Vosk in wasm, models bundled in ./models) for voice tracking.
// It listens to the processed mic the audio module publishes; until there is one it opens its own.
import type { Model } from "vosk-browser";
import { getStream, subscribeStreams } from "@core/streams";
import enModelUrl from "./models/vosk-model-small-en-us-0.15.tar.gz?url";
import esModelUrl from "./models/vosk-model-small-es-0.3.tar.gz?url";
import voskWorkerUrl from "./vosk/vosk-worker.js?url";
import { rmsDb, type Lang } from "./prompter-core";
import { t } from "@shared/i18n";

export interface VoiceStatus {
  mic: "off" | "processed" | "own" | "error";
  recognizer: "off" | "loading" | "ready" | "error";
  message?: string;
}

export interface VoiceConfig {
  /** run speech recognition (voice-tracked), not only the level */
  recognize: boolean;
  lang: Lang;
  /** limit recognition to these words (the script's vocabulary); empty = open vocabulary */
  vocabulary: string[];
}

type Recognizer = InstanceType<Model["KaldiRecognizer"]>;

const MODEL_URLS: Record<Lang, string> = { en: enModelUrl, es: esModelUrl };
const SAMPLE_RATE = 16000;
const models = new Map<Lang, Promise<Model>>();

/** Each model is unpacked once and cached by Vosk in IndexedDB; later loads take a second or two. */
export function loadModel(lang: Lang): Promise<Model> {
  let p = models.get(lang);
  if (!p) {
    p = (async () => {
      const { Model } = await import("vosk-browser");
      // an absolute, stable URL: Vosk keys its IndexedDB cache on it
      const url = new URL(MODEL_URLS[lang], document.baseURI).href;
      // vosk-browser would start its worker from a blob: URL, which inherits this page's CSP (no eval);
      // the wasm glue needs eval, so hand it the same worker code as a real file (see vosk/extract-worker.mjs)
      const NativeWorker = window.Worker;
      const fileWorker = new URL(voskWorkerUrl, document.baseURI).href;
      window.Worker = function (_url: string | URL, opts?: WorkerOptions) { return new NativeWorker(fileWorker, opts); } as unknown as typeof Worker;
      let model: Model;
      try { model = new Model(url, -1); } finally { window.Worker = NativeWorker; }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(t("prompter.voice.modelSlow"))), 180_000);
        model.on("load", (m) => { clearTimeout(timer); if (m.event === "load" && m.result) resolve(); else reject(new Error(t("prompter.voice.modelNotLoaded"))); });
        model.on("error", (m) => { clearTimeout(timer); reject(new Error(m.event === "error" ? m.error : t("prompter.voice.modelNotLoaded"))); });
      });
      return model;
    })();
    p.catch(() => models.delete(lang));
    models.set(lang, p);
  }
  return p;
}

export type HeardEvent = { partial?: string; final?: string };

export class VoiceEngine {
  status: VoiceStatus = { mic: "off", recognizer: "off" };
  onLevel: (db: number, dtMs: number) => void = () => {};
  onHeard: (e: HeardEvent) => void = () => {};
  onStatus: (s: VoiceStatus) => void = () => {};

  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;
  private stream: MediaStream | null = null;
  private ownStream: MediaStream | null = null;
  private recognizer: Recognizer | null = null;
  private config: VoiceConfig | null = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;
  private lastPartial = "";

  async start(config: VoiceConfig) {
    this.config = config;
    if (!this.unsubscribe) this.unsubscribe = subscribeStreams(() => { void this.attachMic(); });
    await this.attachMic();
    await this.configureRecognizer();
  }

  /** Change language, vocabulary or recognition on/off without reopening the mic. */
  async update(config: VoiceConfig) {
    const prev = this.config;
    if (!prev) return this.start(config);
    // same settings: keep the current object, so a recognizer still loading for it is not discarded
    if (prev.recognize === config.recognize && prev.lang === config.lang && prev.vocabulary.join(" ") === config.vocabulary.join(" ")) return;
    this.config = config;
    await this.configureRecognizer();
  }

  stop() {
    this.generation++;
    this.config = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.dropRecognizer();
    this.detach();
    this.setStatus({ mic: "off", recognizer: "off" });
  }

  private setStatus(patch: Partial<VoiceStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  private async attachMic() {
    if (!this.config) return;
    const published = getStream("mic");
    const wanted = published && published.getAudioTracks().length ? published : null;
    if (wanted && wanted === this.stream) return;
    if (!wanted && this.ownStream && this.stream === this.ownStream) return;
    const gen = ++this.generation;
    let stream = wanted;
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (e) {
        this.setStatus({ mic: "error", message: t("prompter.voice.noMic", { error: (e as Error).message }) });
        return;
      }
      if (gen !== this.generation || !this.config) { stream.getTracks().forEach((t) => t.stop()); return; }
    }
    this.detach();
    if (stream !== wanted) this.ownStream = stream;
    this.stream = stream;
    const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.ctx = ctx;
    this.source = ctx.createMediaStreamSource(stream);
    // ScriptProcessor keeps this module free of a separate worklet file; 1024 samples = 64 ms
    this.processor = ctx.createScriptProcessor(1024, 1, 1);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.processor.onaudioprocess = (ev) => {
      const data = ev.inputBuffer.getChannelData(0);
      this.onLevel(rmsDb(data), (data.length / ctx.sampleRate) * 1000);
      this.recognizer?.acceptWaveformFloat(new Float32Array(data), ctx.sampleRate);
    };
    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(ctx.destination);
    if (ctx.state === "suspended") void ctx.resume();
    this.setStatus({ mic: stream === wanted ? "processed" : "own", message: undefined });
    // a published mic replaces ours: let the device go
    if (stream === wanted && this.ownStream) { this.ownStream.getTracks().forEach((t) => t.stop()); this.ownStream = null; }
  }

  private detach() {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    if (this.processor) this.processor.onaudioprocess = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = this.source = this.processor = this.sink = null;
    // never stop the published stream's tracks: they belong to the audio module
    if (this.ownStream && (!this.config || this.stream === this.ownStream)) {
      this.ownStream.getTracks().forEach((t) => t.stop());
      this.ownStream = null;
    }
    this.stream = null;
  }

  private dropRecognizer() {
    try { this.recognizer?.remove(); } catch { /* the worker may be gone */ }
    this.recognizer = null;
    this.lastPartial = "";
  }

  private async configureRecognizer() {
    const config = this.config;
    this.dropRecognizer();
    if (!config?.recognize) { this.setStatus({ recognizer: "off" }); return; }
    this.setStatus({ recognizer: "loading", message: undefined });
    try {
      const model = await loadModel(config.lang);
      if (this.config !== config) return;
      // the script's words, each its own phrase, so they can come in any order; [unk] absorbs ad-libs
      const grammar = config.vocabulary.length ? JSON.stringify([...config.vocabulary, "[unk]"]) : undefined;
      const rec = new model.KaldiRecognizer(SAMPLE_RATE, grammar);
      rec.setWords(false);
      rec.on("partialresult", (m) => {
        if (m.event !== "partialresult") return;
        const text = m.result.partial;
        if (text === this.lastPartial) return;
        this.lastPartial = text;
        this.onHeard({ partial: text });
      });
      rec.on("result", (m) => {
        if (m.event !== "result") return;
        this.lastPartial = "";
        if (m.result.text) this.onHeard({ final: m.result.text });
      });
      rec.on("error", (m) => { if (m.event === "error") this.setStatus({ recognizer: "error", message: m.error }); });
      if (this.config !== config) { rec.remove(); return; }
      this.recognizer = rec;
      this.setStatus({ recognizer: "ready" });
    } catch (e) {
      if (this.config === config) this.setStatus({ recognizer: "error", message: (e as Error)?.message || t("prompter.voice.modelFailed") });
    }
  }
}

/** Start loading a model ahead of time (when voice tracking is picked) so Start is instant. */
export function preloadModel(lang: Lang) {
  void loadModel(lang).catch(() => {});
}
