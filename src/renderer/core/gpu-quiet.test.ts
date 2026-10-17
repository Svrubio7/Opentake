import { describe, expect, it } from "vitest";
import { gpuReadbacksHeld, holdGpuReadbacks } from "./gpu-quiet";

describe("holding GPU readbacks while recorders start", () => {
  it("holds for the time asked, and a shorter ask never cuts a longer hold", () => {
    holdGpuReadbacks(1000, 10_000);
    expect(gpuReadbacksHeld(10_500)).toBe(true);
    holdGpuReadbacks(100, 10_600);
    expect(gpuReadbacksHeld(10_900)).toBe(true);
    expect(gpuReadbacksHeld(11_001)).toBe(false);
  });
});

describe("readbacks right after a composite frame", () => {
  it("waits for the next frame while frames are drawn, one job a frame, one per key", async () => {
    const { afterNextFrame, frameDrawn } = await import("./gpu-quiet");
    const ran: string[] = [];
    frameDrawn(1000);
    afterNextFrame("a", () => ran.push("a1"), 1005);
    afterNextFrame("a", () => ran.push("a2"), 1006); // the newer job replaces the older
    afterNextFrame("b", () => ran.push("b"), 1007);
    expect(ran).toEqual([]);
    frameDrawn(1017);
    expect(ran).toEqual(["a2"]);
    frameDrawn(1034);
    expect(ran).toEqual(["a2", "b"]);
  });
  it("runs at once when no frames are being drawn", async () => {
    const { afterNextFrame, frameDrawn, FRAMES_STOPPED_MS } = await import("./gpu-quiet");
    frameDrawn(5000);
    let n = 0;
    afterNextFrame("c", () => n++, 5000 + FRAMES_STOPPED_MS + 1);
    expect(n).toBe(1);
  });
});
