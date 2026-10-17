// Typed wrappers over the preload bridge for the record channels.
import { IPC } from "@shared/ipc";
import type {
  ClickEvent, ClickTrackingStatus, CursorSample, ExportOptions, ExportProgress, KeyPress, RecordBeginRequest,
  RecordBeginResult, RecordChunk, RecordSave, RecordShortcut, ScreenSource, TakeInfo,
} from "@shared/types";

const t = () => window.take;

export const api = {
  sources: () => t().invoke(IPC.screenSources) as Promise<ScreenSource[]>,
  trackPointer: (displayId?: string) => t().invoke(IPC.clicksStart, displayId) as Promise<ClickTrackingStatus>,
  stopPointer: () => t().invoke(IPC.clicksStop) as Promise<void>,
  begin: (req: RecordBeginRequest) => t().invoke(IPC.recordBegin, req) as Promise<RecordBeginResult>,
  chunk: (c: RecordChunk) => t().invoke(IPC.recordChunk, c) as Promise<void>,
  save: (s: RecordSave) => t().invoke(IPC.saveRecording, s) as Promise<void>,
  takes: () => t().invoke(IPC.takesList) as Promise<TakeInfo[]>,
  deleteTake: (id: string) => t().invoke(IPC.takeDelete, id) as Promise<void>,
  revealTake: (id: string, file?: string) => t().invoke(IPC.takeReveal, id, file) as Promise<void>,
  openFolder: () => t().invoke(IPC.openRecordingsFolder) as Promise<void>,
  exportTake: (o: ExportOptions) => t().invoke(IPC.exportVideo, o) as Promise<string>,
  cancelExport: (id: string) => t().invoke(IPC.exportCancel, id) as Promise<boolean>,
  onClick: (cb: (e: ClickEvent) => void) => t().on(IPC.clickEvent, (e) => cb(e as ClickEvent)),
  onCursor: (cb: (s: CursorSample[]) => void) => t().on(IPC.cursorEvent, (s) => cb(s as CursorSample[])),
  onShortcut: (cb: (a: RecordShortcut) => void) => t().on(IPC.recordShortcut, (a) => cb(a as RecordShortcut)),
  onExportProgress: (cb: (p: ExportProgress) => void) => t().on(IPC.exportProgress, (p) => cb(p as ExportProgress)),
  keysStart: (showAll: boolean) => t().invoke(IPC.keysStart, { showAll }) as Promise<{ ok: boolean; reason?: string }>,
  keysStop: () => t().invoke(IPC.keysStop) as Promise<void>,
  onKeys: (cb: (p: KeyPress) => void) => t().on(IPC.keysEvent, (p) => cb(p as KeyPress)),
};

/** The preload bridge is missing in a plain browser tab (and in tests). */
export const hasBridge = () => typeof window !== "undefined" && !!window.take;
