// Typed wrappers over the preload bridge for the editor channels.
import { IPC } from "@shared/ipc";
import type { EditorTake, TakeCaptions, TakeEdit, TakePeaks } from "@shared/types";

const t = () => window.take;

export const editorApi = {
  open: (takeId: string) => t().invoke(IPC.editorOpen, takeId) as Promise<EditorTake>,
  saveEdit: (takeId: string, edit: TakeEdit, durationMs: number) => t().invoke(IPC.editorSaveEdit, takeId, edit, durationMs) as Promise<TakeEdit | null>,
  saveCaptions: (takeId: string, captions: TakeCaptions) => t().invoke(IPC.editorSaveCaptions, takeId, captions) as Promise<TakeCaptions | null>,
  peaks: (takeId: string) => t().invoke(IPC.editorPeaks, takeId) as Promise<TakePeaks>,
  pcm: (takeId: string) => t().invoke(IPC.editorPcm, takeId) as Promise<Uint8Array>,
  captionFiles: (takeId: string) => t().invoke(IPC.editorCaptionFiles, takeId) as Promise<string[]>,
};
