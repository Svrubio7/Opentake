// OWNED BY: teleprompter agent. The always-on-top prompter window and the state relay.
// The main window's panel is the controller: it sends the whole PrompterState, main keeps the
// latest copy (so a freshly opened prompter starts in sync) and forwards it to the prompter.
// Commands from the prompter's keys or the global shortcuts go back to the controller.
import { app, BrowserWindow, globalShortcut, ipcMain, screen, type Rectangle } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import { loadPage, preloadPath } from "./index";

export interface PrompterWindowOptions {
  /** 0.2..1, the whole window (text included) */
  opacity?: number;
  /** mouse passes through to whatever is under the prompter */
  clickThrough?: boolean;
  /** keep the prompter out of screen recordings and screen shares */
  hideFromCapture?: boolean;
  snap?: "top-center" | "center";
}

// Global shortcuts work while another app (or the recorder) has focus.
const SHORTCUTS: [string, unknown][] = [
  ["CommandOrControl+Alt+Space", { type: "toggle" }],
  ["CommandOrControl+Alt+Up", { type: "faster" }],
  ["CommandOrControl+Alt+Down", { type: "slower" }],
  ["CommandOrControl+Alt+Right", { type: "next-sentence" }],
  ["CommandOrControl+Alt+Left", { type: "prev-sentence" }],
  ["CommandOrControl+Alt+Home", { type: "restart" }],
  ["CommandOrControl+Alt+T", { type: "click-through" }],
];

let prompter: BrowserWindow | null = null;
let lastState: unknown = null;
const hookedMains = new WeakSet<BrowserWindow>();
/** the in-window overlay is showing: shortcuts stay on even with no prompter window */
let overlayShortcuts = false;
let options: Required<Omit<PrompterWindowOptions, "snap">> = { opacity: 1, clickThrough: false, hideFromCapture: true };

const boundsFile = () => join(app.getPath("userData"), "prompter-window.json");

function savedBounds(): Rectangle | null {
  try {
    const b = JSON.parse(readFileSync(boundsFile(), "utf8")) as Rectangle;
    // only if it still lands on a connected display
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y >= a.y - 10 && b.y < a.y + a.height - 40;
    });
    return visible ? b : null;
  } catch {
    return null;
  }
}

function saveBounds() {
  if (!prompter || prompter.isDestroyed()) return;
  try { writeFileSync(boundsFile(), JSON.stringify(prompter.getBounds())); } catch { /* not worth failing over */ }
}

/** A strip at the top centre of the display, so the reader's eyes stay near a top-mounted webcam. */
function snapBounds(where: "top-center" | "center", display = screen.getPrimaryDisplay()): Rectangle {
  const a = display.workArea;
  const width = Math.round(Math.min(a.width * 0.5, 1100));
  const height = Math.round(Math.min(a.height * 0.32, 420));
  const x = Math.round(a.x + (a.width - width) / 2);
  const y = where === "top-center" ? a.y : Math.round(a.y + (a.height - height) / 2);
  return { x, y, width, height };
}

function applyOptions() {
  if (!prompter || prompter.isDestroyed()) return;
  prompter.setOpacity(Math.max(0.2, Math.min(1, options.opacity)));
  prompter.setIgnoreMouseEvents(options.clickThrough, { forward: true });
  prompter.setContentProtection(options.hideFromCapture);
  prompter.webContents.send(IPC.prompterWindowStatus, { open: true, ...options });
}

function registerShortcuts(getMain: () => BrowserWindow | null) {
  const failed: string[] = [];
  for (const [accel, cmd] of SHORTCUTS) {
    if (globalShortcut.isRegistered(accel)) continue;
    const ok = globalShortcut.register(accel, () => getMain()?.webContents.send(IPC.prompterCommand, cmd));
    if (!ok) failed.push(accel);
  }
  return failed;
}

function unregisterShortcuts() {
  for (const [accel] of SHORTCUTS) globalShortcut.unregister(accel);
}

