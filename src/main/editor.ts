// The take editor's main side: the opentake-media:// protocol the player streams from, the take's
// edit and captions on disk, waveform peaks and the 16 kHz audio the caption recognizer reads.
import { ipcMain, protocol } from "electron";
import { createReadStream, existsSync } from "node:fs";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { IPC } from "../shared/ipc";
import type { EditorTake, TakePeaks } from "../shared/types";
import { lineText, remapLines, toSrt, toVtt } from "../renderer/modules/editor/captions-core";
import { mergeTouching } from "../renderer/modules/editor/edit-core";
import { cutsSomething, readCaptions, readEdit, writeCaptions, writeEdit } from "./record/editor-store";
import { canBurnCaptions } from "./record/export-edit";
import { ffmpegPath } from "./record/export";
import { runWatched } from "./record/ffmpeg-run";
import { computePeaks, parseDurationMs } from "./record/export-core";
import { hasAudioStream, validTakeId } from "./record/ffmpeg-core";
import { MEDIA_SCHEME, mediaUrl, mimeFor, parseMediaUrl, parseRange } from "./record/media-core";
import { listTakes, readMeta, takeDir, takeFiles } from "./record/takes";
import { t } from "../shared/i18n";

/** Must run before the app is ready: the player needs a scheme that streams and seeks. */
export function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
}

/** ffmpeg for the editor (probe, preview copy, peaks, the recognizer's audio), watched like every export run. */
async function ff(args: string[], cwd?: string): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  const out: Buffer[] = [];
  const r = await runWatched(ffmpegPath(), args, { cwd, onData: (d) => out.push(d) });
  return { ...r, stdout: Buffer.concat(out) };
}

async function serve(req: Request): Promise<Response> {
  const target = parseMediaUrl(req.url);
  if (!target) return new Response("Not found", { status: 404 });
  let file: string;
  try { file = join(takeDir(target.takeId), target.file); } catch { return new Response("Not found", { status: 404 }); }
  let size: number;
  try { size = (await stat(file)).size; } catch { return new Response("Not found", { status: 404 }); }
  const type = mimeFor(target.file);
  const range = parseRange(req.headers.get("range"), size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as ReadableStream;
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(end - start + 1), "Cache-Control": "no-store" };
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  return new Response(body, { status: range ? 206 : 200, headers });
}

/**
 * A MediaRecorder file has no index and no length, so a player cannot seek in it. A one-time copy
 * with ffmpeg (no re-encode) writes both; it sits in the take folder as preview.<ext>.
 */
async function ensurePreview(takeId: string, composite: string): Promise<{ file: string; durationMs: number | null; audio: boolean }> {
  const dir = takeDir(takeId);
  const ext = composite.endsWith(".mp4") ? "mp4" : "webm";
  const preview = join(dir, `preview.${ext}`);
  const fresh = existsSync(preview) && (await stat(preview)).mtimeMs >= (await stat(composite)).mtimeMs;
  if (fresh) {
    const p = await ff(["-nostdin", "-hide_banner", "-i", preview]);
    return { file: `preview.${ext}`, durationMs: parseDurationMs(p.stderr), audio: hasAudioStream(p.stderr) };
  }
  const probe = await ff(["-nostdin", "-hide_banner", "-i", composite]);
  const known = parseDurationMs(probe.stderr);
  const audio = hasAudioStream(probe.stderr);
  if (known != null && ext === "mp4" && !/fragment|frag_/.test(probe.stderr)) return { file: composite.split(/[\\/]/).pop()!, durationMs: known, audio };
  const tmp = join(dir, `preview.tmp.${ext}`);
  const r = await ff(["-nostdin", "-y", "-hide_banner", "-i", composite, "-map", "0", "-c", "copy", ...(ext === "mp4" ? ["-movflags", "+faststart"] : []), tmp]);
  if (r.code !== 0) {
    await rm(tmp, { force: true });
    return { file: composite.split(/[\\/]/).pop()!, durationMs: known, audio };
  }
  await rename(tmp, preview);
  const p = await ff(["-nostdin", "-hide_banner", "-i", preview]);
  return { file: `preview.${ext}`, durationMs: parseDurationMs(p.stderr) ?? known, audio };
}

const PEAKS_PER_SECOND = 100;

