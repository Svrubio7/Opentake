import { describe, expect, it } from "vitest";
import { meterFill, peakDb, pickAudioMime, systemAudioKey, systemAudioWanted } from "./system-audio-core";

describe("computer sound switch", () => {
  const defaults = { systemAudio: true, systemAudioCamera: false };
  it("is on for screen takes and off for camera-only takes by default", () => {
    expect(systemAudioWanted("screen", defaults)).toBe(true);
    expect(systemAudioWanted("screen-camera", defaults)).toBe(true);
    expect(systemAudioWanted("camera", defaults)).toBe(false);
  });
  it("keeps one setting for screen takes and one for camera takes", () => {
    expect(systemAudioKey("screen")).toBe("systemAudio");
    expect(systemAudioKey("camera")).toBe("systemAudioCamera");
    expect(systemAudioWanted("camera", { systemAudio: false, systemAudioCamera: true })).toBe(true);
  });
});

describe("meter", () => {
  it("reads the peak in dBFS", () => {
    expect(peakDb([0, 0.5, -1, 0.25])).toBeCloseTo(0, 6);
    expect(peakDb([0.1, -0.05])).toBeCloseTo(-20, 6);
    expect(peakDb(new Float32Array(128))).toBe(-100);
  });
  it("fills from -60 dB to 0 dB", () => {
    expect(meterFill(-100)).toBe(0);
    expect(meterFill(-30)).toBeCloseTo(0.5);
    expect(meterFill(3)).toBe(1);
  });
});

describe("pickAudioMime", () => {
  it("prefers Opus in WebM and falls back to plain WebM", () => {
    expect(pickAudioMime(() => true)).toBe("audio/webm;codecs=opus");
    expect(pickAudioMime((m) => m === "audio/webm")).toBe("audio/webm");
    expect(pickAudioMime(() => false)).toBe("");
  });
});
