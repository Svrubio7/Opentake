// MP4 export with ffmpeg-static: optional silence trim, two-pass loudnorm, progress from -progress.
import type { BrowserWindow } from "electron";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
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
import { runWatched } from "./ffmpeg-run";
import { readMeta, readTimeline, recordExport, takeDir, takeFiles, type TakeMeta } from "./takes";
import { exportTarget, releaseExportName } from "./export-target";
import { openPath, revealFile } from "../dialogs";
import { getSettings } from "../settings";
import { friendlyExportError } from "../settings-core";
import { t } from "../../shared/i18n";

// inside a packaged app the binary lives in app.asar.unpacked
export const ffmpegPath = () => (ffmpegStatic ?? "ffmpeg").replace("app.asar", "app.asar.unpacked");

const running = new Map<string, ChildProcess>();
const cancelled = new Set<string>();
/** takes between Export and the first ffmpeg run (the Save dialog may be open) */
const preparing = new Set<string>();

/** How many exports are running now (quitting asks first). */
export const exportsRunning = () => new Set([...running.keys(), ...preparing]).size;
export const cancelAllExports = () => { for (const id of running.keys()) cancelExport(id); };

export function run(takeId: string, args: string[], cwd: string, onStdout?: (s: string) => void): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (cancelled.has(takeId)) return reject(new Error("Export cancelled"));
    // a run that stops moving is stopped with an error instead of hanging (ffmpeg-run.ts)
    runWatched(ffmpegPath(), args, { cwd, onStdout, onSpawn: (p) => running.set(takeId, p) }).then(
      (r) => { running.delete(takeId); if (cancelled.has(takeId)) reject(new Error("Export cancelled")); else resolve(r); },
      (e) => { running.delete(takeId); reject(cancelled.has(takeId) ? new Error("Export cancelled") : e); },
    );
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

export async function exportTake(o: ExportOptions, send: (p: ExportProgress) => void, win: BrowserWindow | null = null): Promise<string> {
  const { takeId } = o;
  if (running.has(takeId) || preparing.has(takeId)) throw new Error(t("main.export.alreadyExporting"));
  cancelled.delete(takeId);
  const dir = takeDir(takeId);
  const meta = await readMeta(takeId);
  const files = takeFiles(takeId, meta);
  if (!files.composite) throw new Error(t("main.export.noRecording"));
  const progress = (stage: string, ratio: number | null) => send({ takeId, stage, ratio });

  let out: string | null = null;
  try {
    preparing.add(takeId);
    out = await exportTarget(o, meta, dir, win);
    if (!out) {
      // the Save dialog was cancelled: nothing to report
      send({ takeId, stage: t("main.export.notExported"), ratio: null, done: true });
      return "";
    }
    if (await wantsEditedExport(o)) {
      await exportEdited(o, { dir, meta, files, out, run: (args, onStdout) => run(takeId, args, dir, onStdout), progress, hiresSource });
      await finished(o, out);
      send({ takeId, stage: t("main.export.done"), ratio: 1, done: true, output: out });
      return out;
    }
    progress(t("main.export.reading"), 0);
    const probe = await run(takeId, ["-nostdin", "-hide_banner", "-i", files.composite], dir);
    const audio = hasAudioStream(probe.stderr);
    const durationSec = meta.durationMs != null ? meta.durationMs / 1000 : null;

    let trim = { start: 0, end: null as number | null };
    if (o.trimSilence && audio) {
      progress(t("main.export.findingSilence"), 0.02);
      const r = await run(takeId, ["-nostdin", "-hide_banner", "-i", files.composite, "-vn", "-af", SILENCE_FILTER, "-f", "null", "-"], dir);
      trim = parseSilenceTrim(r.stderr, durationSec);
    }
    const trimArgs = [
      ...(trim.start > 0 ? ["-ss", trim.start.toFixed(3)] : []),
      ...(trim.end != null ? ["-t", (trim.end - trim.start).toFixed(3)] : []),
    ];

    let loudness: string | null = null;
    if (o.loudness !== "off" && audio) {
      progress(t("main.export.measuringLoudness"), 0.05);
      const r = await run(takeId, ["-nostdin", "-hide_banner", ...trimArgs, "-i", files.composite, "-vn", "-af", loudnormFilter(o.loudness), "-f", "null", "-"], dir);
      const m = parseLoudnorm(r.stderr);
      loudness = m ? loudnormFilter(o.loudness, m) : null;
    }

    const encodeMs = (trim.end ?? durationSec ?? 0) * 1000 - trim.start * 1000;
    const onProgress = (s: string) => {
      const at = parseProgressTime(s);
      if (at != null) progress(t("main.export.encoding", { format: "MP4" }), encodeMs > 0 ? Math.min(0.99, 0.1 + 0.9 * (at / encodeMs)) : null);
    };

    const target = out;
    const args = o.kind === "hires"
      ? hiresArgs({ ...(await hiresSource(takeId, dir, meta, files, trim.start * 1000)), out: target, trim, audio, loudness, limitSec: encodeMs > 0 ? encodeMs / 1000 : null })
      : compositeArgs({ input: files.composite, out: target, fps: meta.fps || 30, trim, audio, loudness });

    progress(t("main.export.encoding", { format: "MP4" }), 0.1);
    const r = await run(takeId, args, dir, onProgress);
    if (r.code !== 0) {
      await rm(target, { force: true }).catch(() => {}); // no half-written file left behind
      throw new Error(t("main.export.ffmpegFailed", { detail: tail(r.stderr) }));
    }
    await finished(o, target);
    send({ takeId, stage: t("main.export.done"), ratio: 1, done: true, output: target });
    return target;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (out && cancelled.has(takeId)) await rm(out, { force: true }).catch(() => {});
    if (!/cancelled/i.test(msg)) console.warn(`[export] ${takeId}: ${msg}`);
    send({ takeId, stage: t("main.export.failed"), ratio: null, done: true, error: friendlyExportError(msg) });
    throw e;
  } finally {
    if (out) releaseExportName(out);
    preparing.delete(takeId);
    cancelled.delete(takeId);
  }
}

/** Lists the export on its take and, for an export a person started, shows or opens it. */
async function finished(o: ExportOptions, out: string) {
  const stem = out.replace(/\.\w+$/, "");
  const beside = [`${stem}.srt`, `${stem}.vtt`].filter((f) => existsSync(f));
  await recordExport(o.takeId, [out, ...beside]).catch(() => {});
  if (!o.manual) return;
  const after = getSettings().afterExport;
  if (after === "reveal") revealFile(out);
  else if (after === "open") await openPath(out);
}

/**
 * The hi-res render's inputs: the zoom redone from the click timeline into zoom.cmd (times shifted
 * by offsetMs, where the export starts), the crop and the camera bubble. Shared with the editor export.
 */
export async function hiresSource(takeId: string, dir: string, meta: TakeMeta, files: TakeFiles, offsetMs: number) {
  const timeline = await readTimeline(takeId);
  if (!files.composite || !files.screen || !timeline?.screenSize) throw new Error(t("main.export.noScreenTrack"));
  if (timeline.scenes?.length) throw new Error(t("main.export.scenesHires"));
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
