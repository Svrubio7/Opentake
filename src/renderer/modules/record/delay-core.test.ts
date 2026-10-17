import { describe, expect, it } from "vitest";
import { DELAY_MS, RING_OVERHEAD, delayedSoundPath, History, Pending, laterQueue, pickFrame, planDelay, ringBytes, ringSlots, storeSize } from "./delay-core";

describe("storeSize", () => {
  it("keeps a 1080p screen whole in a 1080p take at 1.8x", () => {
    expect(storeSize({ w: 1920, h: 1080 }, { w: 1728, h: 972 }, 1.8)).toEqual({ w: 1920, h: 1080 });
  });
  it("stores a 4K screen at what a 1080p window can show zoomed, not at 4K", () => {
    const s = storeSize({ w: 3840, h: 2160 }, { w: 1728, h: 972 }, 1.8);
    expect(s.w).toBe(3110);
    expect(s.w / s.h).toBeCloseTo(16 / 9, 2);
  });
  it("stores a camera at its bubble's size", () => {
    expect(storeSize({ w: 1920, h: 1080 }, { w: 324, h: 324 }).h).toBe(324);
  });
});

describe("planDelay", () => {
  const base = { zoomEnabled: true, normalized: true, mode: "screen-camera" as const, fps: 30, screen: { w: 1920, h: 1080 }, camera: { w: 1920, h: 1080 } };
  it("delays a zoomed take by the zoom's lead", () => {
    expect(planDelay(base).delayMs).toBe(DELAY_MS);
    expect(planDelay({ ...base, fps: 60 }).delayMs).toBe(DELAY_MS);
  });
  it("does nothing, silently, without auto zoom or on a single window", () => {
    expect(planDelay({ ...base, zoomEnabled: false })).toEqual({ delayMs: 0, bytes: 0, reason: null });
    expect(planDelay({ ...base, normalized: false }).delayMs).toBe(0);
    expect(planDelay({ ...base, mode: "camera" }).delayMs).toBe(0);
  });
  it("falls back, and says why, when the rings would not fit", () => {
    const big = planDelay({ ...base, fps: 60, screen: { w: 3840, h: 2160 }, camera: { w: 3840, h: 2160 } });
    expect(big.delayMs).toBe(0);
    expect(big.reason).toMatch(/memory/);
    expect(planDelay({ ...base, deviceMemoryGb: 2 }).reason).toMatch(/little memory/);
  });
  it("keeps a 1080p60 take with a bubble on an 8 GB computer, not a 4K60 one", () => {
    const bubble = { w: 807, h: 454 };
    expect(planDelay({ ...base, fps: 60, camera: bubble, deviceMemoryGb: 8 }).delayMs).toBe(DELAY_MS);
    expect(planDelay({ ...base, fps: 60, screen: { w: 3840, h: 2160 }, camera: bubble, deviceMemoryGb: 8 }).delayMs).toBe(0);
  });
  it("counts the rings' bytes", () => {
    expect(ringSlots(800, 1000 / 30)).toBe(26);
    expect(ringBytes({ fps: 30, screen: { w: 10, h: 10 }, camera: { w: 0, h: 0 } })).toBeCloseTo(26 * 400 * RING_OVERHEAD);
  });
});

describe("History and Pending", () => {
  it("answers what was in force at a delayed time", () => {
    const h = new History<string>();
    h.push(1000, "screen");
    h.push(2000, "camera");
    expect(h.at(500)).toBe("screen");
    expect(h.at(1999)).toBe("screen");
    expect(h.at(2000)).toBe("camera");
  });
  it("forgets old values but keeps the one in force", () => {
    const h = new History<number>(1000);
    for (let t = 0; t <= 10_000; t += 100) h.push(t, t);
    h.push(20_000, -1);
    expect(h.at(15_000)).toBe(10_000);
  });
  it("hands out events once their time comes, in order", () => {
    const p = new Pending<string>();
    p.push(100, "a"); p.push(200, "b"); p.push(300, "c");
    expect(p.due(50)).toEqual([]);
    expect(p.due(250).map((e) => e.v)).toEqual(["a", "b"]);
    expect(p.due(1000).map((e) => e.v)).toEqual(["c"]);
  });
});

describe("pickFrame", () => {
  it("takes the newest frame stored by the delayed time", () => {
    const times = [1000, 1033, 967, 934];
    expect(pickFrame(times, 1010, 33)).toBe(0);
    expect(pickFrame(times, 1020, 33)).toBe(1);
    expect(pickFrame(times, 900, 33)).toBe(-1);
  });
});

describe("laterQueue", () => {
  it("runs each step the delay later, in order", () => {
    const calls: [string, number][] = [];
    const timer = (fn: () => void, ms: number) => { calls.push([fn.name, ms]); fn(); };
    const later = laterQueue(800, timer);
    const ran: string[] = [];
    later(function start() { ran.push("start"); }, 0);
    later(function pause() { ran.push("pause"); }, 300);
    expect(calls.map((c) => c[1])).toEqual([800, 800]);
    expect(ran).toEqual(["start", "pause"]);
  });
  it("runs at once without a delay", () => {
    let n = 0;
    laterQueue(0)(() => n++);
    expect(n).toBe(1);
  });
});

describe("delayedSoundPath", () => {
  const base = { delayMs: 800, hasSound: true, systemMix: false, voiceEngine: true };
  it("delays the sound inside the graph that makes it, never through another audio context", () => {
    expect(delayedSoundPath({ ...base, systemMix: true })).toBe("mix");
    expect(delayedSoundPath(base)).toBe("voice");
  });
  it("takes the extra trip only for a mic opened without the voice engine", () => {
    expect(delayedSoundPath({ ...base, voiceEngine: false })).toBe("hop");
  });
  it("does nothing without a delay or without sound", () => {
    expect(delayedSoundPath({ ...base, delayMs: 0 })).toBe("none");
    expect(delayedSoundPath({ ...base, hasSound: false })).toBe("none");
  });
});
