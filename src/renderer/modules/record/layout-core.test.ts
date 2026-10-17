import { describe, expect, it } from "vitest";
import {
  bubbleAspect, bubbleRadius, bubbleRect, cameraWindowRect, clampBubble, clampSide, containRect, coverCrop, cropSource, formatClock,
  gradientLine, hitBubble, normalizeCrop, outputSize, parseHex, pickMime, resolveBackground, toCropSpace,
  screenRect, snapBubble, videoBitrate,
} from "./layout-core";

describe("layout", () => {
  it("sizes outputs by aspect", () => {
    expect(outputSize("16:9")).toEqual({ width: 1920, height: 1080 });
    expect(outputSize("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(outputSize("1:1")).toEqual({ width: 1080, height: 1080 });
  });
  it("contains and covers", () => {
    expect(containRect(1920, 1080, { x: 0, y: 0, w: 1080, h: 1080 })).toEqual({ x: 0, y: 236.25, w: 1080, h: 607.5 });
    expect(coverCrop(1920, 1080, 1, 1)).toEqual({ x: 420, y: 0, w: 1080, h: 1080 });
  });
  it("pads the screen", () => {
    const r = screenRect({ width: 1920, height: 1080, padding: 0.05 }, 1920, 1080);
    expect(r.y).toBeCloseTo(54);
    expect(r.w / r.h).toBeCloseTo(16 / 9);
  });
  it("keeps a bubble on screen and snaps it into a near corner", () => {
    const b = clampBubble({ cx: 1.2, cy: -1, size: 0.25, shape: "circle" }, 1920, 1080);
    const r = bubbleRect(b, 1920, 1080);
    expect(r.x + r.w).toBeLessThanOrEqual(1920.0001);
    expect(r.y).toBeGreaterThanOrEqual(-0.0001);
    const s = snapBubble({ cx: 0.88, cy: 0.8, size: 0.25, shape: "circle" }, 1920, 1080);
    const sr = bubbleRect(s, 1920, 1080);
    expect(1920 - (sr.x + sr.w)).toBeCloseTo(0.03 * 1080);
    const mid = snapBubble({ cx: 0.5, cy: 0.5, size: 0.25, shape: "circle" }, 1920, 1080);
    expect(mid.cx).toBe(0.5);
  });
  it("hits the bubble centre to move and its edge to resize", () => {
    const b = { cx: 0.5, cy: 0.5, size: 0.3, shape: "circle" as const };
    expect(hitBubble(b, 1000, 1000, 500, 500)).toBe("move");
    expect(hitBubble(b, 1000, 1000, 645, 500)).toBe("resize");
    expect(hitBubble(b, 1000, 1000, 900, 900)).toBeNull();
  });
});

describe("recording", () => {
  it("picks the first supported codec", () => {
    expect(pickMime((m) => m.includes("vp9"))).toBe("video/webm;codecs=vp9,opus");
    expect(pickMime((m) => m === "video/webm;codecs=h264", false)).toBe("video/webm;codecs=h264");
    expect(pickMime(() => false)).toBe("");
  });
  it("scales bitrate with pixels and stays in range", () => {
    expect(videoBitrate(1920, 1080, 30)).toBe(16_000_000);
    expect(videoBitrate(3840, 2160, 60)).toBe(40_000_000);
    expect(videoBitrate(640, 360, 30)).toBe(8_000_000);
  });
  it("formats a clock", () => {
    expect(formatClock(65_000)).toBe("1:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
  });
});

describe("custom looks", () => {
  it("sizes every frame shape, resolution and custom size", () => {
    expect(outputSize("4:5")).toEqual({ width: 1080, height: 1350 });
    expect(outputSize("4:3")).toEqual({ width: 1440, height: 1080 });
    expect(outputSize("16:9", 2160)).toEqual({ width: 3840, height: 2160 });
    expect(outputSize("9:16", 720)).toEqual({ width: 720, height: 1280 });
    expect(outputSize("custom", 1080, { width: 1281, height: 99999 })).toEqual({ width: 1282, height: 4096 });
    expect(clampSide(10)).toBe(320);
  });
  it("shrinks and places the screen window inside the padding", () => {
    const L = { width: 1920, height: 1080, padding: 0.05 };
    const full = screenRect(L, 1920, 1080);
    const half = screenRect({ ...L, screenScale: 0.5 }, 1920, 1080);
    expect(half.w).toBeCloseTo(full.w / 2);
    expect(half.x + half.w / 2).toBeCloseTo(960);
    const left = screenRect({ ...L, screenScale: 0.5, screenPosition: { x: -1, y: 1 } }, 1920, 1080);
    expect(left.x).toBeCloseTo(54); // against the padding, not where the full-size window started
    expect(left.y + left.h).toBeCloseTo(full.y + full.h);
    expect(cameraWindowRect({ ...L, screenScale: 1 }).w).toBeCloseTo(1920 - 108);
  });
  it("crops the screen and maps the cursor into what is kept", () => {
    expect(cropSource({ top: 0, right: 0, bottom: 0.05, left: 0.25 }, 1920, 1080)).toEqual({ x: 480, y: 0, w: 1440, h: 1026 });
    expect(normalizeCrop({ top: 0.9, left: -1 })).toEqual({ top: 0.45, right: 0, bottom: 0, left: 0 });
    const p = toCropSpace({ x: 0.625, y: 0.5, t: 7 }, { top: 0, right: 0, bottom: 0, left: 0.25 });
    expect(p).toEqual({ x: 0.5, y: 0.5, t: 7 });
  });
  it("gives a rectangle camera its own width, height and corners", () => {
    const b = { cx: 0.5, cy: 0.5, size: 0.4, shape: "rounded" as const, aspect: 0.5, radius: 0.5 };
    const r = bubbleRect(b, 1920, 1080);
    expect(r.w).toBeCloseTo(432);
    expect(r.h).toBeCloseTo(864);
    expect(bubbleRadius(b, r)).toBeCloseTo(216);
    expect(bubbleRadius({ shape: "rounded" }, { w: 400, h: 300 })).toBeCloseTo(54);
    expect(bubbleAspect({ shape: "rounded" })).toBeCloseTo(4 / 3);
    // a tall bubble cannot grow past the frame's height
    const big = clampBubble({ ...b, size: 2 }, 1920, 1080);
    expect(bubbleRect(big, 1920, 1080).h).toBeLessThanOrEqual(1080 * 0.95 + 0.001);
  });
  it("resolves backgrounds and their gradient line", () => {
    const base = { color: "#112233", color2: "#445566", angle: 90, image: null, blur: 0 };
    expect(resolveBackground({ ...base, id: "color" })).toEqual({ kind: "solid", color: "#112233" });
    expect(resolveBackground({ ...base, id: "gradient" })).toEqual({ kind: "gradient", stops: ["#112233", "#445566"], angle: 90 });
    expect(resolveBackground({ ...base, id: "image" })).toEqual({ kind: "solid", color: "#112233" });
    expect(resolveBackground({ ...base, id: "nope" })).toEqual({ kind: "solid", color: "#000000" });
    const l = gradientLine(90, 1000, 500);
    expect(l.x0).toBeCloseTo(0); expect(l.x1).toBeCloseTo(1000); expect(l.y0).toBeCloseTo(250);
    expect(parseHex("#ABC")).toBe("#aabbcc");
    expect(parseHex("red")).toBeNull();
  });
});
