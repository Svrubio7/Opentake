import { describe, expect, it } from "vitest";
import { AUDIO_BPS, LOW_DISK_BYTES, diskBeforeTake, diskWhileRecording, minutesLeft, takeBitrate } from "./disk-core";

const GB = 1024 ** 3;

describe("takeBitrate", () => {
  it("adds every video track and the sound of every file that carries it", () => {
    expect(takeBitrate({ videoBps: [16e6, 20e6], audioTracks: 2 })).toBe(36e6 + 2 * AUDIO_BPS);
    expect(takeBitrate({ videoBps: [], audioTracks: 0 })).toBe(0);
  });
});

describe("minutesLeft", () => {
  it("is free space over the write rate", () => {
    // 1 GB at 8 Mbps is 1073.7 s, about 17.9 minutes
    expect(minutesLeft(GB, 8e6)).toBeCloseTo(GB * 8 / 8e6 / 60, 6);
  });
  it("never goes below zero, and is endless when nothing is written", () => {
    expect(minutesLeft(-5, 8e6)).toBe(0);
    expect(minutesLeft(GB, 0)).toBe(Infinity);
  });
});

describe("before a take", () => {
  it("is fine with 2 GB or more", () => expect(diskBeforeTake(LOW_DISK_BYTES).level).toBe("ok"));
  it("warns under 2 GB but does not refuse", () => {
    const v = diskBeforeTake(1.5 * GB);
    expect(v.level).toBe("low");
    expect(v.message).toMatch(/1\.5 GB/);
  });
});

describe("while recording", () => {
  const bps = 16e6; // 2 MB a second, 120 MB a minute
  const bytesFor = (minutes: number) => (minutes * 60 * bps) / 8;
  it("is quiet with 10 minutes or more left", () => expect(diskWhileRecording(bytesFor(10.5), bps).level).toBe("ok"));
  it("warns with the minutes left under 10", () => {
    const v = diskWhileRecording(bytesFor(4.6), bps);
    expect(v.level).toBe("low");
    expect(v.message).toMatch(/about 4 minutes/);
    expect(diskWhileRecording(bytesFor(1.2), bps).message).toMatch(/about 1 minute left/);
  });
  it("stops under a minute and says why", () => {
    const v = diskWhileRecording(bytesFor(0.5), bps);
    expect(v.level).toBe("stop");
    expect(v.message).toMatch(/almost full/);
  });
  it("has no em dashes in what it says", () => {
    for (const v of [diskBeforeTake(GB), diskWhileRecording(bytesFor(3), bps), diskWhileRecording(0, bps)]) expect(v.message).not.toMatch(/—/);
  });
});
