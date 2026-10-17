// The editor's export: the take's cuts, a frame preset, MP4 / WebM / GIF, quality or a target size,
// and captions burned in. Arguments come from export-core.ts; this file runs them in order.
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExportOptions, TakeFiles, TimeRange } from "../../shared/types";
import { remapLines, toAss, toSrt, toVtt } from "../../renderer/modules/editor/captions-core";
import { clipEdited, keptDuration, mergeTouching, wholeTake } from "../../renderer/modules/editor/edit-core";
import geistBold from "../../../node_modules/geist/dist/fonts/geist-sans/Geist-Bold.ttf?asset";
import { cutsSomething, readCaptions, readEdit } from "./editor-store";
import {
  AUDIO_KBPS, cutAudioArgs, editExportArgs, parseDurationMs, parseVideoSize, resolveFrame, sizeBitrateKbps,
  type SourceGraph,
} from "./export-core";
import { SILENCE_FILTER, hasAudioStream, hiresGraph, loudnormFilter, parseLoudnorm, parseProgressTime, parseSilenceTrim } from "./ffmpeg-core";
import { readMeta, type TakeMeta } from "./takes";

type Run = (args: string[], onStdout?: (s: string) => void) => Promise<{ code: number; stderr: string }>;
type HiresSource = (takeId: string, dir: string, meta: TakeMeta, files: TakeFiles, offsetMs: number) => Promise<Omit<Parameters<typeof hiresGraph>[0], "trim" | "audio">>;

export interface EditedContext {
  dir: string;
  /** where the export goes (the name and folder come from Settings, export-target.ts) */
  out: string;
  meta: TakeMeta;
  files: TakeFiles;
  run: Run;
  progress: (stage: string, ratio: number | null) => void;
  hiresSource: HiresSource;
}

const tail = (s: string) => s.trim().split(/\r?\n/).slice(-4).join(" | ");

/** This export needs the editor path: the take has an edit, or a frame, format or captions were asked for. */
export async function wantsEditedExport(o: ExportOptions): Promise<boolean> {
  const out = o.output;
  if (out && (out.preset !== "original" || out.format !== "mp4" || out.captions || out.quality.mode !== "crf" || out.quality.crf !== 18)) return true;
  // captions on file: the export writes its matching .srt and .vtt
  if ((await readCaptions(o.takeId))?.lines.length) return true;
  if (o.useEdit === false) return false;
  const meta = await readMeta(o.takeId);
  return cutsSomething(await readEdit(o.takeId, meta.durationMs), meta.durationMs);
}

let burnable: boolean | null = null;
/** The bundled ffmpeg has libass (the Windows and Linux builds do). */
export async function canBurnCaptions(run: Run): Promise<boolean> {
  if (burnable != null) return burnable;
  let list = "";
  const r = await run(["-hide_banner", "-filters"], (s) => { list += s; });
  burnable = /\bass\s+V->V/.test(list + r.stderr);
  return burnable;
}

