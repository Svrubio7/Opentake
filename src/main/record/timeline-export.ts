// "Open in an editor": a take's timeline as an .otio (and .fcpxml) file next to its media, so FilmCraft,
// DaVinci Resolve, Premiere or Final Cut open the take with its cuts, markers and captions. No Electron:
// the app and the MCP server both call this, each with its own ffmpeg runner and settings.
import { t } from "../../shared/i18n";
import { existsSync } from "node:fs";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings, TakeCaptions, TakeEdit, TakeTimeline } from "../../shared/types";
import { remapLines, toSrt } from "../../renderer/modules/editor/captions-core";
import { renderName, uniqueName } from "../settings-core";
import { parseDurationMs, parseVideoSize } from "./export-core";
import { hasAudioStream } from "./ffmpeg-core";
import { toFcpxml } from "./fcpxml-core";
import { otioJson } from "./otio-core";
import type { Chapter } from "./take-extras";
import { keptSegments, layoutTimeline, type TimelineInput, type TimelineMarker, type TimelineMedia } from "./timeline-core";

export type Run = (args: string[], onStdout?: (s: string) => void) => Promise<{ code: number; stderr: string }>;

export interface TimelineTake {
  id: string;
  dir: string;
  title?: string;
  createdAt: number;
  durationMs: number | null;
  fps: number;
  frame?: { width: number; height: number };
  /** file extension per recorded track */
  containers: Partial<Record<"composite" | "screen" | "camera" | "system", string>>;
  timeline: TakeTimeline | null;
  edit: TakeEdit | null;
  captions: TakeCaptions | null;
  chapters: Chapter[];
}

export interface TimelineOptions {
  /** composite: what you saw, one picture. separate: the screen, the camera and the computer sound on their own tracks */
  layout?: "composite" | "separate";
  /** otio is always written; fcpxml too when asked */
  fcpxml?: boolean;
  /** apply the take's cuts (default true) */
  useEdit?: boolean;
  clickMarkers?: boolean;
  sceneMarkers?: boolean;
  captionMarkers?: boolean;
  /** MP4 (H.264 and AAC) copies of WebM tracks, for Premiere and Final Cut, which cannot read WebM */
  compatibleMedia?: boolean;
}

export interface TimelineResult {
  otio: string;
  fcpxml?: string;
  srt?: string;
  /** media files the timeline points at */
  media: string[];
  clips: number;
  markers: number;
  captions: number;
  layout: "composite" | "separate";
  frames: number;
  fps: number;
  /** plain lines about what was left out or changed */
  notes: string[];
}

const MAX_CLICK_MARKERS = 500;

const trackName = (track: string) => (["screen", "camera", "system", "composite"].includes(track) ? t(`tl.track.${track}` as "tl.track.screen") : track);

interface Probe { durationMs: number | null; width?: number; height?: number; video: boolean; audio: boolean }

