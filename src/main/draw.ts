// OWNED BY: shell agent. Drawing on the screen: a transparent window over the recorded display.
// The strokes window is a real window, so the screen capture records it like anything else on
// screen (no content protection, unlike the teleprompter). The toolbar is a second small window
// that IS hidden from capture, so the recording shows the drawing and not our controls.
// In drawing mode the strokes window takes the mouse; otherwise every click goes through it and
// it hides once nothing is left on it.
import { app, BrowserWindow, globalShortcut, ipcMain, screen, type Display, type Rectangle } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import type { DrawCommand, DrawStatus, DrawTool } from "../shared/types";
import { loadPage, preloadPath } from "./index";
import { setClickFilter } from "./record/pointer";

const SHORTCUT = "CommandOrControl+Shift+D";
const SHORTCUT_LABEL = process.platform === "darwin" ? "Cmd+Shift+D" : "Ctrl+Shift+D";
const TOOLS: DrawTool[] = ["pen", "highlighter", "arrow", "rect"];
const TOOLBAR = { width: 560, height: 96, top: 14 };

let status: DrawStatus = { active: false, fade: true, tool: "pen", color: "#ff3b30", shortcut: SHORTCUT_LABEL, shortcutOk: true };
let overlay: BrowserWindow | null = null;
let toolbar: BrowserWindow | null = null;
/** the display the record module captures (null: the one under the cursor) */
let displayId: string | null = null;
let empty = true;
let getMain: () => BrowserWindow | null = () => null;

const prefsFile = () => join(app.getPath("userData"), "draw.json");
const alive = (w: BrowserWindow | null): w is BrowserWindow => !!w && !w.isDestroyed();

function loadPrefs() {
  try {
    const p = JSON.parse(readFileSync(prefsFile(), "utf8")) as Partial<DrawStatus>;
    if (typeof p.fade === "boolean") status.fade = p.fade;
    if (TOOLS.includes(p.tool as DrawTool)) status.tool = p.tool as DrawTool;
    if (typeof p.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color)) status.color = p.color;
  } catch { /* first run */ }
}

function savePrefs() {
  try { writeFileSync(prefsFile(), JSON.stringify({ fade: status.fade, tool: status.tool, color: status.color })); } catch { /* not worth failing over */ }
}

function targetDisplay(): Display {
  const all = screen.getAllDisplays();
  return (displayId && all.find((d) => String(d.id) === displayId)) || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function toolbarBounds(d: Display): Rectangle {
  const b = d.bounds;
  return { x: Math.round(b.x + (b.width - TOOLBAR.width) / 2), y: b.y + TOOLBAR.top, width: TOOLBAR.width, height: TOOLBAR.height };
}

function broadcast() {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.drawStatus, status);
}

function makeWindow(bounds: Rectangle, title: string, part: "strokes" | "toolbar"): BrowserWindow {
  const win = new BrowserWindow({
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    // the toolbar never takes focus, so the keys keep going to the strokes window
    focusable: part === "strokes",
    show: false,
    title,
    webPreferences: { preload: preloadPath(), sandbox: false, contextIsolation: true, backgroundThrottling: false },
  });
  // over full-screen apps and the taskbar, on every desktop; the toolbar one step above the strokes
  win.setAlwaysOnTop(true, "screen-saver", part === "toolbar" ? 1 : 0);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.on("did-finish-load", () => win.webContents.send(IPC.drawStatus, status));
  getMain()?.once("closed", () => { if (!win.isDestroyed()) win.destroy(); });
  void loadPage(win, "draw", part);
  return win;
}

function ensureWindows() {
  const d = targetDisplay();
  if (!alive(overlay)) {
    overlay = makeWindow(d.bounds, "OpenTake Drawing", "strokes");
    overlay.setIgnoreMouseEvents(true, { forward: true });
    overlay.on("closed", () => { overlay = null; empty = true; setDrawing(false); });
  } else {
    const now = overlay.getBounds(), b = d.bounds;
    if (now.x !== b.x || now.y !== b.y || now.width !== b.width || now.height !== b.height) overlay.setBounds(b);
  }
  if (!alive(toolbar)) {
    toolbar = makeWindow(toolbarBounds(d), "OpenTake Drawing Tools", "toolbar");
    // the recording shows the strokes, never our buttons
    toolbar.setContentProtection(true);
    toolbar.on("closed", () => { toolbar = null; });
  } else toolbar.setBounds(toolbarBounds(d));
}

const whenLoaded = (w: BrowserWindow, fn: () => void) => { if (w.webContents.isLoading()) w.webContents.once("did-finish-load", fn); else fn(); };

export function setDrawing(on: boolean) {
  if (on === status.active) return;
  status = { ...status, active: on };
  if (on) {
    ensureWindows();
    const o = overlay!, t = toolbar!;
    o.setIgnoreMouseEvents(false);
    whenLoaded(o, () => { o.show(); o.focus(); });
    whenLoaded(t, () => t.showInactive());
  } else {
    if (alive(toolbar)) toolbar.hide();
    if (alive(overlay)) {
      overlay.setIgnoreMouseEvents(true, { forward: true });
      // strokes still fading (or kept) stay on screen; the window hides when they are gone
      if (empty) overlay.hide(); else overlay.blur();
    }
  }
  broadcast();
}

export function registerDraw(main: () => BrowserWindow | null) {
  getMain = main;
  loadPrefs();
  // a click that draws must not also zoom the recording into it
  setClickFilter(() => status.active);

  ipcMain.handle(IPC.drawStatus, () => status);
  ipcMain.handle(IPC.drawToggle, (_e, on?: unknown) => { setDrawing(typeof on === "boolean" ? on : !status.active); return status; });
  ipcMain.handle(IPC.drawPrefs, (_e, p: Partial<DrawStatus>) => {
    const next = { ...status };
    if (typeof p?.fade === "boolean") next.fade = p.fade;
    if (TOOLS.includes(p?.tool as DrawTool)) next.tool = p.tool as DrawTool;
    if (typeof p?.color === "string" && /^#[0-9a-f]{6}$/i.test(p.color)) next.color = p.color;
    status = next;
    savePrefs();
    broadcast();
    return status;
  });
  ipcMain.on(IPC.drawCommand, (_e, cmd: DrawCommand) => {
    if ((cmd === "undo" || cmd === "clear") && alive(overlay)) overlay.webContents.send(IPC.drawCommand, cmd);
  });
  ipcMain.on(IPC.drawDisplay, (_e, id: unknown) => { displayId = typeof id === "string" && id ? id : null; });
  ipcMain.on(IPC.drawEmpty, (e, isEmpty: unknown) => {
    if (!alive(overlay) || e.sender !== overlay.webContents) return;
    empty = !!isEmpty;
    if (empty && !status.active && overlay.isVisible()) overlay.hide();
  });

  status = { ...status, shortcutOk: globalShortcut.register(SHORTCUT, () => setDrawing(!status.active)) };
  if (!status.shortcutOk) console.warn(`[draw] could not register ${SHORTCUT} (another app holds it)`);
  app.on("will-quit", () => globalShortcut.unregister(SHORTCUT));
}
