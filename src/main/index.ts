import { app, BrowserWindow, nativeTheme, session, shell } from "electron";
import { join } from "node:path";
import { registerRecordIpc } from "./record";
import { enableLoopbackFeatures } from "./record/system-audio";
import { registerTeleprompterIpc } from "./teleprompter";
import { registerDraw } from "./draw";
import { registerUpdater } from "./updater";

/** Loads one of the renderer pages (dev server in dev, built file in production). `part` picks a view inside the page. */
export function loadPage(win: BrowserWindow, page: "index" | "teleprompter" | "draw", part?: string) {
  const dev = process.env.ELECTRON_RENDERER_URL;
  const q = part ? `?part=${part}` : "";
  return dev ? win.loadURL(`${dev}/${page}.html${q}`) : win.loadFile(join(__dirname, `../renderer/${page}.html`), part ? { query: { part } } : undefined);
}

export const preloadPath = () => join(__dirname, "../preload/index.mjs");

let main: BrowserWindow | null = null;

enableLoopbackFeatures();

function createMain() {
  main = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0a0a0b" : "#f3f4f8",
    title: "OpenTake",
    // backgroundThrottling off: a minimised window must keep feeding the recorder at full frame rate.
    webPreferences: { preload: preloadPath(), sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  main.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  loadPage(main, "index");
}

app.whenReady().then(() => {
  // Camera, mic and screen are the whole job of this app: grant media to our own pages.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media" || permission === "display-capture"));
  registerRecordIpc(() => main);
  registerTeleprompterIpc(() => main);
  registerDraw(() => main);
  registerUpdater();
  createMain();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createMain(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
