import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import ffmpegPath from "ffmpeg-static";
import type { ExportOutput } from "../../shared/types";
import { toAss } from "../../renderer/modules/editor/captions-core";
import { simulateCamera } from "../../renderer/modules/record/zoom-core";
import {
  computePeaks, cutAudioArgs, cutFilters, editExportArgs, exportFileName, exportWarnings, frameFilter, parseDurationMs, parseVideoSize,
  resolveFrame, sizeBitrateKbps, vp9Crf,
} from "./export-core";
import { hiresGraph, zoomCommands } from "./ffmpeg-core";

const out = (o: Partial<ExportOutput> = {}): ExportOutput => ({ preset: "original", format: "mp4", fit: "fit", quality: { mode: "crf", crf: 18 }, ...o });

describe("export arguments", () => {
  it("resolves preset frames, custom sizes and the GIF frame", () => {
    expect(resolveFrame(out(), { width: 1281, height: 720 })).toMatchObject({ W: 1282, H: 720 });
    expect(resolveFrame(out({ preset: "vertical" }), { width: 1920, height: 1080 })).toMatchObject({ W: 1080, H: 1920 });
    expect(resolveFrame(out({ preset: "custom", width: 999, height: 9999 }), { width: 1, height: 1 })).toMatchObject({ W: 1000, H: 4096 });
    expect(resolveFrame(out({ preset: "youtube", format: "gif", gif: { fps: 12, width: 480 } }), { width: 1, height: 1 })).toEqual({ W: 1920, H: 1080, gifW: 480, gifH: 270 });
  });
  it("fits with bars or fills and crops when the shape differs", () => {
    expect(frameFilter({ width: 1920, height: 1080 }, 1920, 1080, "fit")).toBe("scale=1920:1080:flags=lanczos,setsar=1");
    expect(frameFilter({ width: 1280, height: 720 }, 1920, 1080, "fit")).toBe("scale=1920:1080:flags=lanczos,setsar=1");
    expect(frameFilter({ width: 1920, height: 1080 }, 1080, 1920, "fit")).toContain("pad=1080:1920");
    expect(frameFilter({ width: 1920, height: 1080 }, 1080, 1920, "fill")).toContain("crop=1080:1920");
  });
  it("cuts with trims joined by concat", () => {
    const c = cutFilters("src", "0:a:0", [{ start: 0, end: 1000 }, { start: 2500, end: 4000 }]);
    expect(c.parts[0]).toBe("[src]split=2[ksv0][ksv1]");
    expect(c.parts).toContain("[ksv1]trim=start=2.500:end=4.000,setpts=PTS-STARTPTS[kv1]");
    expect(c.parts).toContain("[ksa0]atrim=start=0.000:end=1.000,asetpts=PTS-STARTPTS[ka0]");
    expect(c.parts[c.parts.length - 1]).toBe("[kv0][ka0][kv1][ka1]concat=n=2:v=1:a=1[kv][ka]");
    expect(cutFilters("src", null, [{ start: 500, end: Infinity }]).parts).toEqual(["[src]trim=start=0.500,setpts=PTS-STARTPTS[kv]"]);
    expect(cutFilters("src", "a", null)).toEqual({ parts: [], v: "src", a: "a" });
    expect(() => cutFilters("src", "a", [])).toThrow();
  });
  it("names files by what they are", () => {
    expect(exportFileName("composite", undefined)).toBe("take.mp4");
    expect(exportFileName("composite", out())).toBe("take.mp4");
    expect(exportFileName("composite", out({ preset: "vertical" }))).toBe("take-reels.mp4");
    expect(exportFileName("hires", out({ preset: "square", format: "webm", captions: { style: "clean", position: "bottom", margin: 0.08 } }))).toBe("take-hires-square-captions.webm");
    expect(exportFileName("composite", out({ format: "gif" }))).toBe("take.gif");
    expect(exportFileName("composite", out({ preset: "custom" }), { W: 800, H: 600 })).toBe("take-800x600.mp4");
  });
  it("works out a bitrate for a target size", () => {
    expect(sizeBitrateKbps(10, 60, 128)).toBe(1005); // 10 MB in a minute: 1333 kbps less 15% and the audio
    expect(sizeBitrateKbps(1, 600, 128)).toBe(150); // never below the floor
    expect(vp9Crf(18)).toBe(31);
  });
  it("warns about platform limits", () => {
    expect(exportWarnings(out({ preset: "x" }), 200)[0]).toContain("2:20");
    expect(exportWarnings(out({ preset: "x", quality: { mode: "size", mb: 600 } }), 60)[0]).toContain("512 MB");
    expect(exportWarnings(out({ format: "gif" }), 30)[0]).toContain("15 seconds");
    expect(exportWarnings(out(), 9999)).toEqual([]);
  });
  it("reads size and length from a probe", () => {
    expect(parseVideoSize("  Stream #0:0(eng): Video: vp8, yuv420p(tv, bt709/unknown/unknown, progressive), 1920x1080, SAR 1:1")).toEqual({ width: 1920, height: 1080 });
    expect(parseDurationMs("  Duration: 00:01:02.50, start: 0")).toBe(62500);
    expect(parseDurationMs("  Duration: N/A, start: 0")).toBeNull();
  });
  it("computes waveform peaks", () => {
    const s = new Float32Array([0.1, -0.8, 0.2, 0.3, 0, 0]);
    expect(computePeaks(s, 6, 3)).toEqual([0.8, 0.3, 0]);
  });
  it("leaves the audio out of the first of two passes", () => {
    const a = editExportArgs({
      source: { kind: "composite", input: "c.webm", fps: 30 }, srcSize: { width: 320, height: 180 }, audio: true, keep: [{ start: 0, end: 1000 }],
      loudness: "loudnorm=I=-14", output: out({ quality: { mode: "size", mb: 1 } }), out: "o.mp4", pass: { n: 1, log: "p", kbps: 500 },
    });
    expect(a.join(" ")).not.toContain("atrim");
    expect(a.join(" ")).not.toContain("loudnorm");
    expect(a.slice(-3)).toEqual(["-f", "null", "-"]);
    expect(a).toContain("-an");
  });
});

