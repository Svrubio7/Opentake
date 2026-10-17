// MP4 export with ffmpeg-static: optional silence trim, two-pass loudnorm, progress from -progress.
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import ffmpegStatic from "ffmpeg-static";
import type { ExportOptions, ExportProgress, TakeFiles } from "../../shared/types";
import { cropSource, toCropSpace } from "../../renderer/modules/record/layout-core";
import { DEFAULT_ZOOM, estimateDwellClicks, simulateCamera } from "../../renderer/modules/record/zoom-core";
import {
  SILENCE_FILTER, compositeArgs, hasAudioStream, hiresArgs, hiresFrame, loudnormFilter, parseLoudnorm, parseProgressTime,
  parseSilenceTrim, zoomCommands,
} from "./ffmpeg-core";
import { exportEdited, wantsEditedExport } from "./export-edit";
import { readMeta, readTimeline, takeDir, takeFiles, type TakeMeta } from "./takes";

// inside a packaged app the binary lives in app.asar.unpacked
export const ffmpegPath = () => (ffmpegStatic ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");

const running = new Map<string, ChildProcess>();
const cancelled = new Set<string>();

export function run(takeId: string, args: string[], cwd: string, onStdout?: (s: string) => void): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (cancelled.has(takeId)) return reject(new Error("Export cancelled"));
    const p = spawn(ffmpegPath(), args, { cwd, windowsHide: true });
    running.set(takeId, p);
    let stderr = "";
    p.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
    });
    p.stdout.on("data", (d: Buffer) => onStdout?.(d.toString()));
    p.on("error", reject);
    p.on("close", (code) => {
      running.delete(takeId);
      if (cancelled.has(takeId)) reject(new Error("Export cancelled"));
      else resolve({ code: code ?? -1, stderr });
    });
  });
}

const tail = (s: string) => s.trim().split(/\r?\n/).slice(-4).join(" | ");

export function cancelExport(takeId: string) {
  const p = running.get(takeId);
  if (!p) return false;
  cancelled.add(takeId);
  p.kill("SIGKILL");
  return true;
}

export async function exportTake(o: ExportOptions, send: (p: ExportProgress) => void): Promise<string> {
  const { takeId } = o;
  if (running.has(takeId)) throw new Error("This take is already exporting");
  cancelled.delete(takeId);
  const dir = takeDir(takeId);
  const meta = await readMeta(takeId);
  const files = takeFiles(takeId, meta);
  if (!files.composite) throw new Error("This take has no recording file");
  const progress = (stage: string, ratio: number | null) => send({ takeId, stage, ratio });

  try {
    if (await wantsEditedExport(o)) {
      const out = await exportEdited(o, { dir, meta, files, run: (args, onStdout) => run(takeId, args, dir, onStdout), progress, hiresSource });
      send({ takeId, stage: "Done", ratio: 1, done: true, output: out });
      return out;
    }
    progress("Reading the take", 0);
    const probe = await run(takeId, ["-nostdin", "-hide_banner", "-i", files.composite], dir);
    const audio = hasAudioStream(probe.stderr);
    const durationSec = meta.durationMs != null ? meta.durationMs / 1000 : null;

    let trim = { start: 0, end: null as number | null };
    if (o.trimSilence && audio) {
      progress("Finding silence", 0.02);
      const r = await run(takeId, ["-nostdin", "-hide_banner", "-i", files.composite, "-vn", "-af", SILENCE_FILTER, "-f", "null", "-"], dir);
      trim = parseSilenceTrim(r.stderr, durationSec);
    }
    const trimArgs = [
      ...(trim.start > 0 ? ["-ss", trim.start.toFixed(3)] : []),
      ...(trim.end != null ? ["-t", (trim.end - trim.start).toFixed(3)] : []),
    ];

    let loudness: string | null = null;
    if (o.loudness !== "off" && audio) {
      progress("Measuring loudness", 0.05);
      const r = await run(takeId, ["-nostdin", "-hide_banner", ...trimArgs, "-i", files.composite, "-vn", "-af", loudnormFilter(o.loudness), "-f", "null", "-"], dir);
      const m = parseLoudnorm(r.stderr);
      loudness = m ? loudnormFilter(o.loudness, m) : null;
    }

    const encodeMs = (trim.end ?? durationSec ?? 0) * 1000 - trim.start * 1000;
    const onProgress = (s: string) => {
      const t = parseProgressTime(s);
      if (t != null) progress("Encoding MP4", encodeMs > 0 ? Math.min(0.99, 0.1 + 0.9 * (t / encodeMs)) : null);
    };

    let out: string;
    let args: string[];
    if (o.kind === "hires") {
      out = join(dir, "take-hires.mp4");
      args = hiresArgs({ ...(await hiresSource(takeId, dir, meta, files, trim.start * 1000)), out, trim, audio, loudness });
    } else {
      out = join(dir, "take.mp4");
      args = compositeArgs({ input: files.composite, out, fps: meta.fps || 30, trim, audio, loudness });
    }

    progress("Encoding MP4", 0.1);
    const r = await run(takeId, args, dir, onProgress);
    if (r.code !== 0) throw new Error(`ffmpeg failed: ${tail(r.stderr)}`);
    send({ takeId, stage: "Done", ratio: 1, done: true, output: out });
    return out;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    send({ takeId, stage: "Failed", ratio: null, done: true, error: msg });
    throw e;
  } finally {
    cancelled.delete(takeId);
  }
}

/**
 * The hi-res render's inputs: the zoom redone from the click timeline into zoom.cmd (times shifted
 * by offsetMs, where the export starts), the crop and the camera bubble. Shared with the editor export.
 */
export async function hiresSource(takeId: string, dir: string, meta: TakeMeta, files: TakeFiles, offsetMs: number) {
  const timeline = await readTimeline(takeId);
  if (!files.composite || !files.screen || !timeline?.screenSize) throw new Error("This take has no separate screen track to re-render");
  if (timeline.scenes?.length) throw new Error("This take switches scenes. Hi-res follows one layout, so export the MP4 instead.");
  const fps = timeline.layout.fps;
  const durationMs = meta.durationMs ?? timeline.cursor[timeline.cursor.length - 1]?.t ?? 0;
  // the timeline holds raw display positions: the zoom is redone inside the cropped picture
  const crop = timeline.layout.crop;
  const cursor = timeline.cursor.map((p) => toCropSpace(p, crop));
  const clicks = (timeline.hooks ? timeline.clicks : estimateDwellClicks(timeline.cursor)).map((p) => toCropSpace(p, crop));
  const zoom = timeline.layout.zoom.enabled ? { ...DEFAULT_ZOOM, scale: timeline.layout.zoom.scale } : { ...DEFAULT_ZOOM, scale: 1 };
  const frames = simulateCamera(timeline.layout.zoom.enabled ? clicks : [], cursor, durationMs, fps, zoom);
  const kept = cropSource(crop, timeline.screenSize.width, timeline.screenSize.height);
  const frame = hiresFrame(timeline.screenSize, kept);
  await writeFile(join(dir, "zoom.cmd"), zoomCommands(frames, frame.W, frame.H, offsetMs));
  const withCamera = timeline.layout.mode === "screen-camera" && files.camera;
  return {
    input: files.composite, fps,
    screen: files.screen, screenSize: timeline.screenSize, crop: kept,
    camera: withCamera ? files.camera : null, bubble: withCamera ? timeline.layout.bubble : null,
    cmdFile: "zoom.cmd",
  };
}
