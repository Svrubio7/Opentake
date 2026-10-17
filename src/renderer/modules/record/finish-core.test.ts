import { describe, expect, it } from "vitest";
import { STALL_MS, settleWithin, stalledTracks } from "./finish-core";

describe("ending a take within a bounded time", () => {
  it("says whether a promise settled in time, and never hangs on one that never does", async () => {
    expect(await settleWithin(Promise.resolve(), 50)).toBe(true);
    expect(await settleWithin(Promise.reject(new Error("x")), 50)).toBe(true);
    expect(await settleWithin(new Promise(() => {}), 20)).toBe(false);
  });
  it("finds a track that stopped handing over data, but not a paused take or a delayed start", () => {
    const now = 100_000;
    const tracks = [
      { track: "camera", startedAt: 80_000, lastDataAt: 99_500 },
      { track: "screen", startedAt: 80_000, lastDataAt: now - STALL_MS - 1 },
      { track: "composite", startedAt: null, lastDataAt: null },
      { track: "system", startedAt: now - 2000, lastDataAt: null },
    ];
    expect(stalledTracks(tracks, now, false)).toEqual(["screen"]);
    expect(stalledTracks(tracks, now, true)).toEqual([]);
  });
});
