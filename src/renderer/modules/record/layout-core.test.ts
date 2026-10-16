import { describe, expect, it } from "vitest";
import {
  bubbleRect, clampBubble, containRect, coverCrop, formatClock, hitBubble, outputSize, pickMime,
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
