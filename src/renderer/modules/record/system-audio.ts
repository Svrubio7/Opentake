// The computer's own sound: a loopback capture (main answers getDisplayMedia with it), a level, a
// meter, and the mix of that sound with the processed mic for the composite recording.
// Nothing here plays to the speakers, so the capture never hears itself.
import { create } from "zustand";
import { IPC } from "@shared/ipc";
import type { SystemAudioSupport } from "@shared/types";
import { t } from "../../../shared/i18n";
import { hasBridge } from "./api";
import { useRecord } from "./store";
import { peakDb } from "./system-audio-core";

export type SystemSoundStatus = "off" | "starting" | "on" | "unsupported" | "failed";

export const useSystemSound = create<{ status: SystemSoundStatus; reason: string | null; set: (p: Partial<{ status: SystemSoundStatus; reason: string | null }>) => void }>((set) => ({
  status: "off",
  reason: null,
  set: (p) => set(p),
}));

export interface TakeAudio {
  /** mic and computer sound together, for the composite */
  mixed: MediaStreamTrack;
  /** the computer sound alone, for its own track */
  system: MediaStreamTrack;
  dispose: () => void;
}

let support: Promise<SystemAudioSupport> | null = null;
export function systemAudioSupport(): Promise<SystemAudioSupport> {
  if (!hasBridge()) return Promise.resolve({ supported: false, reason: t("record.sys.needsApp") });
  support ??= (window.take.invoke(IPC.systemAudioSupport) as Promise<SystemAudioSupport>).catch(() => ({ supported: false, reason: t("record.sys.checkFailed") }));
  return support;
}

/** Mutes OpenTake's own playback (the Listen monitor, previews) so a take does not record it twice. */
export async function muteOwnAudio(muted: boolean) {
  if (hasBridge()) await window.take.invoke(IPC.muteOwnAudio, muted).catch(() => {});
}

class SystemSound {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  /** the capture's own picture, unused, stopped only when the sound closes */
  private idleVideo: MediaStreamTrack[] = [];
  private source: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private block = new Float32Array(1024);
  private users = 0;
  private opening: Promise<boolean> | null = null;
  /** when the capture last opened (performance.now()), -Infinity before */
  openedAt = -Infinity;
  private level = useRecord.getState().systemAudioLevel;

  constructor() {
    useRecord.subscribe((s, prev) => { if (s.systemAudioLevel !== prev.systemAudioLevel) this.setLevel(s.systemAudioLevel); });
  }

  /** Starts the capture for one user (the panel meter, a take). True when sound is coming in. */
  acquire(): Promise<boolean> {
    this.users++;
    return this.ensureOpen();
  }

  release() {
    this.users = Math.max(0, this.users - 1);
    if (this.users === 0) this.close();
  }

  get live() { return !!this.stream?.getAudioTracks().some((t) => t.readyState === "live"); }

  private ensureOpen(): Promise<boolean> {
    if (this.live) return Promise.resolve(true);
    this.opening ??= this.open().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async open(): Promise<boolean> {
    const st = useSystemSound.getState();
    const sup = await systemAudioSupport();
    if (!sup.supported) { st.set({ status: "unsupported", reason: sup.reason ?? null }); return false; }
    st.set({ status: "starting", reason: null });
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: { width: 320, height: 180, frameRate: 1 } });
      // the picture comes from the screen capture; this one only carries the sound. Its tiny 1 fps
      // picture is kept until the sound closes: stopping it tore the capture down while a take's
      // recorders were starting, and the camera track lost ~0.5 s of picture at the start.
      this.idleVideo = stream.getVideoTracks();
      this.idleVideo.forEach((t) => { t.enabled = false; stream.removeTrack(t); });
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("no sound track");
      if (this.users === 0) { track.stop(); this.stopIdleVideo(); st.set({ status: "off" }); return false; }
      const ctx = this.ctx ?? new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      this.ctx = ctx;
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      this.stream = stream;
      this.source = new MediaStreamAudioSourceNode(ctx, { mediaStream: stream });
      this.gain = new GainNode(ctx, { gain: this.level });
      this.analyser = new AnalyserNode(ctx, { fftSize: this.block.length });
      this.source.connect(this.gain).connect(this.analyser);
      track.addEventListener("ended", () => {
        if (this.stream !== stream) return;
        this.close();
        useSystemSound.getState().set({ status: "failed", reason: t("record.sys.stopped") });
      });
      this.openedAt = performance.now();
      st.set({ status: "on", reason: null });
      return true;
    } catch (e) {
      this.stopIdleVideo();
      console.warn("[record] computer sound unavailable", e);
      st.set({ status: "failed", reason: t("record.sys.failed") });
      return false;
    }
  }

  private stopIdleVideo() {
    this.idleVideo.forEach((t) => t.stop());
    this.idleVideo = [];
  }

  private close() {
    this.stopIdleVideo();
    this.source?.disconnect();
    this.gain?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.source = null; this.gain = null; this.analyser = null;
    const st = useSystemSound.getState();
    if (st.status === "on" || st.status === "starting") st.set({ status: "off" });
  }

  /** Level as a gain, 0 to 2. */
  setLevel(gain: number) {
    this.level = gain;
    if (this.ctx && this.gain) this.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.03);
  }

  /** The peak of the last block after the level, in dBFS. */
  peakDb(): number {
    if (!this.analyser) return -100;
    this.analyser.getFloatTimeDomainData(this.block);
    return peakDb(this.block);
  }

  /**
   * The take's sound: the mic plus the computer sound in one track, and the computer sound on its own.
   * `delayMs` delays the mixed track inside this graph (a delayed take's composite), never the other.
   */
  mix(mic: MediaStreamTrack[], delayMs = 0): TakeAudio | null {
    const ctx = this.ctx, gain = this.gain;
    if (!ctx || !gain || !this.live) return null;
    const mixDest = new MediaStreamAudioDestinationNode(ctx);
    const sysDest = new MediaStreamAudioDestinationNode(ctx);
    const delay = delayMs > 0 ? new DelayNode(ctx, { maxDelayTime: delayMs / 1000 + 1, delayTime: delayMs / 1000 }) : null;
    delay?.connect(mixDest);
    const into = delay ?? mixDest;
    gain.connect(into);
    gain.connect(sysDest);
    const micSources = mic.map((t) => {
      const s = new MediaStreamAudioSourceNode(ctx, { mediaStream: new MediaStream([t]) });
      s.connect(into);
      return s;
    });
    return {
      mixed: mixDest.stream.getAudioTracks()[0],
      system: sysDest.stream.getAudioTracks()[0],
      dispose: () => {
        micSources.forEach((s) => s.disconnect());
        try { gain.disconnect(into); gain.disconnect(sysDest); } catch { /* the capture already closed */ }
        delay?.disconnect();
        mixDest.stream.getTracks().forEach((t) => t.stop());
        sysDest.stream.getTracks().forEach((t) => t.stop());
      },
    };
  }
}

let instance: SystemSound | null = null;
export const systemSound = () => (instance ??= new SystemSound());
