import { app, desktopCapturer, globalShortcut, ipcMain, shell, type BrowserWindow } from "electron";
import { mkdir } from "node:fs/promises";
import { IPC } from "../shared/ipc";
import type {
  ExportOptions, RecordBeginRequest, RecordChunk, RecordSave, RecordShortcut, ScreenSource,
} from "../shared/types";
import { diskSpace } from "./record/disk";
import { cancelExport, exportTake } from "./record/export";
import { validTakeId } from "./record/ffmpeg-core";
import { startKeys, stopKeys } from "./record/keys";
import { shutdownPointer, startPointer, stopPointer } from "./record/pointer";
import { registerSystemAudioIpc } from "./record/system-audio";
import { appendChunk, beginTake, forgetTake, listTakes, recordingsRoot, saveTake, takeDir } from "./record/takes";

// OWNED BY: record agent. Screen sources, global click tracking, saving, ffmpeg export.

const SHORTCUTS: Record<string, RecordShortcut> = {
  "CommandOrControl+Shift+R": "toggle",
  "CommandOrControl+Shift+P": "pause",
  "CommandOrControl+Shift+1": "scene-camera",
  "CommandOrControl+Shift+2": "scene-screen-camera",
  "CommandOrControl+Shift+3": "scene-screen",
  "CommandOrControl+Shift+L": "lower-third",
};

export function registerRecordIpc(getMain: () => BrowserWindow | null) {
  const send = (channel: string, ...args: unknown[]) => {
    const w = getMain();
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  };

  // Our own picker in the panel (thumbnails), then the renderer captures the chosen id with
  // getUserMedia chromeMediaSource "desktop": no system dialog, full resolution and frame rate.
  ipcMain.handle(IPC.screenSources, async (): Promise<ScreenSource[]> => {
    const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 480, height: 270 }, fetchWindowIcons: false });
    const ownTitle = getMain()?.getTitle();
    return sources
      .filter((s) => s.name !== ownTitle || s.id.startsWith("screen:"))
      .map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL(), displayId: s.display_id || undefined }))
      .sort((a, b) => Number(b.id.startsWith("screen:")) - Number(a.id.startsWith("screen:")));
  });

  ipcMain.handle(IPC.clicksStart, (e, displayId?: string) => startPointer(e.sender, typeof displayId === "string" ? displayId : undefined));
  ipcMain.handle(IPC.clicksStop, () => { stopPointer(); });
  ipcMain.handle(IPC.keysStart, (e, opts?: { showAll?: boolean }) => startKeys(e.sender, { showAll: !!opts?.showAll }));
  ipcMain.handle(IPC.keysStop, () => { stopKeys(); });

  ipcMain.handle(IPC.recordBegin, async (e, req: RecordBeginRequest) => {
    // a minimized or covered window must keep compositing while you record another app
    e.sender.setBackgroundThrottling(false);
    return beginTake(req);
  });
  ipcMain.handle(IPC.recordChunk, (_e, c: RecordChunk) => appendChunk(c.takeId, c.track, c.data));
  ipcMain.handle(IPC.saveRecording, async (e, s: RecordSave) => {
    await saveTake(s.takeId, s.final, s.durationMs, s.timeline);
    if (s.final) e.sender.setBackgroundThrottling(true);
  });

  ipcMain.handle(IPC.takesList, () => listTakes());
  ipcMain.handle(IPC.takeDelete, async (_e, id: string) => {
    const dir = takeDir(id);
    cancelExport(id);
    await shell.trashItem(dir); // to the Recycle Bin, never a hard delete
    forgetTake(id);
  });
  ipcMain.handle(IPC.takeReveal, async (_e, id: string, file?: string) => {
    if (file && typeof file === "string" && file.startsWith(takeDir(id))) shell.showItemInFolder(file);
    else await shell.openPath(takeDir(id));
  });
  ipcMain.handle(IPC.openRecordingsFolder, async () => {
    await mkdir(recordingsRoot(), { recursive: true });
    await shell.openPath(recordingsRoot());
  });

  ipcMain.handle(IPC.diskSpace, () => diskSpace());
  registerSystemAudioIpc();

  ipcMain.handle(IPC.exportVideo, (_e, o: ExportOptions) => {
    if (!validTakeId(o?.takeId)) throw new Error("bad take id");
    return exportTake(o, (p) => send(IPC.exportProgress, p));
  });
  ipcMain.handle(IPC.exportCancel, (_e, id: string) => cancelExport(id));

  for (const [accel, action] of Object.entries(SHORTCUTS)) {
    if (!globalShortcut.register(accel, () => send(IPC.recordShortcut, action))) {
      console.warn(`[record] could not register ${accel} (another app holds it)`);
    }
  }
  app.on("will-quit", () => {
    for (const accel of Object.keys(SHORTCUTS)) globalShortcut.unregister(accel);
    shutdownPointer();
  });
}
