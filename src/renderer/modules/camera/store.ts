// Camera settings (remembered in localStorage) and live engine state, in one zustand store.
import { create } from "zustand";
import {
  AUTO_KEYS, NEUTRAL, type Adjust, type AdjustKey, type AutoKey, type AutoValues, type Histogram, type LightingReport, type LookId,
} from "./camera-core";
import type { BgMode } from "./gl";

export interface CameraSettings {
  enabled: boolean;
  deviceId: string | null;
  /** "1920x1080"; null = the highest the device offers */
  resolution: string | null;
  fps: number;
  look: LookId;
  lookAmount: number;
  auto: boolean;
  autoKeys: Record<AutoKey, boolean>;
  manual: Adjust;
  bgMode: BgMode;
  bgBlur: number;
  bgColor: string;
  mirrorPreview: boolean;
  mirrorRecording: boolean;
  zoom: number;
  autoFrame: boolean;
}

export type CameraStatus = "idle" | "starting" | "live" | "denied" | "nocamera" | "busy" | "error" | "off";
export type MlStatus = "off" | "loading" | "ready" | "error";

export interface CameraLive {
  status: CameraStatus;
  error: string | null;
  devices: { deviceId: string; label: string }[];
  resOptions: string[];
  fpsOptions: number[];
  actual: { w: number; h: number; fps: number } | null;
  outFps: number;
  autoNow: AutoValues;
  report: LightingReport | null;
  hist: Histogram | null;
  faceFound: boolean;
  segStatus: MlStatus;
  faceStatus: MlStatus;
  /** downscaled JPEG data URL of the chosen background picture */
  bgImage: string | null;
}

const KEY = "take.camera.v1";
const BG_KEY = "take.camera.bg";

export const DEFAULT_SETTINGS: CameraSettings = {
  enabled: true,
  deviceId: null,
  resolution: null,
  fps: 30,
  look: "natural",
  lookAmount: 1,
  auto: true,
  autoKeys: { exposure: true, shadows: true, highlights: true, temperature: true, tint: true },
  manual: { ...NEUTRAL },
  bgMode: "none",
  bgBlur: 0.6,
  bgColor: "#1b1b1e",
  mirrorPreview: true,
  mirrorRecording: false,
  zoom: 1,
  autoFrame: false,
};

function load(): CameraSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const s = JSON.parse(raw) as Partial<CameraSettings>;
    return {
      ...DEFAULT_SETTINGS, ...s,
      autoKeys: { ...DEFAULT_SETTINGS.autoKeys, ...s.autoKeys },
      manual: { ...NEUTRAL, ...s.manual },
    };
  } catch { return DEFAULT_SETTINGS; }
}
function loadBg(): string | null {
  try { return localStorage.getItem(BG_KEY); } catch { return null; }
}

type Store = CameraSettings & CameraLive & {
  set: (p: Partial<CameraSettings>) => void;
  setLive: (p: Partial<CameraLive>) => void;
  /** a slider was touched: that parameter becomes manual */
  setManual: (k: AdjustKey, v: number) => void;
  backToAuto: (k: AutoKey) => void;
  resetLook: () => void;
  setBgImage: (dataUrl: string | null) => void;
};

export const useCamera = create<Store>()((set, get) => ({
  ...load(),
  status: "idle",
  error: null,
  devices: [],
  resOptions: [],
  fpsOptions: [30, 60],
  actual: null,
  outFps: 0,
  autoNow: { exposure: 0, shadows: 0, highlights: 0, temperature: 0, tint: 0 },
  report: null,
  hist: null,
  faceFound: false,
  segStatus: "off",
  faceStatus: "off",
  bgImage: loadBg(),
  set: (p) => set(p),
  setLive: (p) => set(p),
  setManual: (k, v) => {
    const s = get();
    const autoKeys = (AUTO_KEYS as readonly string[]).includes(k) ? { ...s.autoKeys, [k]: false } : s.autoKeys;
    set({ manual: { ...s.manual, [k]: v }, autoKeys });
  },
  backToAuto: (k) => set({ autoKeys: { ...get().autoKeys, [k]: true }, manual: { ...get().manual, [k]: NEUTRAL[k] } }),
  resetLook: () => set({
    manual: { ...NEUTRAL },
    autoKeys: { ...DEFAULT_SETTINGS.autoKeys },
    auto: true,
    lookAmount: 1,
  }),
  setBgImage: (dataUrl) => {
    set({ bgImage: dataUrl });
    try {
      if (dataUrl) localStorage.setItem(BG_KEY, dataUrl); else localStorage.removeItem(BG_KEY);
    } catch { /* too big for storage: kept for this session only */ }
  },
}));

export function settingsOf(s: CameraSettings): CameraSettings {
  const out = {} as Record<string, unknown>;
  for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = (s as unknown as Record<string, unknown>)[k];
  return out as unknown as CameraSettings;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
useCamera.subscribe((s, prev) => {
  const changed = (Object.keys(DEFAULT_SETTINGS) as (keyof CameraSettings)[]).some((k) => s[k] !== prev[k]);
  if (!changed) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(settingsOf(useCamera.getState()))); } catch { /* storage unavailable */ }
  }, 250);
});
