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