// Runs the real ffmpeg-static binary on a tiny synthetic take.
const ff = ffmpegPath && existsSync(ffmpegPath) ? ffmpegPath : null;
describe.skipIf(!ff)("export end to end", () => {
  const dir = mkdtempSync(join(tmpdir(), "take-edit-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const make = (args: string[]) => execFileSync(ff!, ["-nostdin", "-v", "error", "-y", ...args], { cwd: dir });
  make(["-f", "lavfi", "-i", "testsrc2=s=320x180:r=30:d=4", "-f", "lavfi", "-i", "sine=f=440:d=4", "-c:v", "libvpx", "-b:v", "1M", "-c:a", "libopus", "composite.webm"]);
  make(["-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=3", "-f", "lavfi", "-i", "sine=f=300:d=3", "-c:v", "libvpx", "-b:v", "500k", "-c:a", "libopus", "black.webm"]);
  make(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=4", "-c:v", "libvpx", "-b:v", "1M", "screen.webm"]);
  const probe = (file: string) => spawnSync(ff!, ["-nostdin", "-hide_banner", "-i", join(dir, file)], { encoding: "utf8" }).stderr;
  const durationOf = (file: string) => parseDurationMs(probe(file))! / 1000;
  const runArgs = (args: string[]) => {
    const r = spawnSync(ff!, args, { cwd: dir, encoding: "utf8", timeout: 120_000 });
    if (r.status !== 0) throw new Error(r.stderr.slice(-800));
    return r;
  };
  const composite = { kind: "composite" as const, input: "composite.webm", fps: 30 };

  it("cuts the composite: 4 s with a second out of the middle is 3 s, sound and picture", () => {
    const r = runArgs(editExportArgs({ source: composite, srcSize: { width: 320, height: 180 }, audio: true, keep: [{ start: 0, end: 1500 }, { start: 2500, end: 4000 }], loudness: null, output: out(), out: "cut.mp4" }));
    expect(r.stdout).toContain("progress=end");
    expect(durationOf("cut.mp4")).toBeCloseTo(3, 1);
    const streams = spawnSync(ff!, ["-nostdin", "-hide_banner", "-i", join(dir, "cut.mp4"), "-map", "0:a", "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const audioEnd = /time=(\d+):(\d+):([\d.]+)/g;
    let m: RegExpExecArray | null, last = 0;
    while ((m = audioEnd.exec(streams))) last = Number(m[3]);
    expect(last).toBeCloseTo(3, 0);
    expect(probe("cut.mp4")).toMatch(/Video: h264.*320x180/);
  }, 120_000);

  it("re-renders the hi-res screen with the zoom on the recording clock and then cuts it", () => {
    writeFileSync(join(dir, "zoom.cmd"), zoomCommands(simulateCamera([{ t: 2600, x: 0.7, y: 0.3 }], [], 4000, 30), 640, 360));
    const graph = hiresGraph({ input: "composite.webm", fps: 30, trim: { start: 0, end: null }, audio: true, screen: "screen.webm", screenSize: { width: 640, height: 360 }, cmdFile: "zoom.cmd" });
    const args = editExportArgs({
      source: { kind: "hires", graph, fps: 30 }, srcSize: { width: graph.W, height: graph.H }, audio: true,
      keep: [{ start: 2000, end: 4000 }], loudness: null, output: out({ preset: "vertical", fit: "fill" }), out: "hires-cut.mp4",
    });
    runArgs(args);
    expect(durationOf("hires-cut.mp4")).toBeCloseTo(2, 0);
    expect(probe("hires-cut.mp4")).toMatch(/Video: h264.*1080x1920/);
    expect(probe("hires-cut.mp4")).toMatch(/Audio: aac/);
  }, 120_000);

  it("cuts the hi-res render twice with the sound from the other file, without stalling", () => {
    writeFileSync(join(dir, "zoom3.cmd"), zoomCommands(simulateCamera([{ t: 2600, x: 0.7, y: 0.3 }], [], 4000, 30), 640, 360));
    const graph = hiresGraph({ input: "composite.webm", fps: 30, trim: { start: 0, end: null }, audio: true, screen: "screen.webm", screenSize: { width: 640, height: 360 }, cmdFile: "zoom3.cmd" });
    const args = editExportArgs({
      source: { kind: "hires", graph, fps: 30 }, srcSize: { width: graph.W, height: graph.H }, audio: true,
      keep: [{ start: 300, end: 1500 }, { start: 2500, end: 3700 }], loudness: null, output: out({ quality: { mode: "crf", crf: 28 } }), out: "hires-cut2.mp4",
    });
    const r = spawnSync(ff!, args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
    expect(r.signal, r.stderr.slice(-600)).toBeNull();
    expect(r.status).toBe(0);
    expect(durationOf("hires-cut2.mp4")).toBeCloseTo(2.4, 0);
  }, 120_000);

  it("survives a 1080p hi-res render cut twice and kept at its own size (ffmpeg 6.1 crashed without a final scale)", () => {
    make(["-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=4", "-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8", "screen1080.webm"]);
    writeFileSync(join(dir, "zoom4.cmd"), zoomCommands(simulateCamera([{ t: 1500, x: 0.3, y: 0.3 }, { t: 2800, x: 0.7, y: 0.6 }], [], 4000, 30), 1920, 1080));
    const graph = hiresGraph({ input: "composite.webm", fps: 30, trim: { start: 0, end: null }, audio: true, screen: "screen1080.webm", screenSize: { width: 1920, height: 1080 }, cmdFile: "zoom4.cmd" });
    const args = editExportArgs({
      source: { kind: "hires", graph, fps: 30 }, srcSize: { width: graph.W, height: graph.H }, audio: true,
      keep: [{ start: 1000, end: 2000 }, { start: 2600, end: 3900 }], loudness: null, output: out({ preset: "youtube", quality: { mode: "crf", crf: 30 } }), out: "hires-1080.mp4",
    });
    const r = spawnSync(ff!, args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
    expect(r.status, r.stderr.slice(-400)).toBe(0);
    expect(probe("hires-1080.mp4")).toMatch(/Video: h264.*1920x1080/);
    expect(durationOf("hires-1080.mp4")).toBeCloseTo(2.3, 0);
  }, 120_000);

  it("makes a GIF with a palette at its own frame rate and width", () => {
    runArgs(editExportArgs({ source: composite, srcSize: { width: 320, height: 180 }, audio: true, keep: [{ start: 0, end: 2000 }], loudness: null, output: out({ format: "gif", gif: { fps: 10, width: 160 } }), out: "take.gif" }));
    const p = probe("take.gif");
    expect(p).toMatch(/Video: gif.*160x90/);
    expect(p).toMatch(/10 fps/);
    expect(p).not.toMatch(/Audio/);
  }, 120_000);

  it("hits a target file size with two passes", () => {
    const base = { source: composite, srcSize: { width: 320, height: 180 }, audio: true, keep: null, loudness: null, output: out({ quality: { mode: "size", mb: 0.25 } }), out: "sized.mp4" };
    const kbps = sizeBitrateKbps(0.25, 4, 128);
    runArgs(editExportArgs({ ...base, pass: { n: 1, log: "ffpass", kbps } }));
    runArgs(editExportArgs({ ...base, pass: { n: 2, log: "ffpass", kbps } }));
    const mb = statSync(join(dir, "sized.mp4")).size / 1e6;
    expect(mb).toBeLessThanOrEqual(0.25);
    expect(mb).toBeGreaterThan(0.25 * 0.5);
  }, 120_000);

  it("writes WebM with VP9 and Opus", () => {
    runArgs(editExportArgs({ source: composite, srcSize: { width: 320, height: 180 }, audio: true, keep: [{ start: 1000, end: 2000 }], loudness: null, output: out({ preset: "square", format: "webm", quality: { mode: "crf", crf: 28 } }), out: "sq.webm" }));
    expect(probe("sq.webm")).toMatch(/Video: vp9.*1080x1080/);
    expect(probe("sq.webm")).toMatch(/Audio: opus/);
  }, 120_000);

  it("measures loudness on the cut audio only", () => {
    const r = spawnSync(ff!, cutAudioArgs("composite.webm", [{ start: 0, end: 1000 }, { start: 3000, end: 4000 }], "loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json"), { cwd: dir, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("input_i");
  }, 60_000);

  it("burns captions in with libass and the bundled font, on the edited timeline", () => {
    mkdirSync(join(dir, ".fonts"), { recursive: true });
    copyFileSync(resolve("node_modules/geist/dist/fonts/geist-sans/Geist-Bold.ttf"), join(dir, ".fonts", "Geist-Bold.ttf"));
    // the caption is at 0.2 - 1.8 s on the EDITED timeline (the first second of the take is cut)
    writeFileSync(join(dir, "captions.ass"), toAss([{ id: "a", start: 200, end: 1800, words: [{ text: "Hello", start: 200, end: 800 }, { text: "there", start: 900, end: 1800 }] }],
      { style: "boxed", position: "bottom", margin: 0.08 }, 320, 180));
    const args = editExportArgs({ source: { ...composite, input: "black.webm" }, srcSize: { width: 320, height: 180 }, audio: true, keep: [{ start: 1000, end: 3000 }], loudness: null, output: out({ captions: { style: "boxed", position: "bottom", margin: 0.08 } }), burn: { ass: "captions.ass", fontsDir: ".fonts" }, out: "burned.mp4" });
    const r = runArgs(args);
    expect(r.stderr).not.toMatch(/fontselect: failed|No font/i);
    const strip = (t: number) => {
      const raw = spawnSync(ff!, ["-nostdin", "-v", "error", "-ss", String(t), "-i", join(dir, "burned.mp4"), "-frames:v", "1", "-vf", "crop=320:60:0:120,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 24 }).stdout as Buffer;
      return Math.max(...raw);
    };
    expect(strip(1.0)).toBeGreaterThan(200); // white letters on the black frame
    expect(strip(1.95)).toBeLessThan(40); // gone after the caption ends
  }, 120_000);
});
