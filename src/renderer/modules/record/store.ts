import { create } from "zustand";
import type {
  BubbleLayout, ClickTrackingStatus, ExportProgress, FrameCrop, LoudnessTarget, OutputAspect, OutputQuality, RecordLayout, RecordMode, TakeInfo,
} from "@shared/types";
import { BACKGROUNDS, NO_CROP, isCustomBackground, normalizeCrop, outputSize } from "./layout-core";
import { DEFAULT_OVERLAYS, mergeOverlays, type OverlayLook } from "./overlays-core";

/** How a recording looks: frame, background, screen window, camera and overlays. Saved and swapped as a "look". */
export interface LookSettings extends OverlayLook {
  aspect: OutputAspect;
  quality: OutputQuality;
  customWidth: number;
  customHeight: number;
  bubble: BubbleLayout;
  padding: number;
  cornerRadius: number;
  screenScale: number;
  screenPosition: { x: number; y: number };
  screenShadow: number;
  screenBorder: number;
  screenBorderColor: string;
  crop: FrameCrop;
  backgroundId: string;
  bgColor: string;
  bgColor2: string;
  bgAngle: number;
  bgImage: string | null;
  bgBlur: number;
  /** camera-only takes: show the camera as a window over the background instead of edge to edge */
  cameraFramed: boolean;
}

export interface RecordSettings extends LookSettings {
  mode: RecordMode;
  fps: 30 | 60;
  sourceId: string | null;
  sourceName: string | null;
  displayId: string | null;
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

/** The standard look every reset comes back to. */
export const DEFAULT_LOOK: LookSettings = {
  aspect: "16:9",
  quality: 1080,
  customWidth: 1920,
  customHeight: 1080,
  bubble: { cx: 0.86, cy: 0.78, size: 0.3, shape: "circle", aspect: 4 / 3, radius: 0.18, border: 0, borderColor: "#ffffff", shadow: 0.6 },
  padding: 0.05,
  cornerRadius: 18,
  screenScale: 1,
  screenPosition: { x: 0, y: 0 },
  screenShadow: 0.6,
  screenBorder: 0,
  screenBorderColor: "#ffffff",
  crop: NO_CROP,
  backgroundId: "graphite",
  bgColor: "#1f2937",
  bgColor2: "#0b0b0c",
  bgAngle: 135,
  bgImage: null,
  bgBlur: 0,
  cameraFramed: false,
  ...DEFAULT_OVERLAYS,
};
export const LOOK_KEYS = Object.keys(DEFAULT_LOOK) as (keyof LookSettings)[];

const DEFAULTS: RecordSettings = {
  ...DEFAULT_LOOK,
  mode: "screen-camera",
  fps: 30,
  sourceId: null,
  sourceName: null,
  displayId: null,
  zoomEnabled: true,
  zoomScale: 1.8,
  countdown: true,
  isoTracks: true,
  autoExport: true,
  loudness: "-14",
  trimSilence: false,
};

const KEY = "take.record.settings";
/** the background picture is big, so it is saved on its own and only when it changes */
const IMAGE_KEY = "take.record.bgImage";
/** the logo is kept apart for the same reason */
const LOGO_KEY = "take.record.logoImage";

function load(): RecordSettings {
  try {
    const raw = localStorage.getItem(KEY);
    const image = localStorage.getItem(IMAGE_KEY);
    const logo = localStorage.getItem(LOGO_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<RecordSettings>;
      // the source id points at a window that may be gone: pick it again each session
      return {
        ...DEFAULTS, ...saved,
        bubble: { ...DEFAULTS.bubble, ...saved.bubble },
        crop: normalizeCrop(saved.crop),
        ...mergeOverlays(saved),
        bgImage: image || null,
        logoImage: logo || null,
        sourceId: null, sourceName: null, displayId: null,
      };
    }
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
useRecord.subscribe((s, prev) => {
  if (s.bgImage !== prev.bgImage) {
    try {
      if (s.bgImage) localStorage.setItem(IMAGE_KEY, s.bgImage);
      else localStorage.removeItem(IMAGE_KEY);
    } catch { /* too big or unavailable: the picture lasts this session */ }
  }
  if (s.logoImage !== prev.logoImage) {
    try {
      if (s.logoImage) localStorage.setItem(LOGO_KEY, s.logoImage);
      else localStorage.removeItem(LOGO_KEY);
    } catch { /* too big or unavailable: the logo lasts this session */ }
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const keep = Object.fromEntries(Object.keys(DEFAULTS).filter((k) => k !== "bgImage" && k !== "logoImage").map((k) => [k, s[k as keyof RecordSettings]]));
    try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* storage unavailable */ }
  }, 300);
});

export const isBusy = (s: RecordStatus) => s !== "idle";

// ---- saved looks ----

export interface SavedLook { name: string; look: LookSettings }
const LOOKS_KEY = "take.record.looks";

export function lookOf(s: LookSettings): LookSettings {
  return Object.fromEntries(LOOK_KEYS.map((k) => [k, s[k]])) as unknown as LookSettings;
}

export function loadLooks(): SavedLook[] {
  try {
    const raw = localStorage.getItem(LOOKS_KEY);
    const list = raw ? (JSON.parse(raw) as SavedLook[]) : [];
    return Array.isArray(list) ? list.filter((l) => l && typeof l.name === "string" && l.look) : [];
  } catch { return []; }
}

/** Saves the looks; false when storage refused them (a look with a big picture can be too large). */
export function storeLooks(list: SavedLook[]): boolean {
  try { localStorage.setItem(LOOKS_KEY, JSON.stringify(list)); return true; } catch { return false; }
}

/** Applies a look. The frame size only changes between takes, never while recording. */
export function applyLook(look: Partial<LookSettings>) {
  const s = useRecord.getState();
  const next: Partial<LookSettings> = { ...DEFAULT_LOOK, ...look, bubble: { ...DEFAULT_LOOK.bubble, ...look.bubble }, crop: normalizeCrop(look.crop), ...mergeOverlays(look) };
  if (isBusy(s.status)) { delete next.aspect; delete next.quality; delete next.customWidth; delete next.customHeight; }
  s.set(next);
}

// ---- the layout the compositor draws and the take records ----

export function currentLayout(s: RecordSettings = useRecord.getState()): RecordLayout {
  const size = outputSize(s.aspect, s.quality, { width: s.customWidth, height: s.customHeight });
  // without a background (or a camera-only take not set to a window) the picture fills the frame
  const none = s.backgroundId === "none" || (s.mode === "camera" && !s.cameraFramed);
  const bg = isCustomBackground(s.backgroundId) ? s.backgroundId : (BACKGROUNDS.find((b) => b.id === s.backgroundId) ?? BACKGROUNDS[0]).id;
  return {
    mode: s.mode,
    aspect: s.aspect,
    width: size.width,
    height: size.height,
    fps: s.fps,
    bubble: s.bubble,

    padding: none ? 0 : s.padding,
    cornerRadius: none ? 0 : s.cornerRadius,
    background: bg,
    zoom: { enabled: s.zoomEnabled, scale: s.zoomScale },
    screenScale: none ? 1 : s.screenScale,
    screenPosition: none ? { x: 0, y: 0 } : s.screenPosition,
    screenShadow: none ? 0 : s.screenShadow,
    screenBorder: none ? 0 : s.screenBorder,
    screenBorderColor: s.screenBorderColor,
    crop: normalizeCrop(s.crop),
  };
}
