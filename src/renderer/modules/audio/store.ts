// UI state for the Mic panel. Meters do not live here (they update 20 times a second and are drawn
// straight from the engine); this holds what React renders: devices, status, settings.
import { create } from "zustand";
import { sanitizeSettings, type ChainSettings, type NsMode } from "./audio-core";

const KEY_DEVICE = "take.audio.deviceId";
const KEY_SETTINGS = "take.audio.settings";
const KEY_AGC = "take.audio.agcStart";

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function write(key: string, value: string | null) {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* storage off */ }
}
function readSettings(): ChainSettings {
  try { return sanitizeSettings(JSON.parse(read(KEY_SETTINGS) ?? "null")); } catch { return sanitizeSettings(null); }
}

export interface AudioState {
  status: "idle" | "starting" | "running" | "error";
  error: string | null;
  devices: { id: string; label: string }[];
  /** The mic the person picked (null = system default). */
  deviceId: string | null;
  activeDeviceId: string | null;
  activeLabel: string;
  settings: ChainSettings;
  /** Where the AGC starts after a Mic check, so recording does not begin with a slow climb. */
  agcStartGainDb: number;
  nsRunning: NsMode;
  nsAvailable: { rnnoise: boolean; speex: boolean };
  monitor: boolean;
  set: (patch: Partial<AudioState>) => void;
}

export const useAudioStore = create<AudioState>((set) => ({
  status: "idle",
  error: null,
  devices: [],
  deviceId: read(KEY_DEVICE),
  activeDeviceId: null,
  activeLabel: "",
  settings: readSettings(),
  agcStartGainDb: Number(read(KEY_AGC) ?? 0) || 0,
  nsRunning: "off",
  nsAvailable: { rnnoise: false, speex: false },
  monitor: false,
  set: (patch) => set(patch),
}));

// Persist the choices that should survive a restart.
useAudioStore.subscribe((s, prev) => {
  if (s.deviceId !== prev.deviceId) write(KEY_DEVICE, s.deviceId);
  if (s.settings !== prev.settings) write(KEY_SETTINGS, JSON.stringify(s.settings));
  if (s.agcStartGainDb !== prev.agcStartGainDb) write(KEY_AGC, String(s.agcStartGainDb));
});
