// Captions for the assistant, made in a hidden window that runs the editor's recognizer (Vosk needs a
// renderer: a web worker, WebAssembly and the model files). One job at a time; the window opens for a
// job and closes after it, muted and never shown.
import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "../../shared/ipc";
import type { CaptionLang, CaptionLine } from "../../shared/types";
import { loadPage, preloadPath } from "../index";

interface Running { jobId: string; resolve: (lines: CaptionLine[]) => void; reject: (e: Error) => void; progress: (stage: string, ratio: number | null) => void }

let win: BrowserWindow | null = null;
let ready: Promise<void> | null = null;
let current: Running | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function registerTranscriber() {
  ipcMain.on(IPC.assistantWorkerProgress, (e, p: { jobId: string; stage: string; ratio: number | null }) => {
    if (e.sender === win?.webContents && current?.jobId === p.jobId) current.progress(p.stage, p.ratio);
  });
  ipcMain.handle(IPC.assistantWorkerDone, (e, r: { jobId: string; lines?: CaptionLine[]; error?: string }) => {
    if (e.sender !== win?.webContents || current?.jobId !== r.jobId) return;
    if (r.error) current.reject(new Error(r.error));
    else current.resolve(r.lines ?? []);
  });
}

function open(): Promise<void> {
  if (win && !win.isDestroyed() && ready) return ready;
  win = new BrowserWindow({
    show: false, width: 320, height: 240, skipTaskbar: true, title: "OpenTake Assistant",
    webPreferences: { preload: preloadPath(), sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  win.webContents.setAudioMuted(true);
  const w = win;
  ready = new Promise<void>((resolve, reject) => {
    const onReady = (e: Electron.IpcMainEvent) => { if (e.sender === w.webContents) { ipcMain.off(IPC.assistantWorkerReady, onReady); resolve(); } };
    ipcMain.on(IPC.assistantWorkerReady, onReady);
    w.webContents.once("did-fail-load", (_e, _c, desc) => reject(new Error(`The captions window did not load: ${desc}`)));
    w.on("closed", () => { ipcMain.off(IPC.assistantWorkerReady, onReady); reject(new Error("The captions window closed")); });
  });
  w.on("closed", () => { if (win === w) { win = null; ready = null; } current?.reject(new Error("The captions window closed")); });
  void loadPage(w, "assistant");
  return ready;
}

/** Words to caption lines for one take, in the hidden window. Jobs wait their turn. */
export function transcribeTake(jobId: string, takeId: string, lang: CaptionLang, progress: Running["progress"]): Promise<CaptionLine[]> {
  const run = async () => {
    await open();
    try {
      return await new Promise<CaptionLine[]>((resolve, reject) => {
        current = { jobId, resolve, reject, progress };
        win!.webContents.send(IPC.assistantWorkerJob, { jobId, takeId, lang });
      });
    } finally {
      current = null;
      // nothing waits for the model between jobs: the window goes (Vosk keeps the model cached)
      if (win && !win.isDestroyed()) win.destroy();
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}
