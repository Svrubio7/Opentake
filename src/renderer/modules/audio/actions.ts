// Everything the UI can change goes through here: the store for React, the engine for sound.
import { applyPreset, type ChainSettings, type PresetId } from "./audio-core";
import { getEngine } from "./engine";
import { useAudioStore } from "./store";

export function applySettings(next: ChainSettings) {
  useAudioStore.getState().set({ settings: next });
  getEngine().applySettings(next);
}

type Stage = Exclude<keyof ChainSettings, "preset" | "inputGainDb">;

/** Changes one stage by hand. Any manual move turns the preset label into "custom". */
export function patchStage<K extends Stage>(stage: K, patch: Partial<ChainSettings[K]>) {
  const s = useAudioStore.getState().settings;
  applySettings({ ...s, preset: "custom", [stage]: { ...s[stage], ...patch } });
}

export function setInputGain(db: number) {
  applySettings({ ...useAudioStore.getState().settings, inputGainDb: db });
}

export function choosePreset(id: PresetId) {
  applySettings(applyPreset(id, useAudioStore.getState().settings));
}

export function selectDevice(id: string | null) {
  useAudioStore.getState().set({ deviceId: id });
  void getEngine().open(id);
}

export function setMonitor(on: boolean) {
  useAudioStore.getState().set({ monitor: on });
  getEngine().setMonitor(on);
}

export function retry() {
  const engine = getEngine();
  if (!engine.ctx) void engine.start();
  else void engine.open(useAudioStore.getState().deviceId);
}
