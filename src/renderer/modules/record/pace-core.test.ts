import { describe, expect, it } from "vitest";
import { FramePacer, SteadyFrames, TICK_MS, captureEarlyMs } from "./pace-core";

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

describe("a steady camera, read from its frame count", () => {
  it("is steady after three frames that each came soon after the last", () => {
    const s = new SteadyFrames(150);
    expect(s.sample(0, 10)).toBe(false);
    expect(s.sample(4, 10)).toBe(false); // no new frame on this tick
    expect(s.sample(33, 11)).toBe(false);
    expect(s.sample(66, 12)).toBe(false);
    expect(s.sample(100, 13)).toBe(true);
  });
  it("starts counting again after a stall", () => {
    const s = new SteadyFrames(150);
    s.sample(0, 1); s.sample(33, 2); s.sample(66, 3);
    expect(s.sample(566, 4)).toBe(false); // half a second without a frame
    expect(s.sample(600, 5)).toBe(false);
    expect(s.sample(633, 6)).toBe(false);
    expect(s.sample(666, 7)).toBe(true);
  });
  it("counts several frames between two readings as one arrival", () => {
    const s = new SteadyFrames(150);
    s.sample(0, 0);
    expect(s.sample(100, 3)).toBe(false);
    expect(s.sample(200, 6)).toBe(false);
    expect(s.sample(300, 9)).toBe(true);
  });
});

describe("the composite's capture of the frames the compositor draws", () => {
  // the compositor draws on its pacer from a 4 ms tick; the capture starts at some later moment
  const run = (drawFps: number, captureFps: number, startAt: number, early: (p: number) => number) => {
    const draw = new FramePacer(1000 / drawFps);
    let cap: FramePacer | null = null, draws = 0, taken = 0, seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2500; i++) {
      const t = i * TICK_MS + rnd() * 3;
      if (!draw.due(t)) continue;
      draws++;
      if (!cap && t >= startAt) cap = new FramePacer(1000 / captureFps, early(1000 / captureFps));
      if (cap?.due(t)) taken++;
    }
    return { draws, taken };
  };
  it("takes every drawn frame at the same rate, wherever it starts", () => {
    for (const start of [0, 5, 11, 13]) {
      const { taken } = run(60, 60, start, captureEarlyMs);
      expect(taken).toBeGreaterThanOrEqual(598);
    }
  });
  it("a half-millisecond capture pacer falls out of step and drops frames", () => {
    expect(Math.min(...[0, 5, 11, 13, 21, 30].map((s) => run(60, 60, s, () => 0.5).taken))).toBeLessThan(595);
  });
  it("still holds its own rate when frames are drawn faster", () => {
    const { draws, taken } = run(120, 60, 0, captureEarlyMs);
    expect(draws).toBeGreaterThan(1150);
    expect(taken).toBeLessThanOrEqual(601);
    expect(taken).toBeGreaterThan(560);
  });
});
