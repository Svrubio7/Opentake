import { create } from "zustand";
import type {
  BubbleLayout, ClickTrackingStatus, ExportProgress, LoudnessTarget, OutputAspect, RecordLayout, RecordMode, TakeInfo,
} from "@shared/types";
import { BACKGROUNDS, outputSize } from "./layout-core";

export interface RecordSettings {
  mode: RecordMode;
  aspect: OutputAspect;
  fps: 30 | 60;
  sourceId: string | null;
  sourceName: string | null;
  displayId: string | null;
  bubble: BubbleLayout;
  padding: number;
  cornerRadius: number;
  backgroundId: string;
  zoomEnabled: boolean;
  zoomScale: number;
  countdown: boolean;
  isoTracks: boolean;
  autoExport: boolean;
  loudness: LoudnessTarget;
  trimSilence: boolean;
}

export type RecordStatus = "idle" | "countdown" | "recording" | "paused" | "stopping";

export interface RecordRuntime {
  status: RecordStatus;
  countdownValue: number;
  elapsedMs: number;
  takeId: string | null;
  error: string | null;
  notice: string | null;
  tracking: ClickTrackingStatus | null;
  micSource: "module" | "fallback" | "none" | null;
  cameraSource: "module" | "fallback" | "none" | null;
  takes: TakeInfo[];
  exports: Record<string, ExportProgress>;
}

const DEFAULTS: RecordSettings = {
  mode: "screen-camera",
  aspect: "16:9",
  fps: 30,
  sourceId: null,
  sourceName: null,
  displayId: null,
  bubble: { cx: 0.86, cy: 0.78, size: 0.3, shape: "circle" },
  padding: 0.05,
  cornerRadius: 18,
  backgroundId: "graphite",
  zoomEnabled: true,
  zoomScale: 1.8,
  countdown: true,
  isoTracks: true,
  autoExport: true,
  loudness: "-14",
  trimSilence: false,
};

const KEY = "take.record.settings";

function load(): RecordSettings {
  try {
    const raw = localStorage.getItem(KEY);
    // the source id points at a window that may be gone: pick it again each session
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw), sourceId: null, sourceName: null, displayId: null };
  } catch { /* storage unavailable */ }
  return DEFAULTS;
}

export const useRecord = create<RecordSettings & RecordRuntime & { set: (p: Partial<RecordSettings & RecordRuntime>) => void }>((set) => ({
  ...load(),
  status: "idle",
  countdownValue: 0,
  elapsedMs: 0,
  takeId: null,
  error: null,
  notice: null,
  tracking: null,
  micSource: null,
  cameraSource: null,
  takes: [],
  exports: {},
  set: (p) => set(p),
}));

let saveTimer: ReturnType<typeof setTimeout> | null = null;
useRecord.subscribe((s) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keep = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, s[k as keyof RecordSettings]]));
    try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* storage unavailable */ }
  }, 300);
});

export const isBusy = (s: RecordStatus) => s !== "idle";

export function currentLayout(s: RecordSettings = useRecord.getState()): RecordLayout {
  const size = outputSize(s.aspect);
  const bg = BACKGROUNDS.find((b) => b.id === s.backgroundId) ?? BACKGROUNDS[0];
  return {
    mode: s.mode,
    aspect: s.aspect,
    width: size.width,
    height: size.height,
    fps: s.fps,
    bubble: s.bubble,
    padding: s.backgroundId === "none" ? 0 : s.padding,
    cornerRadius: s.backgroundId === "none" ? 0 : s.cornerRadius,
    background: bg.id,
    zoom: { enabled: s.zoomEnabled, scale: s.zoomScale },
  };
}