async function peaksFor(takeId: string): Promise<TakePeaks> {
  const dir = takeDir(takeId);
  const meta = await readMeta(takeId);
  const files = takeFiles(takeId, meta);
  if (!files.composite) throw new Error(t("main.export.noRecording"));
  const cache = join(dir, "peaks.json");
  try {
    if ((await stat(cache)).mtimeMs >= (await stat(files.composite)).mtimeMs) return JSON.parse(await readFile(cache, "utf8")) as TakePeaks;
  } catch { /* no cache yet */ }
  const rate = 8000;
  const r = await ff(["-nostdin", "-hide_banner", "-i", files.composite, "-vn", "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"]);
  const buf = r.stdout;
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const peaks: TakePeaks = { perSecond: PEAKS_PER_SECOND, peaks: computePeaks(samples, rate, PEAKS_PER_SECOND) };
  await writeFile(cache, JSON.stringify(peaks)).catch(() => {});
  return peaks;
}

export function registerEditorIpc() {
  protocol.handle(MEDIA_SCHEME, serve);

  ipcMain.handle(IPC.editorOpen, async (_e, takeId: string): Promise<EditorTake> => {
    if (!validTakeId(takeId)) throw new Error("bad take id");
    const take = (await listTakes()).find((t) => t.id === takeId);
    if (!take?.files.composite) throw new Error(t("main.export.noRecording"));
    const preview = await ensurePreview(takeId, take.files.composite);
    const durationMs = take.durationMs ?? preview.durationMs;
    return {
      take,
      edit: await readEdit(takeId, durationMs),
      captions: await readCaptions(takeId),
      mediaUrl: mediaUrl(takeId, preview.file),
      durationMs,
      hasAudio: preview.audio,
      canBurn: await canBurnCaptions(async (args, onStdout) => {
        const r = await ff(args);
        onStdout?.(r.stdout.toString());
        return { code: r.code, stderr: r.stderr };
      }),
    };
  });

  ipcMain.handle(IPC.editorSaveEdit, async (_e, takeId: string, edit: unknown, durationMs: number) => {
    if (!validTakeId(takeId) || !(durationMs > 0)) throw new Error("bad edit");
    return writeEdit(takeId, edit, durationMs);
  });

  ipcMain.handle(IPC.editorSaveCaptions, async (_e, takeId: string, captions: unknown) => {
    if (!validTakeId(takeId)) throw new Error("bad take id");
    return writeCaptions(takeId, captions);
  });

  ipcMain.handle(IPC.editorPeaks, (_e, takeId: string) => {
    if (!validTakeId(takeId)) throw new Error("bad take id");
    return peaksFor(takeId);
  });

  // 16 kHz mono 16-bit samples for the recognizer (half the size of floats over IPC)
  ipcMain.handle(IPC.editorPcm, async (_e, takeId: string): Promise<Uint8Array> => {
    if (!validTakeId(takeId)) throw new Error("bad take id");
    const meta = await readMeta(takeId);
    const files = takeFiles(takeId, meta);
    if (!files.composite) throw new Error(t("main.export.noRecording"));
    const r = await ff(["-nostdin", "-hide_banner", "-i", files.composite, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"]);
    if (r.code !== 0 || !r.stdout.length) throw new Error(t("main.editor.noSound"));
    return new Uint8Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength);
  });

  /** take.srt and take.vtt beside the take, on the edited timeline (they match take.mp4). */
  ipcMain.handle(IPC.editorCaptionFiles, async (_e, takeId: string): Promise<string[]> => {
    if (!validTakeId(takeId)) throw new Error("bad take id");
    const caps = await readCaptions(takeId);
    if (!caps?.lines.some((l) => lineText(l).trim())) throw new Error(t("main.editor.noCaptionsToSave"));
    const meta = await readMeta(takeId);
    const edit = await readEdit(takeId, meta.durationMs);
    const lines = remapLines(caps.lines, cutsSomething(edit, meta.durationMs) ? mergeTouching(edit!.keep) : null);
    const dir = takeDir(takeId);
    const srt = join(dir, "take.srt"), vtt = join(dir, "take.vtt");
    await writeFile(srt, toSrt(lines));
    await writeFile(vtt, toVtt(lines));
    return [srt, vtt];
  });
}