function sendStatus(getMain: () => BrowserWindow | null, extra: Record<string, unknown> = {}) {
  getMain()?.webContents.send(IPC.prompterWindowStatus, { open: !!prompter && !prompter.isDestroyed(), ...options, ...extra });
}

function openPrompter(getMain: () => BrowserWindow | null) {
  if (prompter && !prompter.isDestroyed()) { prompter.showInactive(); return; }
  const bounds = savedBounds() ?? snapBounds("top-center");
  prompter = new BrowserWindow({
    ...bounds,
    minWidth: 320,
    minHeight: 140,
    frame: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    fullscreenable: false,
    backgroundColor: "#000000",
    title: "OpenTake Prompter",
    show: false,
    webPreferences: { preload: preloadPath(), sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  // above full-screen apps too
  prompter.setAlwaysOnTop(true, "screen-saver");
  prompter.setVisibleOnAllWorkspaces(true);
  const win = prompter;
  win.once("ready-to-show", () => { win.showInactive(); applyOptions(); });
  win.webContents.on("did-finish-load", () => {
    if (lastState) win.webContents.send(IPC.prompterState, lastState);
    applyOptions();
  });
  win.on("moved", saveBounds);
  win.on("resized", saveBounds);
  win.on("closed", () => {
    prompter = null;
    if (!overlayShortcuts) unregisterShortcuts();
    sendStatus(getMain);
  });
  const main = getMain();
  if (main && !hookedMains.has(main)) {
    hookedMains.add(main);
    main.once("closed", () => { if (prompter && !prompter.isDestroyed()) prompter.close(); });
  }
  loadPage(win, "teleprompter");
  const failed = registerShortcuts(getMain);
  sendStatus(getMain, { shortcutsFailed: failed });
}

export function registerTeleprompterIpc(getMain: () => BrowserWindow | null) {
  ipcMain.handle(IPC.prompterOpen, () => { openPrompter(getMain); return true; });
  ipcMain.handle(IPC.prompterClose, () => { if (prompter && !prompter.isDestroyed()) prompter.close(); return true; });

  ipcMain.handle(IPC.prompterWindow, (_e, opts: PrompterWindowOptions) => {
    if (typeof opts?.opacity === "number") options.opacity = opts.opacity;
    if (typeof opts?.clickThrough === "boolean") options.clickThrough = opts.clickThrough;
    if (typeof opts?.hideFromCapture === "boolean") options.hideFromCapture = opts.hideFromCapture;
    if (prompter && !prompter.isDestroyed() && opts?.snap) {
      const display = screen.getDisplayMatching(prompter.getBounds());
      prompter.setBounds(snapBounds(opts.snap, display), true);
      saveBounds();
    }
    applyOptions();
    sendStatus(getMain);
    return { open: !!prompter, ...options };
  });

  // controller -> prompter
  ipcMain.on(IPC.prompterState, (e, state: unknown) => {
    if (e.sender !== getMain()?.webContents) return;
    lastState = state;
    if (prompter && !prompter.isDestroyed()) prompter.webContents.send(IPC.prompterState, state);
  });

  ipcMain.handle(IPC.prompterShortcuts, (_e, enable: boolean) => {
    overlayShortcuts = !!enable;
    if (overlayShortcuts) return { shortcutsFailed: registerShortcuts(getMain) };
    if (!prompter || prompter.isDestroyed()) unregisterShortcuts();
    return { shortcutsFailed: [] };
  });

  // the prompter asks for the latest state once its listeners are up (a push at load can arrive first)
  ipcMain.handle(IPC.prompterState, () => lastState);

  // prompter -> controller
  ipcMain.on(IPC.prompterCommand, (e, cmd: unknown) => {
    if (prompter && e.sender === prompter.webContents) getMain()?.webContents.send(IPC.prompterCommand, cmd);
  });
  ipcMain.on(IPC.prompterPosition, (e, pos: unknown) => {
    if (prompter && e.sender === prompter.webContents) getMain()?.webContents.send(IPC.prompterPosition, pos);
  });

  app.on("will-quit", unregisterShortcuts);
}
