// The computer sound switch: which setting applies to a mode, and the meter's numbers. Pure.
import type { RecordMode } from "@shared/types";
import { needsScreen } from "./layout-core";

export interface SystemAudioPrefs {
  /** screen takes: on by default (a demo usually has its sound) */
  systemAudio: boolean;
  /** camera-only takes: off by default */
  systemAudioCamera: boolean;
}

/** The setting the switch shows and changes for this mode. */
export const systemAudioKey = (mode: RecordMode): keyof SystemAudioPrefs => (needsScreen(mode) ? "systemAudio" : "systemAudioCamera");

export const systemAudioWanted = (mode: RecordMode, p: SystemAudioPrefs) => p[systemAudioKey(mode)];

/** Peak of one block of samples in dBFS (-100 for silence). */
export function peakDb(samples: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; }
  return peak > 0 ? Math.max(-100, 20 * Math.log10(peak)) : -100;
}

/** Meter fill 0..1 over a -60..0 dB scale. */
export const meterFill = (db: number) => Math.max(0, Math.min(1, (db + 60) / 60));

/** The computer sound's own track: Opus in WebM (extensionFor reads anything not MP4 as webm). */
export function pickAudioMime(isSupported: (m: string) => boolean): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm"]) if (isSupported(m)) return m;
  return "";
}
