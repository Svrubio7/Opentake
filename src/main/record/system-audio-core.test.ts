import { describe, expect, it } from "vitest";
import { loopbackFeatures, mergeFeatures, systemAudioSupport } from "./system-audio-core";

describe("systemAudioSupport", () => {
  it("is on for Windows and Linux", () => {
    expect(systemAudioSupport("win32", "10.0.26200").supported).toBe(true);
    expect(systemAudioSupport("linux", "6.8.0").supported).toBe(true);
  });
  it("needs macOS 13 (Darwin 22) or newer", () => {
    expect(systemAudioSupport("darwin", "22.1.0").supported).toBe(true);
    expect(systemAudioSupport("darwin", "24.0.0").supported).toBe(true);
    const old = systemAudioSupport("darwin", "21.6.0");
    expect(old.supported).toBe(false);
    expect(old.reason).toMatch(/macOS 13/);
    expect(systemAudioSupport("darwin", "").supported).toBe(false);
  });
  it("says no, with a reason, elsewhere", () => {
    const r = systemAudioSupport("freebsd", "14");
    expect(r.supported).toBe(false);
    expect(r.reason).toBeTruthy();
  });
});

describe("loopback features", () => {
  it("asks for nothing on Windows", () => expect(loopbackFeatures("win32")).toEqual([]));
  it("turns on ScreenCaptureKit audio on macOS and Pulse loopback on Linux", () => {
    expect(loopbackFeatures("darwin")).toContain("MacLoopbackAudioForScreenShare");
    expect(loopbackFeatures("linux")).toEqual(["PulseaudioLoopbackForScreenShare"]);
  });
  it("keeps features already switched on", () => {
    expect(mergeFeatures("", ["A"])).toBe("A");
    expect(mergeFeatures("X, A", ["A", "B"])).toBe("X,A,B");
  });
});
