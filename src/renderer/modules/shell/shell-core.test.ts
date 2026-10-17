import { describe, expect, it } from "vitest";
import { setLang } from "../../../shared/i18n";
import { keyLabel, opensSheet, shortcutGroups, shortcutText } from "./shortcuts-core";
import { LONG_TAKE_MS, TIGHT_DISK_BYTES, exportSuggestion, looksLikeHeadphones, setupSuggestions, takeSuggestion, type SetupSnapshot } from "./suggestions-core";

describe("shortcuts", () => {
  it("lists every global shortcut main registers", () => {
    const global = shortcutGroups()[0].items.map((s) => s.keys.join("+"));
    for (const k of ["Mod+Shift+R", "Mod+Shift+P", "Mod+Shift+1", "Mod+Shift+2", "Mod+Shift+3", "Mod+Shift+L", "Mod+Shift+D"]) expect(global).toContain(k);
  });
  it("has no shortcut twice in a group", () => {
    for (const g of shortcutGroups()) {
      const keys = g.items.map((s) => s.keys.join("+"));
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
  it("reads Ctrl or Cmd and Option on a Mac", () => {
    expect(shortcutText(["Mod", "Shift", "R"], false)).toBe("Ctrl+Shift+R");
    expect(shortcutText(["Mod", "Alt", "T"], true)).toBe("Cmd+Option+T");
    expect(keyLabel("Esc", true)).toBe("Esc");
  });
  it("prints the keys as a Spanish keyboard does in Spanish", () => {
    setLang("es");
    expect(shortcutText(["Mod", "Shift", "R"], false)).toBe("Ctrl+Mayús+R");
    expect(shortcutText(["Mod", "Alt", "Space"], true)).toBe("Cmd+Opción+Espacio");
    expect(keyLabel("Delete", false)).toBe("Supr");
    expect(shortcutGroups()[0].title).toBe("Desde cualquier app");
    setLang("en");
    expect(shortcutGroups()[0].title).toBe("From any app");
  });
  it("opens the sheet with ? unless typing", () => {
    const k = { key: "?", ctrlKey: false, metaKey: false, altKey: false };
    expect(opensSheet(k, { tagName: "BUTTON" })).toBe(true);
    expect(opensSheet(k, { tagName: "TEXTAREA" })).toBe(false);
    expect(opensSheet(k, { tagName: "DIV", isContentEditable: true })).toBe(false);
    expect(opensSheet({ ...k, ctrlKey: true }, null)).toBe(false);
    expect(opensSheet({ ...k, key: "/" }, null)).toBe(false);
  });
});

const base: SetupSnapshot = { mode: "screen-camera", backgroundId: "graphite", cameraLight: "good", systemSound: false, headphones: null, freeBytes: 500e9, busy: false };
const none = new Set<string>();

describe("setupSuggestions", () => {
  it("says nothing when all is well", () => {
    expect(setupSuggestions(base, none)).toEqual([]);
  });
  it("suggests a background for an edge-to-edge screen, not for a camera take", () => {
    expect(setupSuggestions({ ...base, backgroundId: "none" }, none).map((s) => s.id)).toEqual(["screen-background"]);
    expect(setupSuggestions({ ...base, mode: "camera", backgroundId: "none" }, none)).toEqual([]);
  });
  it("suggests light for a dim camera only when the camera is in the take", () => {
    expect(setupSuggestions({ ...base, cameraLight: "poor" }, none)[0].id).toBe("camera-dim");
    expect(setupSuggestions({ ...base, mode: "screen", cameraLight: "poor" }, none)).toEqual([]);
  });
  it("suggests headphones only when it knows the sound goes to speakers", () => {
    expect(setupSuggestions({ ...base, systemSound: true, headphones: false }, none)[0].id).toBe("headphones");
    expect(setupSuggestions({ ...base, systemSound: true, headphones: null }, none)).toEqual([]);
    expect(setupSuggestions({ ...base, systemSound: true, headphones: true }, none)).toEqual([]);
  });
  it("puts a tight drive first, shows at most two and never during a take", () => {
    const busy = { ...base, freeBytes: TIGHT_DISK_BYTES - 1, backgroundId: "none", cameraLight: "poor" as const };
    expect(setupSuggestions(busy, none).map((s) => s.id)).toEqual(["disk-tight", "camera-dim"]);
    expect(setupSuggestions({ ...busy, busy: true }, none)).toEqual([]);
  });
  it("never shows a dismissed one again", () => {
    expect(setupSuggestions({ ...base, backgroundId: "none" }, new Set(["screen-background"]))).toEqual([]);
  });
});

describe("exportSuggestion", () => {
  it("offers the Reels preset for a vertical take", () => {
    expect(exportSuggestion({ width: 1080, height: 1920 }, "youtube", none)?.action?.does).toBe("reels");
    expect(exportSuggestion({ width: 1080, height: 1920 }, "vertical", none)).toBeNull();
    expect(exportSuggestion({ width: 1920, height: 1080 }, "original", none)).toBeNull();
    expect(exportSuggestion(undefined, "original", none)).toBeNull();
    expect(exportSuggestion({ width: 1080, height: 1920 }, "original", new Set(["export-reels"]))).toBeNull();
  });
});

describe("takeSuggestion", () => {
  it("offers captions for a long take without them", () => {
    expect(takeSuggestion({ durationMs: LONG_TAKE_MS, hasCaptions: false }, none)?.id).toBe("take-captions");
    expect(takeSuggestion({ durationMs: LONG_TAKE_MS - 1, hasCaptions: false }, none)).toBeNull();
    expect(takeSuggestion({ durationMs: LONG_TAKE_MS * 2, hasCaptions: true }, none)).toBeNull();
    expect(takeSuggestion({ durationMs: null, hasCaptions: false }, none)).toBeNull();
  });
});

describe("looksLikeHeadphones", () => {
  it("reads common device names", () => {
    expect(looksLikeHeadphones("Headphones (WH-1000XM4 Stereo)")).toBe(true);
    expect(looksLikeHeadphones("Auriculares (Realtek)")).toBe(true);
    expect(looksLikeHeadphones("AirPods Pro")).toBe(true);
    expect(looksLikeHeadphones("Speakers (Realtek(R) Audio)")).toBe(false);
    expect(looksLikeHeadphones("")).toBeNull();
  });
});
