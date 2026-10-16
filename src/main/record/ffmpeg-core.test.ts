import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import ffmpegPath from "ffmpeg-static";
import { simulateCamera } from "../../renderer/modules/record/zoom-core";
import {
  compositeArgs, hasAudioStream, hiresArgs, loudnormFilter, parseLoudnorm, parseProgressTime, parseSilenceTrim,
  takeFolderName, validTakeId, zoomCommands,
} from "./ffmpeg-core";

describe("parsing", () => {
  it("reads progress in ms", () => {
    expect(parseProgressTime("frame=10\nout_time_us=1500000\nprogress=continue\n")).toBe(1500);
    expect(parseProgressTime("frame=10\n")).toBeNull();
  });
  it("detects an audio stream", () => {
    expect(hasAudioStream("  Stream #0:1: Audio: opus, 48000 Hz")).toBe(true);
    expect(hasAudioStream("  Stream #0:0: Video: vp9")).toBe(false);
  });
  it("reads loudnorm's measure and builds the second pass", () => {
    const log = `[Parsed_loudnorm_0 @ 0x1]\n{\n"input_i" : "-27.61",\n"input_tp" : "-4.47",\n"input_lra" : "18.06",\n"input_thresh" : "-39.20",\n"output_i" : "-14.0",\n"target_offset" : "0.58"\n}\n`;
    const m = parseLoudnorm(log)!;
    expect(m.input_i).toBe("-27.61");
    expect(loudnormFilter("-14", m)).toContain("measured_I=-27.61");
    expect(loudnormFilter("-16")).toBe("loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json");
    expect(parseLoudnorm(`{"input_i" : "-inf"}`)).toBeNull();
  });
  it("trims leading and trailing silence with air", () => {
    const log = "silence_start: 0\nsilence_end: 1.8 | silence_duration: 1.8\nsilence_start: 4\nsilence_end: 4.6\nsilence_start: 9.2\n";
    const t = parseSilenceTrim(log, 11);
    expect(t.start).toBeCloseTo(1.55);
    expect(t.end).toBeCloseTo(9.6);
  });
  it("handles a final silence_end at the end of the file", () => {
    const t = parseSilenceTrim("silence_start: 8\nsilence_end: 10 | silence_duration: 2\n", 10);
    expect(t).toEqual({ start: 0, end: 8.4 });
  });
  it("keeps a take that is all silence", () => {
    expect(parseSilenceTrim("silence_start: 0\n", 5)).toEqual({ start: 0, end: null });
  });
  it("names folders without colons and validates ids", () => {
    expect(takeFolderName(new Date(2026, 9, 16, 9, 5, 3))).toBe("2026-10-16 09.05.03");
    expect(validTakeId("2026-10-16 09.05.03 (2)")).toBe(true);
    expect(validTakeId("../etc")).toBe(false);
    expect(validTakeId("a/b")).toBe(false);
    expect(validTakeId("a\\b")).toBe(false);
  });
  it("writes a sendcmd script only when the crop changes", () => {
    const frames = [
      { t: 0, scale: 1, x: 0.5, y: 0.5 },
      { t: 33, scale: 1, x: 0.5, y: 0.5 },
      { t: 66, scale: 2, x: 0.25, y: 0.25 },
    ];
    const s = zoomCommands(frames, 1920, 1080).trim().split("\n");
    expect(s).toHaveLength(2);
    expect(s[1]).toBe("0.066 crop@zoom w 960, crop@zoom h 540, crop@zoom x 0, crop@zoom y 0;");
  });
  it("starts the script at zero after a trim", () => {
    const frames = [{ t: 0, scale: 2, x: 0.5, y: 0.5 }, { t: 2000, scale: 2, x: 0.5, y: 0.5 }];
    expect(zoomCommands(frames, 100, 100, 1000).startsWith("0.000 crop@zoom w 50")).toBe(true);
  });
});

// Runs the real ffmpeg-static binary on a tiny synthetic take.
const ff = ffmpegPath && existsSync(ffmpegPath) ? ffmpegPath : null;
describe.skipIf(!ff)("ffmpeg end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "take-ff-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const make = (args: string[]) => execFileSync(ff!, ["-nostdin", "-v", "error", "-y", ...args], { cwd: dir });
  make(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=440:d=3", "-c:v", "libvpx", "-b:v", "1M", "-c:a", "libopus", "composite.webm"]);
  make(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3", "-c:v", "libvpx", "-b:v", "1M", "screen.webm"]);
  make(["-f", "lavfi", "-i", "testsrc=s=320x240:r=30:d=3", "-c:v", "libvpx", "-b:v", "1M", "camera.webm"]);
  const durationOf = (file: string) => {
    const r = spawnSync(ff!, ["-nostdin", "-hide_banner", "-i", file], { encoding: "utf8" });
    const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr)!;
    return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  };

  it("exports the composite to mp4", () => {
    const args = compositeArgs({ input: "composite.webm", out: "take.mp4", fps: 30, trim: { start: 0.5, end: 2.5 }, audio: true, loudness: null });
    const r = spawnSync(ff!, args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("progress=end");
    expect(durationOf(join(dir, "take.mp4"))).toBeCloseTo(2, 0);
  }, 60_000);

  it("re-renders the screen with a changing zoom and a camera bubble without stalling", () => {
    const frames = simulateCamera([{ t: 800, x: 0.7, y: 0.3 }], [], 3000, 30);
    writeFileSync(join(dir, "zoom.cmd"), zoomCommands(frames, 640, 360));
    expect(readFileSync(join(dir, "zoom.cmd"), "utf8").split("\n").length).toBeGreaterThan(10);
    const args = hiresArgs({
      input: "composite.webm", out: "take-hires.mp4", fps: 30, trim: { start: 0, end: null }, audio: true,
      loudness: loudnormFilter("-14", null).replace(":print_format=json", ""),
      screen: "screen.webm", screenSize: { width: 640, height: 360 }, camera: "camera.webm",
      bubble: { cx: 0.85, cy: 0.8, size: 0.3, shape: "circle" }, cmdFile: "zoom.cmd",
    });
    const r = spawnSync(ff!, args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
    expect(r.stderr.slice(-400)).not.toMatch(/Error|Invalid/);
    expect(r.status).toBe(0);
    const probe = spawnSync(ff!, ["-nostdin", "-hide_banner", "-i", join(dir, "take-hires.mp4")], { encoding: "utf8" }).stderr;
    expect(probe).toMatch(/Video: h264.*640x360/);
    expect(probe).toMatch(/Audio: aac/);
  }, 60_000);
});
