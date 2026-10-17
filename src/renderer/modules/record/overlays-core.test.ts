import { describe, expect, it } from "vitest";
import {
  CARD_FADE_MS, DEFAULT_OVERLAYS, LOWER_THIRD_DELAY_MS, anchorBox, approach, introAlpha, introSpanMs, logoRect, lowerThirdWanted,
  mergeOverlays, outroAlpha, outroSpanMs, rippleAt, viewToFrame,
} from "./overlays-core";

describe("defaults", () => {
  it("leave the standard look as it was: only the click ring and the pointer are on", () => {
    const d = DEFAULT_OVERLAYS;
    expect([d.keys.enabled, d.logo.enabled, d.lowerThird.enabled, d.intro.enabled, d.outro.enabled, d.pointer.spotlight]).toEqual([false, false, false, false, false, false]);
    expect(d.pointer.show && d.pointer.highlight).toBe(true);
  });
  it("fill what an old setting lacks", () => {
    const m = mergeOverlays({ keys: { enabled: true } as never });
    expect(m.keys).toEqual({ ...DEFAULT_OVERLAYS.keys, enabled: true });
    expect(m.pointer).toEqual(DEFAULT_OVERLAYS.pointer);
    expect(mergeOverlays(undefined).logoImage).toBeNull();
  });
});

describe("logoRect", () => {
  const logo = { ...DEFAULT_OVERLAYS.logo, size: 0.2, margin: 0.05 };
  it("sits in a corner by its margin, keeping the picture's shape", () => {
    expect(logoRect({ ...logo, position: "top-right" }, 200, 100, 1920, 1080)).toEqual({ x: 1920 - 54 - 216, y: 54, w: 216, h: 108 });
    expect(logoRect({ ...logo, position: "bottom-left" }, 100, 200, 1920, 1080)).toEqual({ x: 54, y: 1080 - 54 - 216, w: 108, h: 216 });
  });
  it("custom position stays inside the frame", () => {
    const r = logoRect({ ...logo, position: "custom", x: 1, y: 1 }, 100, 100, 1920, 1080);
    expect(r.x + r.w).toBeCloseTo(1920);
    expect(r.y + r.h).toBeCloseTo(1080);
  });
});

describe("anchorBox", () => {
  it("places bottom centre, left and right, and top left", () => {
    expect(anchorBox("bottom-center", 100, 40, 1000, 500, 20, 30)).toEqual({ x: 450, y: 430, w: 100, h: 40 });
    expect(anchorBox("bottom-left", 100, 40, 1000, 500, 20, 30).x).toBe(20);
    expect(anchorBox("bottom-right", 100, 40, 1000, 500, 20, 30).x).toBe(880);
    expect(anchorBox("top-left", 100, 40, 1000, 500, 20, 30).y).toBe(30);
  });
});

describe("cards", () => {
  const intro = { enabled: true, seconds: 3 };
  it("the intro holds, then fades into the scene", () => {
    expect(introAlpha(intro, 0)).toBe(1);
    expect(introAlpha(intro, 3000)).toBe(1);
    expect(introAlpha(intro, 3000 + CARD_FADE_MS / 2)).toBeCloseTo(0.5);
    expect(introAlpha(intro, 4000)).toBe(0);
    expect(introAlpha({ ...intro, enabled: false }, 0)).toBe(0);
    expect(introSpanMs(intro)).toBe(3000 + CARD_FADE_MS);
  });
  it("the outro fades in and keeps recording for its seconds", () => {
    expect(outroAlpha(0)).toBe(0);
    expect(outroAlpha(CARD_FADE_MS)).toBe(1);
    expect(outroSpanMs({ enabled: true, seconds: 2 })).toBe(CARD_FADE_MS + 2000);
    expect(outroSpanMs({ enabled: false, seconds: 2 })).toBe(0);
  });
});

describe("lowerThirdWanted", () => {
  const lt = { enabled: true, seconds: 5 };
  it("shows for its seconds after the intro", () => {
    expect(lowerThirdWanted(lt, 0, 0, null)).toBe(false);
    expect(lowerThirdWanted(lt, LOWER_THIRD_DELAY_MS, 0, null)).toBe(true);
    expect(lowerThirdWanted(lt, LOWER_THIRD_DELAY_MS + 5000, 0, null)).toBe(false);
    expect(lowerThirdWanted(lt, 1000, 3500, null)).toBe(false);
    expect(lowerThirdWanted(lt, 4000, 3500, null)).toBe(true);
  });
  it("the hotkey wins, and nothing shows when it is off", () => {
    expect(lowerThirdWanted(lt, 100000, 0, true)).toBe(true);
    expect(lowerThirdWanted(lt, LOWER_THIRD_DELAY_MS, 0, false)).toBe(false);
    expect(lowerThirdWanted({ ...lt, seconds: 0 }, 1000, 0, null)).toBe(false);
    expect(lowerThirdWanted({ ...lt, enabled: false }, 1000, 0, true)).toBe(false);
    expect(lowerThirdWanted(lt, null, 0, null)).toBe(false);
  });
});

describe("helpers", () => {
  it("approach moves at a steady rate and stops at the ends", () => {
    expect(approach(0, true, 100, 400)).toBeCloseTo(0.25);
    expect(approach(0.9, true, 400, 400)).toBe(1);
    expect(approach(0.1, false, 400, 400)).toBe(0);
  });
  it("the click ring grows and fades, then is gone", () => {
    expect(rippleAt(0, 600, 1)).toEqual({ radius: 14, alpha: 1 });
    expect(rippleAt(300, 600, 2)?.radius).toBe(62);
    expect(rippleAt(600, 600, 1)).toBeNull();
  });
  it("maps a picture point through the zoom view", () => {
    const r = { x: 100, y: 50, w: 800, h: 400 };
    expect(viewToFrame({ x: 0.5, y: 0.5 }, r, { sx: 0, sy: 0, sw: 1, sh: 1 })).toEqual({ x: 500, y: 250 });
    expect(viewToFrame({ x: 0.5, y: 0.5 }, r, { sx: 0.25, sy: 0.25, sw: 0.5, sh: 0.5 })).toEqual({ x: 500, y: 250 });
    expect(viewToFrame({ x: 0.25, y: 0.25 }, r, { sx: 0.25, sy: 0.25, sw: 0.5, sh: 0.5 })).toEqual({ x: 100, y: 50 });
  });
});
