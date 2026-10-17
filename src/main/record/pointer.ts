// Global pointer tracking for auto zoom: clicks from uiohook-napi (a native global hook),
// cursor positions by polling Electron's screen module. Coordinates leave here as 0..1 of the
// captured display so the renderer never has to know about DPI or monitor layout.
import { screen, type Display, type WebContents } from "electron";
import { createRequire } from "node:module";
import { IPC } from "../../shared/ipc";
import type { ClickEvent, ClickTrackingStatus, CursorSample } from "../../shared/types";

interface HookMouseEvent { x: number; y: number; button: unknown }
export interface HookKeyEvent { keycode: number; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }
interface Hook {
  on(ev: "mousedown", cb: (e: HookMouseEvent) => void): void;
  on(ev: "keydown" | "keyup", cb: (e: HookKeyEvent) => void): void;
  start(): void;
  stop(): void;
}

let hook: Hook | null = null;
let hookError: string | undefined;
let hookStarted = false;

function loadHook(): Hook | null {
  if (hook || hookError) return hook;
  try {
    const req = createRequire(import.meta.url);
    hook = (req("uiohook-napi") as { uIOhook: Hook }).uIOhook;
  } catch (e) {
    hookError = e instanceof Error ? e.message : String(e);
  }
  return hook;
}

let target: WebContents | null = null;
let display: Display | null = null;
let poll: NodeJS.Timeout | null = null;
let flush: NodeJS.Timeout | null = null;
let buffer: CursorSample[] = [];
let last = { x: NaN, y: NaN };
/** clicks it returns true for are not reported (drawing on the screen must not zoom) */
let clickFilter: () => boolean = () => false;

export function setClickFilter(fn: () => boolean) { clickFilter = fn; }

function findDisplay(displayId?: string): Display | null {
  const all = screen.getAllDisplays();
  if (displayId) {
    const d = all.find((x) => String(x.id) === displayId);
    if (d) return d;
  }
  return all.length === 1 ? all[0] : null;
}

/** DIP point to 0..1 inside the display, or null when outside it. */
function normalize(p: { x: number; y: number }): { x: number; y: number } | null {
  if (!display) return null;
  const b = display.bounds;
  const x = (p.x - b.x) / b.width, y = (p.y - b.y) / b.height;
  if (x < -0.01 || y < -0.01 || x > 1.01 || y > 1.01) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function onMouseDown(e: HookMouseEvent) {
  if (!target || target.isDestroyed() || clickFilter()) return;
  // libuiohook reports physical pixels on Windows (Electron is per-monitor DPI aware)
  const dip = process.platform === "win32" ? screen.screenToDipPoint({ x: e.x, y: e.y }) : { x: e.x, y: e.y };
  const p = normalize(dip);
  if (!p) return;
  const ev: ClickEvent = { x: p.x, y: p.y, t: Date.now(), button: typeof e.button === "number" ? e.button : 1 };
  target.send(IPC.clickEvent, ev);
}

/** The one global hook, started once and shared (the keystroke overlay listens to it too). Null when unavailable. */
export function globalHook(): Hook | null {
  const h = loadHook();
  if (h && !hookStarted) {
    try {
      h.on("mousedown", onMouseDown);
      h.start();
      hookStarted = true;
    } catch (e) {
      hookError = e instanceof Error ? e.message : String(e);
      hook = null;
    }
  }
  return hookStarted ? hook : null;
}

export const globalHookError = () => hookError;

export function startPointer(wc: WebContents, displayId?: string): ClickTrackingStatus {
  target = wc;
  display = findDisplay(displayId);
  globalHook();
  if (!poll) {
    poll = setInterval(() => {
      const p = normalize(screen.getCursorScreenPoint());
      if (!p || (p.x === last.x && p.y === last.y)) return;
      last = p;
      buffer.push({ ...p, t: Date.now() });
    }, 1000 / 60);
    flush = setInterval(() => {
      if (!buffer.length || !target || target.isDestroyed()) return;
      target.send(IPC.cursorEvent, buffer);
      buffer = [];
    }, 50);
  }
  return { hooks: hookStarted, normalized: display != null, reason: hookStarted ? undefined : hookError };
}

export function stopPointer() {
  if (poll) clearInterval(poll);
  if (flush) clearInterval(flush);
  poll = flush = null;
  buffer = [];
  target = null;
  // the hook keeps running (restarting libuiohook repeatedly is fragile); events are dropped without a target
}

export function shutdownPointer() {
  stopPointer();
  if (hook && hookStarted) {
    try { hook.stop(); } catch { /* quitting anyway */ }
    hookStarted = false;
  }
}
