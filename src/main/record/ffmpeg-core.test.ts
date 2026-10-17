import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import ffmpegPath from "ffmpeg-static";
import { simulateCamera } from "../../renderer/modules/record/zoom-core";
import {
  compositeArgs, hasAudioStream, hiresArgs, hiresFrame, loudnormFilter, parseLoudnorm, parseProgressTime, parseSilenceTrim,
  takeFolderName, validTakeId, zoomChainRect, zoomCommands,
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
    expect(s[1]).toBe("0.050 crop@zin w 962, crop@zin h 542, crop@zin x 0, crop@zin y 0, scale@zs w 1924, scale@zs h 1084, crop@zout x 0, crop@zout y 0;");
  });
  it("times every line before its frame (a line at 0.067 for a frame at 66.667 ms lands a frame late)", () => {
    const frames = Array.from({ length: 90 }, (_, i) => ({ t: (i * 1000) / 30, scale: 1 + i / 100, x: 0.5, y: 0.5 }));
    const times = zoomCommands(frames, 1920, 1080).trim().split("\n").map((l) => Number(l.split(" ")[0]));
    times.slice(1).forEach((t, i) => {
      const frameT = (i + 1) / 30;
      expect(t).toBeLessThan(frameT);
      expect(t).toBeGreaterThan(frameT - 1 / 30);
    });
  });
  it("places the zoomed view within half an output pixel of the camera (a crop alone is off by up to 2 source pixels)", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (const [w, h] of [[1920, 1080], [3840, 2160], [1366, 768]]) {
      for (let i = 0; i < 500; i++) {
        const f = { scale: 1 + rnd() * 1.4, x: rnd(), y: rnd() };
        const r = zoomChainRect(f, w, h);
        expect(r.crop.w % 2 + r.crop.h % 2 + r.crop.x % 2 + r.crop.y % 2).toBe(0);
        expect(r.crop.x + r.crop.w).toBeLessThanOrEqual(w);
        expect(r.crop.y + r.crop.h).toBeLessThanOrEqual(h);
        expect(r.out.x + w).toBeLessThanOrEqual(r.scale.w);
        expect(r.out.y + h).toBeLessThanOrEqual(r.scale.h);
        // where two source points land in the output, against the exact camera
        const cw = w / f.scale, L = Math.min(w - cw, Math.max(0, f.x * w - cw / 2));
        const ch = h / f.scale, T = Math.min(h - ch, Math.max(0, f.y * h - ch / 2));
        for (const [px, py] of [[L, T], [L + cw, T + ch]]) {
          const ux = (px - r.crop.x) * (r.scale.w / r.crop.w) - r.out.x, uy = (py - r.crop.y) * (r.scale.h / r.crop.h) - r.out.y;
          expect(Math.abs(ux - (px - L) * f.scale)).toBeLessThan(1.6);
          expect(Math.abs(uy - (py - T) * f.scale)).toBeLessThan(1.6);
        }
      }
    }
  });
  it("sets the hi-res length outright and never uses -shortest", () => {
    const base = { input: "c.webm", out: "o.mp4", fps: 30, trim: { start: 0, end: null }, audio: true, screen: "s.webm", screenSize: { width: 640, height: 360 }, cmdFile: "z.cmd" };
    expect(hiresArgs({ ...base, limitSec: 12.5 })).not.toContain("-shortest");
    expect(hiresArgs({ ...base, limitSec: 12.5 }).join(" ")).toContain("-t 12.500");
    expect(hiresArgs(base)).not.toContain("-t");
  });
  it("starts the script at zero after a trim", () => {
    const frames = [{ t: 0, scale: 2, x: 0.5, y: 0.5 }, { t: 2000, scale: 2, x: 0.5, y: 0.5 }];
    expect(zoomCommands(frames, 100, 100, 1000).startsWith("0.000 crop@zin w 56")).toBe(true);
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

  it("re-renders a 1080p screen with a changing zoom without crashing (ffmpeg 6.1 segfaulted here)", () => {
    make(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=3", "-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8", "screen1080.webm"]);
    writeFileSync(join(dir, "zoom1080.cmd"), zoomCommands(simulateCamera([{ t: 800, x: 0.3, y: 0.3 }, { t: 2000, x: 0.7, y: 0.6 }], [], 3000, 30), 1920, 1080));
    const args = hiresArgs({
      input: "composite.webm", out: "take-hires1080.mp4", fps: 30, trim: { start: 0.2, end: 2.8 }, audio: true, limitSec: 2.6,
      screen: "screen1080.webm", screenSize: { width: 1920, height: 1080 }, cmdFile: "zoom1080.cmd",
    });
    const r = spawnSync(ff!, args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr.slice(-300)).toBe(0);
    expect(durationOf(join(dir, "take-hires1080.mp4"))).toBeCloseTo(2.6, 0);
  }, 120_000);

  it("re-renders a cropped screen with a bordered rectangle camera", () => {
    const crop = { x: 64, y: 0, w: 512, h: 324 };
    const frame = hiresFrame({ width: 640, height: 360 }, crop);
    expect(frame).toMatchObject({ W: 512, H: 324 });
    writeFileSync(join(dir, "zoom2.cmd"), zoomCommands(simulateCamera([{ t: 500, x: 0.4, y: 0.6 }], [], 2000, 30), frame.W, frame.H));
    const args = hiresArgs({
      input: "composite.webm", out: "take-hires2.mp4", fps: 30, trim: { start: 0, end: null }, audio: true,
      screen: "screen.webm", screenSize: { width: 640, height: 360 }, crop, camera: "camera.webm",
      bubble: { cx: 0.2, cy: 0.75, size: 0.4, shape: "rounded", aspect: 0.75, radius: 0.3, border: 8, borderColor: "#ff0000" }, cmdFile: "zoom2.cmd",
    });
    expect(args.join(" ")).toContain("crop=512:324:64:0,");
    expect(args.join(" ")).toContain("color=c=0xff0000");
    const r = spawnSync(ff!, args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
    expect(r.stderr.slice(-400)).not.toMatch(/Error|Invalid/);
    expect(r.status).toBe(0);
    const probe = spawnSync(ff!, ["-nostdin", "-hide_banner", "-i", join(dir, "take-hires2.mp4")], { encoding: "utf8" }).stderr;
    expect(probe).toMatch(/Video: h264.*512x324/);
    expect(durationOf(join(dir, "take-hires2.mp4"))).toBeGreaterThan(1);
  }, 60_000);
});
