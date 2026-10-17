// The keystroke overlay's key feed: uiohook-napi keydown, filtered here so typed letters never leave
// the main process unless "show all keys" is on. Keys go to the window only; nothing is written to disk.
import type { WebContents } from "electron";
import { IPC } from "../../shared/ipc";
import type { KeyPress } from "../../shared/types";
import { ALT_GR, KEY_NAMES, MODIFIER_CODES, isCombo } from "../../renderer/modules/record/keys-core";
import { globalHook, globalHookError, type HookKeyEvent } from "./pointer";
import { t } from "../../shared/i18n";

let target: WebContents | null = null;
let showAll = false;
let listening = false;
let altGr = false;

function onKeyDown(e: HookKeyEvent) {
  if (e.keycode === ALT_GR) altGr = true;
  if (!target || target.isDestroyed() || MODIFIER_CODES.has(e.keycode)) return;
  const key = KEY_NAMES[e.keycode];
  if (!key) return;
  // AltGr reports Ctrl and Alt held: what it makes is a character (@, €, {), so it counts as typing
  const p: KeyPress = { key, ctrl: e.ctrlKey && !altGr, alt: e.altKey && !altGr, shift: e.shiftKey, meta: e.metaKey, t: Date.now() };
  if (!showAll && !isCombo(p)) return;
  target.send(IPC.keysEvent, p);
}

function onKeyUp(e: HookKeyEvent) {
  if (e.keycode === ALT_GR) altGr = false;
}

/** Starts sending key presses to the window; false (with the reason) when global hooks are unavailable. */
export function startKeys(wc: WebContents, opts: { showAll?: boolean }): { ok: boolean; reason?: string } {
  const h = globalHook();
  if (!h) return { ok: false, reason: globalHookError() ?? t("ov.keys.hookOff") };
  if (!listening) {
    h.on("keydown", onKeyDown);
    h.on("keyup", onKeyUp);
    listening = true;
  }
  target = wc;
  showAll = !!opts?.showAll;
  return { ok: true };
}

export function stopKeys() {
  // the hook stays registered (restarting libuiohook is fragile); without a target nothing is sent
  target = null;
  showAll = false;
}
