import { describe, expect, it } from "vitest";
import { FramePacer, TICK_MS } from "./pace-core";

const frames = (fps: number, tick: number, ms = 10_000, jitter = (_i: number) => 0) => {
  const p = new FramePacer(1000 / fps);
  let n = 0;
  for (let i = 0, t = 0; t < ms; i++, t = i * tick + jitter(i)) if (p.due(t)) n++;
  return n / (ms / 1000);
};

describe("pacing the composite's frames", () => {
  it("gives 60 and 30 frames a second from whole-millisecond ticks", () => {
    expect(frames(60, TICK_MS)).toBeCloseTo(60, 0);
    expect(frames(30, TICK_MS)).toBeCloseTo(30, 0);
    expect(frames(60, 16)).toBeCloseTo(60, 0);
    expect(frames(60, 15)).toBeCloseTo(60, 0);
  });
  it("keeps the rate with jittery ticks, and does not burst after a stall", () => {
    expect(frames(60, TICK_MS, 10_000, (i) => (i % 7) * 0.9)).toBeGreaterThan(58);
    const p = new FramePacer(1000 / 60);
    expect(p.due(0)).toBe(true);
    expect(p.due(500)).toBe(true); // half a second lost: one frame now, not thirty
    expect(p.due(505)).toBe(false);
    expect(p.due(516.7)).toBe(true);
  });
});
