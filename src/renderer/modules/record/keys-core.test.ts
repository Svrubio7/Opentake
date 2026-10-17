import { describe, expect, it } from "vitest";
import type { KeyPress } from "@shared/types";
import { KEY_HOLD_MS, KEY_NAMES, TYPED_MAX, formatCombo, isCombo, keyFeedAlpha, pushKey, typedChar, type KeyFeed } from "./keys-core";

const key = (k: string, mods: Partial<KeyPress> = {}): KeyPress => ({ key: k, ctrl: false, alt: false, shift: false, meta: false, t: 0, ...mods });
const ALL = { showAll: true, mac: false };
const COMBOS = { showAll: false, mac: false };

describe("formatCombo", () => {
  it("writes Windows combos with plus signs in a fixed order", () => {
    expect(formatCombo(key("P", { shift: true, ctrl: true }), false)).toBe("Ctrl + Shift + P");
    expect(formatCombo(key("Tab", { alt: true }), false)).toBe("Alt + Tab");
    expect(formatCombo(key("D", { meta: true }), false)).toBe("Win + D");
  });
  it("writes Mac combos with symbols", () => {
    expect(formatCombo(key("C", { meta: true }), true)).toBe("⌘ C");
    expect(formatCombo(key("Z", { meta: true, shift: true }), true)).toBe("⇧⌘ Z");
  });
});

describe("what counts as a shortcut", () => {
  it("needs Ctrl, Alt or Win/Cmd; Shift alone is typing", () => {
    expect(isCombo(key("A", { ctrl: true }))).toBe(true);
    expect(isCombo(key("A", { shift: true }))).toBe(false);
    expect(isCombo(key("A"))).toBe(false);
  });
  it("names letters and arrows", () => {
    expect(KEY_NAMES[25]).toBe("P");
    expect(KEY_NAMES[57421]).toBe("→");
  });
  it("types letters in the right case", () => {
    expect(typedChar(key("A"))).toBe("a");
    expect(typedChar(key("A", { shift: true }))).toBe("A");
    expect(typedChar(key("Space"))).toBe(" ");
    expect(typedChar(key("Enter"))).toBeNull();
  });
});

describe("pushKey", () => {
  it("shows only shortcuts unless every key is asked for (privacy)", () => {
    expect(pushKey(null, key("H"), COMBOS, 0)).toBeNull();
    expect(pushKey(null, key("Enter"), COMBOS, 0)).toBeNull();
    expect(pushKey(null, key("S", { ctrl: true }), COMBOS, 0)?.text).toBe("Ctrl + S");
  });
  it("collapses typing into one word", () => {
    let f: KeyFeed | null = null;
    for (const [i, k] of ["H", "I", "Space", "Y", "O", "U"].entries()) f = pushKey(f, key(k, { shift: i === 0 }), ALL, i * 100);
    expect(f).toMatchObject({ text: "Hi you", kind: "typing" });
  });
  it("starts a new word after a pause, and Backspace takes a letter back", () => {
    let f = pushKey(null, key("A"), ALL, 0);
    f = pushKey(f, key("B"), ALL, 100);
    f = pushKey(f, key("Backspace"), ALL, 200);
    expect(f?.text).toBe("a");
    f = pushKey(f, key("C"), ALL, 200 + KEY_HOLD_MS + 1);
    expect(f?.text).toBe("c");
  });
  it("keeps the end of long typing", () => {
    let f: KeyFeed | null = null;
    for (let i = 0; i < 40; i++) f = pushKey(f, key("X"), ALL, i);
    expect(f!.text.length).toBe(TYPED_MAX);
    expect(f!.text.startsWith("…")).toBe(true);
  });
  it("shows other keys on their own", () => {
    expect(pushKey(null, key("Enter"), ALL, 0)).toMatchObject({ text: "Enter", kind: "key" });
    expect(pushKey(null, key("Tab", { shift: true }), ALL, 0)?.text).toBe("Shift + Tab");
    expect(pushKey(null, key("Space"), ALL, 0)).toBeNull();
  });
  it("a shortcut replaces typing", () => {
    const f = pushKey(pushKey(null, key("A"), ALL, 0), key("C", { ctrl: true }), ALL, 50);
    expect(f).toMatchObject({ text: "Ctrl + C", kind: "combo" });
  });
});

describe("keyFeedAlpha", () => {
  it("holds, then fades", () => {
    const f: KeyFeed = { text: "x", kind: "combo", at: 1000 };
    expect(keyFeedAlpha(f, 1000 + KEY_HOLD_MS)).toBe(1);
    expect(keyFeedAlpha(f, 1000 + KEY_HOLD_MS + 125)).toBeCloseTo(0.5);
    expect(keyFeedAlpha(f, 1000 + KEY_HOLD_MS + 1000)).toBe(0);
    expect(keyFeedAlpha(null, 0)).toBe(0);
  });
});
