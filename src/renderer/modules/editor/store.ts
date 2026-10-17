// Which take the editor or the export dialog has open, and the export choices (saved between sessions).
import { create } from "zustand";
import type { CaptionBurn, ExportOutput } from "@shared/types";

export interface ExportPrefs {
  /** the last frame, format and quality (captions are set apart, below) */
  output: Omit<ExportOutput, "captions">;
  /** how burned-in captions look; the editor's preview shows the same */
  captionLook: CaptionBurn;
  burnCaptions: boolean;
  kind: "composite" | "hires";
}

export const DEFAULT_PREFS: ExportPrefs = {
  output: { preset: "original", format: "mp4", fit: "fit", quality: { mode: "crf", crf: 18 }, width: 1920, height: 1080, gif: { fps: 15, width: 480 } },
  captionLook: { style: "clean", position: "bottom", margin: 0.08 },
  burnCaptions: false,
  kind: "composite",
};

const KEY = "take.editor.export";

function load(): ExportPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ExportPrefs>;
      return { ...DEFAULT_PREFS, ...p, output: { ...DEFAULT_PREFS.output, ...p.output }, captionLook: { ...DEFAULT_PREFS.captionLook, ...p.captionLook } };
    }
  } catch { /* storage unavailable */ }
  return DEFAULT_PREFS;
}

interface EditorState extends ExportPrefs {
  /** the take open in the editor */
  editing: string | null;
  /** the take the export dialog is open for */
  exporting: string | null;
  set: (p: Partial<EditorState>) => void;
}

export const useEditor = create<EditorState>((set) => ({ ...load(), editing: null, exporting: null, set: (p) => set(p) }));

useEditor.subscribe((s) => {
  const keep: ExportPrefs = { output: s.output, captionLook: s.captionLook, burnCaptions: s.burnCaptions, kind: s.kind };
  try { localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* storage unavailable */ }
});

export const openEditor = (takeId: string) => useEditor.getState().set({ editing: takeId });
export const openExport = (takeId: string) => useEditor.getState().set({ exporting: takeId });

/** The full export output from the saved choices. */
export const outputFrom = (p: ExportPrefs, hasCaptions: boolean): ExportOutput => ({ ...p.output, captions: p.burnCaptions && hasCaptions ? p.captionLook : null });
