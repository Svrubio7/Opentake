import { app, BrowserWindow, nativeTheme, session, shell } from "electron";
import { join } from "node:path";
import { registerEditorIpc, registerMediaScheme } from "./editor";
import { registerRecordIpc } from "./record";
import { enableLoopbackFeatures } from "./record/system-audio";
import { registerTeleprompterIpc } from "./teleprompter";
import { registerDraw } from "./draw";
import { registerUpdater } from "./updater";
import { registerSettingsIpc } from "./settings";
import { guardClose, registerQuitIpc } from "./quit";
import { BACKGROUND_FLAG } from "../shared/assistant";
import { keepRunningWithoutWindows, registerAssistant, windowShown } from "./mcp/assistant";

/** Loads one of the renderer pages (dev server in dev, built file in production). `part` picks a view inside the page. */
export function loadPage(win: BrowserWindow, page: "index" | "teleprompter" | "draw" | "assistant", part?: string) {
  const dev = process.env.ELECTRON_RENDERER_URL;
  const q = part ? `?part=${part}` : "";
  return dev ? win.loadURL(`${dev}/${page}.html${q}`) : win.loadFile(join(__dirname, `../renderer/${page}.html`), part ? { query: { part } } : undefined);
}

export const preloadPath = () => join(__dirname, "../preload/index.mjs");

let main: BrowserWindow | null = null;
/** started by the assistant (the MCP server) with no window: see src/main/mcp/assistant.ts */
const background = process.argv.includes(BACKGROUND_FLAG);

// one copy at a time: a second launch brings the open window forward instead of fighting over the
// shortcuts and the recordings folder
const firstCopy = app.requestSingleInstanceLock();
if (!firstCopy) app.quit();
app.on("second-instance", (_e, argv) => {
  // the assistant asking for the app it is already talking to: nothing to show
  if (argv.includes(BACKGROUND_FLAG)) return;
  if (!main || main.isDestroyed()) { if (app.isReady()) createMain(); return; }
  if (main.isMinimized()) main.restore();
  main.show();
  main.focus();
});

enableLoopbackFeatures();
registerMediaScheme();

function createMain() {
  windowShown();
  if (process.platform === "darwin") app.dock?.show();
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
  guardClose(main);
  loadPage(main, "index");
}

app.whenReady().then(() => {
  if (!firstCopy) return;
  // Camera, mic and screen are the whole job of this app: grant media to our own pages.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media" || permission === "display-capture"));
  registerRecordIpc(() => main);
  registerTeleprompterIpc(() => main);
  registerDraw(() => main);
  registerUpdater();
  registerEditorIpc();
  registerSettingsIpc(() => main);
  registerQuitIpc();
  registerAssistant(() => main, { background });
  if (background && process.platform === "darwin") app.dock?.hide();
  if (!background) createMain();
  app.on("activate", () => { if (!main || main.isDestroyed()) createMain(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin" && !keepRunningWithoutWindows()) app.quit(); });