async function probe(run: Run, file: string): Promise<Probe> {
  const r = await run(["-nostdin", "-hide_banner", "-i", file]);
  const size = parseVideoSize(r.stderr);
  return { durationMs: parseDurationMs(r.stderr), width: size?.width, height: size?.height, video: /Stream #\d+:\d+.*: Video:/.test(r.stderr), audio: hasAudioStream(r.stderr) };
}

const fresh = async (copy: string, source: string) => existsSync(copy) && (await stat(copy)).mtimeMs >= (await stat(source)).mtimeMs;

/**
 * A file an editor can seek in. MediaRecorder files have no index and no length: a copy without
 * re-encoding writes both (the composite's copy is the editor's own preview file, shared with it).
 * With `compatible`, WebM becomes an H.264 and AAC MP4 at the take's frame rate.
 */
async function editable(run: Run, dir: string, track: string, file: string, fps: number, compatible: boolean, onStage?: (s: string) => void): Promise<string> {
  const ext = file.endsWith(".mp4") ? "mp4" : "webm";
  if (compatible && ext === "webm") {
    const out = join(dir, `${track}.edit.mp4`);
    if (await fresh(out, file)) return out;
    onStage?.(t("tl.stage.mp4", { track: trackName(track) }));
    const tmp = join(dir, `${track}.edit.tmp.mp4`);
    const r = await run(["-nostdin", "-y", "-hide_banner", "-i", file, "-map", "0:v?", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-r", String(fps || 30), "-fps_mode", "cfr", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", tmp]);
    if (r.code !== 0) { await rm(tmp, { force: true }); throw new Error(t("tl.mp4Failed", { track: trackName(track) })); }
    await rename(tmp, out);
    return out;
  }
  const p = await probe(run, file);
  if (p.durationMs != null) return file;
  const out = join(dir, track === "composite" ? `preview.${ext}` : `${track}.seekable.${ext}`);
  if (await fresh(out, file)) return out;
  onStage?.(t("tl.stage.index", { track: trackName(track) }));
  const tmp = join(dir, `${track}.seekable.tmp.${ext}`);
  const r = await run(["-nostdin", "-y", "-hide_banner", "-i", file, "-map", "0", "-c", "copy", ...(ext === "mp4" ? ["-movflags", "+faststart"] : []), tmp]);
  if (r.code !== 0) { await rm(tmp, { force: true }); return file; }
  await rename(tmp, out);
  return out;
}

async function media(run: Run, id: string, file: string): Promise<TimelineMedia> {
  const p = await probe(run, file);
  return { id, file, durationMs: p.durationMs, hasVideo: p.video, hasAudio: p.audio, width: p.width, height: p.height };
}

/** The editor timeline of a take, ready for layoutTimeline. Exported for tests. */
export async function timelineInput(take: TimelineTake, run: Run, o: TimelineOptions, onStage?: (s: string) => void): Promise<{ input: TimelineInput; notes: string[]; layout: "composite" | "separate" }> {
  const notes: string[] = [];
  const has = (k: keyof TimelineTake["containers"]) => !!take.containers[k] && existsSync(join(take.dir, `${k}.${take.containers[k]}`));
  const src = (k: keyof TimelineTake["containers"]) => join(take.dir, `${k}.${take.containers[k]}`);
  if (!has("composite")) throw new Error(t("main.export.noRecording"));
  const fps = take.timeline?.layout.fps || take.fps || 30;
  const compatible = !!o.compatibleMedia;

  let layout = o.layout ?? "composite";
  if (layout === "separate" && !has("screen") && !has("camera")) {
    notes.push(t("tl.noSeparate"));
    layout = "composite";
  }
  const video: TimelineInput["video"] = [];
  const audio: TimelineInput["audio"] = [];
  if (layout === "composite") {
    const c = await media(run, "composite", await editable(run, take.dir, "composite", src("composite"), fps, compatible, onStage));
    video.push({ name: "V1", media: c });
    if (c.hasAudio) audio.push({ name: "A1", media: c });
  } else {
    if (has("screen")) video.push({ name: `V${video.length + 1}`, media: await media(run, "screen", await editable(run, take.dir, "screen", src("screen"), fps, compatible, onStage)) });
    if (has("camera")) {
      const cam = await media(run, "camera", await editable(run, take.dir, "camera", src("camera"), fps, compatible, onStage));
      video.push({ name: `V${video.length + 1}`, media: cam });
      if (cam.hasAudio) audio.push({ name: `A${audio.length + 1}`, media: cam });
    }
    if (has("system")) audio.push({ name: `A${audio.length + 1}`, media: await media(run, "system", await editable(run, take.dir, "system", src("system"), fps, compatible, onStage)) });
    if (!audio.length) {
      // the mic is only in the composite (no camera track): bring it in as the sound
      const c = await media(run, "composite", await editable(run, take.dir, "composite", src("composite"), fps, compatible, onStage));
      if (c.hasAudio) audio.push({ name: "A1", media: c });
    }
    if (take.timeline?.layout.mode === "screen-camera" && has("camera")) notes.push(t("tl.cameraAbove"));
  }

  const durationMs = take.durationMs ?? video[0]?.media.durationMs ?? 0;
  if (!(durationMs > 0)) throw new Error(t("tl.lengthUnknown"));
  const keep = o.useEdit === false ? null : take.edit?.keep ?? null;

  const markers: TimelineMarker[] = [];
  if (o.clickMarkers !== false && take.timeline?.clicks.length) {
    const clicks = take.timeline.clicks;
    if (clicks.length > MAX_CLICK_MARKERS) notes.push(t("tl.clicksCapped", { count: clicks.length, max: MAX_CLICK_MARKERS }));
    for (const c of clicks.slice(0, MAX_CLICK_MARKERS)) markers.push({ t: c.t, name: t("tl.marker.click"), kind: "click" });
  }
  if (o.sceneMarkers !== false) {
    const names = { camera: t("tl.scene.camera"), "screen-camera": t("tl.scene.screenCamera"), screen: t("tl.scene.screen") };
    for (const s of take.timeline?.scenes ?? []) markers.push({ t: s.t, name: t("tl.marker.scene", { scene: names[s.scene] }), kind: "scene" });
  }
  for (const c of take.chapters) markers.push({ t: c.t, name: c.title, kind: "chapter" });

  const frame = take.timeline?.layout ? { width: take.timeline.layout.width, height: take.timeline.layout.height } : take.frame;
  const v1 = video[0]?.media;
  const width = layout === "separate" ? (v1?.width ?? frame?.width ?? 1920) : (frame?.width ?? v1?.width ?? 1920);
  const height = layout === "separate" ? (v1?.height ?? frame?.height ?? 1080) : (frame?.height ?? v1?.height ?? 1080);
  return {
    layout,
    notes,
    input: {
      name: take.title || take.id,
      fps, width, height, durationMs, keep, video, audio, markers,
      captions: o.captionMarkers === false ? [] : take.captions?.lines ?? [],
      metadata: { take_id: take.id, title: take.title ?? null, recorded_at: new Date(take.createdAt).toISOString(), layout, app: "OpenTake" },
    },
  };
}

/** The folder a timeline export goes to: the fixed export folder when Settings says so, else the take folder. */
export const timelineFolder = (s: Pick<AppSettings, "exportDestination" | "exportDir">, takeDir: string) =>
  s.exportDestination === "folder" && s.exportDir ? s.exportDir : takeDir;

/** Writes the timeline files under free names (nothing is overwritten). */
export async function exportTimeline(take: TimelineTake, run: Run, settings: Pick<AppSettings, "exportDestination" | "exportDir" | "nameTemplate">, o: TimelineOptions = {}, onStage?: (s: string) => void): Promise<TimelineResult> {
  onStage?.(t("tl.stage.reading"));
  const { input, notes, layout } = await timelineInput(take, run, o, onStage);
  const l = layoutTimeline(input);
  const folder = timelineFolder(settings, take.dir);
  const stem = renderName(settings.nameTemplate, { createdAt: take.createdAt, title: take.title, preset: "timeline" });
  const wantSrt = (take.captions?.lines.length ?? 0) > 0;
  const name = uniqueName(stem, "otio", (n) => existsSync(join(folder, n)), [...(o.fcpxml ? ["fcpxml"] : []), ...(wantSrt ? ["srt"] : [])]);
  const base = join(folder, name.replace(/\.otio$/, ""));
  onStage?.(t("tl.stage.writing"));
  const otio = `${base}.otio`;
  await writeFile(otio, otioJson(l, { captionMarkers: o.captionMarkers }), { flag: "wx" });
  const out: TimelineResult = {
    otio, media: [...new Set(l.tracks.flatMap((t) => t.items.flatMap((i) => (i.kind === "clip" ? [i.media.file] : []))))],
    clips: l.tracks.reduce((a, t) => a + t.items.filter((i) => i.kind === "clip").length, 0),
    markers: l.markers.length, captions: l.captions.length, layout, frames: l.frames, fps: l.fps, notes,
  };
  if (o.fcpxml) {
    out.fcpxml = `${base}.fcpxml`;
    await writeFile(out.fcpxml, toFcpxml(l, { captions: o.captionMarkers !== false, lang: take.captions?.lang }), { flag: "wx" });
  }
  if (wantSrt) {
    // the .srt follows the same cuts, merged the way the export merges them
    const keep = o.useEdit === false || !take.edit ? null : keptSegments(take.edit.keep, input.durationMs);
    out.srt = `${base}.srt`;
    await writeFile(out.srt, toSrt(remapLines(take.captions!.lines, keep)), { flag: "wx" });
  }
  return out;
}