export async function exportEdited(o: ExportOptions, c: EditedContext): Promise<string> {
  const { dir, meta, files, run, progress } = c;
  const output = o.output ?? { preset: "original", format: "mp4", fit: "fit", quality: { mode: "crf", crf: 18 } };
  if (!files.composite) throw new Error("This take has no recording file");
  progress("Reading the take", 0);
  const probe = await run(["-nostdin", "-hide_banner", "-i", files.composite]);
  const audio = hasAudioStream(probe.stderr);
  const durationMs = meta.durationMs ?? parseDurationMs(probe.stderr);

  const read = o.useEdit === false ? null : await readEdit(o.takeId, durationMs);
  const edit = cutsSomething(read, durationMs) ? read : null;
  let keep: TimeRange[] | null = edit ? mergeTouching(edit.keep) : null;

  if (o.trimSilence && audio) {
    // silence is measured on what the cuts leave, so the trim lands at the edited start and end
    progress("Finding silence", 0.02);
    const r = await run(cutAudioArgs(files.composite, keep, SILENCE_FILTER));
    const total = keep ? keptDuration(keep) : durationMs;
    const t = parseSilenceTrim(r.stderr, total != null ? total / 1000 : null);
    if (t.start > 0 || t.end != null) keep = clipEdited(keep ?? wholeTake(durationMs ?? Infinity), t.start * 1000, t.end != null ? t.end * 1000 : null);
  }
  if (keep && !keep.length) throw new Error("Nothing is left after the cuts");

  let loudness: string | null = null;
  if (o.loudness !== "off" && audio && output.format !== "gif") {
    progress("Measuring loudness", 0.05);
    const r = await run(cutAudioArgs(files.composite, keep, loudnormFilter(o.loudness)));
    const m = parseLoudnorm(r.stderr);
    loudness = m ? loudnormFilter(o.loudness, m) : null;
  }

  let source: SourceGraph;
  let srcSize: { width: number; height: number };
  if (o.kind === "hires") {
    // no input seek: the zoom script keeps the recording clock, the cuts come after it
    const h = await c.hiresSource(o.takeId, dir, meta, files, 0);
    const graph = hiresGraph({ ...h, trim: { start: 0, end: null }, audio });
    source = { kind: "hires", graph, fps: h.fps };
    srcSize = { width: graph.W, height: graph.H };
  } else {
    source = { kind: "composite", input: files.composite, fps: meta.fps || 30 };
    srcSize = parseVideoSize(probe.stderr) ?? { width: 1920, height: 1080 };
  }
  const frame = resolveFrame(output, srcSize);

  const caps = await readCaptions(o.takeId);
  const lines = caps?.lines.length ? remapLines(caps.lines, keep) : null;
  let burn: { ass: string; fontsDir: string } | null = null;
  if (output.captions) {
    if (!lines?.length) throw new Error("This take has no captions yet. Make them in the editor first.");
    if (!(await canBurnCaptions(run))) throw new Error("This copy of ffmpeg cannot draw captions. Export the .srt file instead.");
    await writeFile(join(dir, "captions.ass"), toAss(lines, output.captions, frame.W, frame.H));
    await mkdir(join(dir, ".fonts"), { recursive: true });
    await writeFile(join(dir, ".fonts", "Geist-Bold.ttf"), await readFile(geistBold));
    burn = { ass: "captions.ass", fontsDir: ".fonts" };
  }

  const out = c.out;
  const encodeMs = keep ? keptDuration(keep) : (durationMs ?? 0);
  const stageName = output.format === "gif" ? "Making the GIF" : `Encoding ${output.format.toUpperCase()}`;
  const watch = (from: number, to: number, stage: string) => (s: string) => {
    const t = parseProgressTime(s);
    if (t != null) progress(stage, Number.isFinite(encodeMs) && encodeMs > 0 ? Math.min(to, from + (to - from) * (t / encodeMs)) : null);
  };
  const base = { source, srcSize, audio, keep, loudness, output, burn, out, limitSec: Number.isFinite(encodeMs) && encodeMs > 0 ? encodeMs / 1000 : null };

  try {
    if (output.quality.mode === "size" && output.format !== "gif") {
      const audioKbps = audio ? (output.format === "webm" ? AUDIO_KBPS.webm : AUDIO_KBPS.mp4Size) : 0;
      const kbps = sizeBitrateKbps(output.quality.mb, encodeMs / 1000, audioKbps);
      const log = "ffpass";
      progress(`${stageName}, pass 1 of 2`, 0.1);
      const r1 = await run(editExportArgs({ ...base, pass: { n: 1, log, kbps } }), watch(0.1, 0.5, `${stageName}, pass 1 of 2`));
      if (r1.code !== 0) throw new Error(`ffmpeg failed: ${tail(r1.stderr)}`);
      progress(`${stageName}, pass 2 of 2`, 0.5);
      const r2 = await run(editExportArgs({ ...base, pass: { n: 2, log, kbps } }), watch(0.5, 0.99, `${stageName}, pass 2 of 2`));
      if (r2.code !== 0) throw new Error(`ffmpeg failed: ${tail(r2.stderr)}`);
    } else {
      progress(stageName, 0.1);
      const r = await run(editExportArgs(base), watch(0.1, 0.99, stageName));
      if (r.code !== 0) throw new Error(`ffmpeg failed: ${tail(r.stderr)}`);
    }
  } catch (e) {
    // a failed or cancelled export leaves no half-written file behind
    await rm(out, { force: true }).catch(() => {});
    throw e;
  } finally {
    // the two-pass logs and the copied font are working files
    for (const f of await readdir(dir).catch(() => [] as string[])) if (f.startsWith("ffpass")) await rm(join(dir, f), { force: true });
    if (burn) await rm(join(dir, ".fonts"), { recursive: true, force: true });
  }
  // the captions as files, timed to this export (its cuts and trimmed silence)
  if (lines?.length && output.format !== "gif") {
    const stem = out.replace(/\.\w+$/, "");
    await writeFile(`${stem}.srt`, toSrt(lines));
    await writeFile(`${stem}.vtt`, toVtt(lines));
  }
  return out;
}
