// OWNED BY: ux. Closing the window while a take records or an export runs asks first: a take is
// stopped and saved before the app quits, an export is stopped (its half-written file removed).
import { app, ipcMain, type BrowserWindow } from "electron";
import { IPC } from "../shared/ipc";
import type { AppBusy } from "../shared/types";
import { ask } from "./dialogs";
import { cancelAllExports, exportsRunning } from "./record/export";

let busy: AppBusy = { recording: false, exporting: 0 };
let allowed = false;

/** Guards one window's close button (and Alt+F4, Cmd+Q, the taskbar's Close). */
export function guardClose(win: BrowserWindow) {
  win.on("close", (e) => {
    const exporting = Math.max(busy.exporting, exportsRunning());
    if (allowed || (!busy.recording && exporting === 0)) return;
    e.preventDefault();
    void confirmQuit(win, exporting);
  });
}

async function confirmQuit(win: BrowserWindow, exporting: number) {
  if (busy.recording) {
    const r = await ask(win, {
      message: "A take is recording",
      detail: "OpenTake stops the take and saves it before it quits.",
      buttons: ["Save the take and quit", "Keep recording"],
      defaultId: 1, cancelId: 1,
    });
    if (r !== 0) return;
    // the window stops and saves, then asks to quit (appQuitNow); if it cannot answer, the chunks already on disk are recovered next launch
    if (!win.isDestroyed()) win.webContents.send(IPC.appQuitRequest);
    setTimeout(() => quitNow(), 20_000);
    return;
  }
  const r = await ask(win, {
    message: exporting > 1 ? `${exporting} exports are running` : "An export is running",
    detail: "Quitting stops it. The take itself is safe, and you can export it again later.",
    buttons: ["Stop the export and quit", "Keep exporting"],
    defaultId: 1, cancelId: 1,
  });
  if (r !== 0) return;
  cancelAllExports();
  quitNow();
}

function quitNow() {
  allowed = true;
  app.quit();
}

export function registerQuitIpc() {
  ipcMain.on(IPC.appBusy, (_e, b: Partial<AppBusy> | undefined) => {
    busy = { recording: !!b?.recording, exporting: Math.max(0, Number(b?.exporting) || 0) };
  });
  ipcMain.on(IPC.appQuitNow, () => quitNow());
}
