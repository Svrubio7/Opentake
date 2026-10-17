// The keystroke overlay as pure functions (tested in keys-core.test.ts): key names, how a combo is
// written, and how typing collapses into a word. Nothing here is ever written to disk.
import type { KeyPress } from "@shared/types";
import { t, type PlainKey } from "../../../shared/i18n";

// keys with a printed name of their own on a Spanish keyboard (Mayús, Intro, Supr...); the rest read the same
const PRINTED: Record<string, PlainKey> = {
  Backspace: "record.key.Backspace", Enter: "record.key.Enter", "Caps Lock": "record.key.CapsLock", Space: "record.key.Space",
  "Page Up": "record.key.PageUp", "Page Down": "record.key.PageDown", End: "record.key.End", Home: "record.key.Home",
  Insert: "record.key.Insert", Delete: "record.key.Delete", "Print Screen": "record.key.PrintScreen",
};
/** A key's name as the keyboard prints it in the app's language. */
export const shownKey = (key: string) => (PRINTED[key] ? t(PRINTED[key]) : key);

/** libuiohook key codes (the same table as uiohook-napi's UiohookKey) to the label shown. */
export const KEY_NAMES: Record<number, string> = {
  14: "Backspace", 15: "Tab", 28: "Enter", 3612: "Enter", 58: "Caps Lock", 1: "Esc", 57: "Space",
  3657: "Page Up", 3665: "Page Down", 3663: "End", 3655: "Home",
  57419: "←", 57416: "↑", 57421: "→", 57424: "↓", 3666: "Insert", 3667: "Delete",
  11: "0", 2: "1", 3: "2", 4: "3", 5: "4", 6: "5", 7: "6", 8: "7", 9: "8", 10: "9",
  30: "A", 48: "B", 46: "C", 32: "D", 18: "E", 33: "F", 34: "G", 35: "H", 23: "I", 36: "J", 37: "K", 38: "L", 50: "M",
  49: "N", 24: "O", 25: "P", 16: "Q", 19: "R", 31: "S", 20: "T", 22: "U", 47: "V", 17: "W", 45: "X", 21: "Y", 44: "Z",
  82: "0", 79: "1", 80: "2", 81: "3", 75: "4", 76: "5", 77: "6", 71: "7", 72: "8", 73: "9",
  55: "*", 78: "+", 74: "-", 83: ".", 3637: "/",
  59: "F1", 60: "F2", 61: "F3", 62: "F4", 63: "F5", 64: "F6", 65: "F7", 66: "F8", 67: "F9", 68: "F10", 87: "F11", 88: "F12",
  39: ";", 13: "=", 51: ",", 12: "-", 52: ".", 53: "/", 41: "`", 26: "[", 43: "\\", 27: "]", 40: "'",
  3639: "Print Screen",
};

/** Ctrl, Alt, Shift and Win/Cmd on both sides: pressed alone they show nothing. */
export const MODIFIER_CODES = new Set([29, 3613, 56, 3640, 42, 54, 3675, 3676]);
/** Right Alt is AltGr on many layouts: keys typed with it are characters, not shortcuts. */
export const ALT_GR = 3640;

/** A shortcut: something held besides Shift (Shift + a letter is typing). */
export const isCombo = (p: Pick<KeyPress, "ctrl" | "alt" | "meta">) => p.ctrl || p.alt || p.meta;

/** "Ctrl + Shift + P" on Windows and Linux, "⌘ C" on a Mac. */
export function formatCombo(p: KeyPress, mac: boolean): string {
  if (mac) {
    const mods = `${p.ctrl ? "⌃" : ""}${p.alt ? "⌥" : ""}${p.shift ? "⇧" : ""}${p.meta ? "⌘" : ""}`;
    return mods ? `${mods} ${shownKey(p.key)}` : shownKey(p.key);
  }
  return [p.ctrl && "Ctrl", p.alt && "Alt", p.shift && t("record.key.Shift"), p.meta && "Win", shownKey(p.key)].filter(Boolean).join(" + ");
}

/** The character a key types, or null for keys that do not type one (Enter, arrows, F keys). */
export function typedChar(p: KeyPress): string | null {
  if (p.key === "Space") return " ";
  if (p.key.length !== 1) return null;
  return /[A-Z]/.test(p.key) && !p.shift ? p.key.toLowerCase() : p.key;
}

export interface KeyFeed { text: string; kind: "combo" | "typing" | "key"; at: number }

/** How long a pill stays up after the last key, and how long it takes to fade. */
export const KEY_HOLD_MS = 1200;
export const KEY_FADE_MS = 250;
/** Typing shows its last characters only. */
export const TYPED_MAX = 28;

/**
 * The next pill after a key press. Shortcuts always show; everything else only with "show all keys",
 * where letters typed within the hold time collapse into one growing word.
 */
export function pushKey(feed: KeyFeed | null, p: KeyPress, opts: { showAll: boolean; mac: boolean }, now: number): KeyFeed | null {
  if (isCombo(p)) return { text: formatCombo(p, opts.mac), kind: "combo", at: now };
  if (!opts.showAll) return feed;
  const typing = feed?.kind === "typing" && now - feed.at < KEY_HOLD_MS;
  if (p.key === "Backspace" && typing && feed) {
    const text = feed.text.slice(0, -1);
    return text ? { text, kind: "typing", at: now } : { text: shownKey("Backspace"), kind: "key", at: now };
  }
  const ch = typedChar(p);
  if (ch == null) return { text: p.shift ? formatCombo(p, opts.mac) : shownKey(p.key), kind: "key", at: now };
  const prev = typing && feed ? feed.text : "";
  const text = (prev + ch).replace(/^\s+/, "");
  if (!text) return feed;
  return { text: text.length > TYPED_MAX ? "…" + text.slice(-(TYPED_MAX - 1)) : text, kind: "typing", at: now };
}

/** The pill's opacity: full for the hold time, then a short fade. */
export function keyFeedAlpha(feed: KeyFeed | null, now: number): number {
  if (!feed) return 0;
  const age = now - feed.at;
  if (age <= KEY_HOLD_MS) return 1;
  return Math.max(0, 1 - (age - KEY_HOLD_MS) / KEY_FADE_MS);
}
