// A take laid out as an editor's timeline, before it is written as OpenTimelineIO (otio-core.ts) or
// FCPXML (fcpxml-core.ts). Pure (tested in timeline-core.test.ts). Times go in as ms on the recording
// clock and come out as whole frames on the edited timeline, so every cut lands on a frame and the
// clips sit back to back with no drift.
import type { CaptionLine, TimeRange } from "../../shared/types";

/** One media file of the take as an editor will see it. */
export interface TimelineMedia {
  /** a stable short id: composite, screen, camera, system */
  id: string;
  /** absolute path */
  file: string;
  /** the file's own length when known (MediaRecorder files often have none) */
  durationMs: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
}

export type MarkerKind = "click" | "scene" | "chapter" | "caption";

export interface TimelineMarker {
  /** ms on the recording clock */
  t: number;
  durationMs?: number;
  name: string;
  kind: MarkerKind;
  comment?: string;
}

export interface TimelineInput {
  name: string;
  fps: number;
  width: number;
  height: number;
  /** the take's length on the recording clock */
  durationMs: number;
  /** the stretches that stay (null = the whole take) */
  keep: TimeRange[] | null;
  /** bottom to top */
  video: { name: string; media: TimelineMedia }[];
  audio: { name: string; media: TimelineMedia }[];
  markers: TimelineMarker[];
  captions: CaptionLine[];
  metadata?: Record<string, unknown>;
}

/** A clip of a track on the edited timeline: `at` and `frames` are where it sits, `from` where it starts in its file. */
export interface PlacedClip { kind: "clip"; at: number; frames: number; from: number; media: TimelineMedia }
export interface PlacedGap { kind: "gap"; at: number; frames: number }
export type Placed = PlacedClip | PlacedGap;

export interface PlacedTrack { name: string; kind: "video" | "audio"; items: Placed[] }
export interface PlacedMarker { at: number; frames: number; name: string; kind: MarkerKind; comment?: string }
export interface PlacedCaption { at: number; frames: number; text: string }

export interface TimelineLayout {
  name: string;
  fps: number;
  width: number;
  height: number;
  /** the edited timeline's length in frames */
  frames: number;
  /** the kept stretches in frames: where each sits on the edited timeline and where it comes from */
  segments: { at: number; from: number; frames: number }[];
  tracks: PlacedTrack[];
  markers: PlacedMarker[];
  captions: PlacedCaption[];
  metadata: Record<string, unknown>;
}

/** ms to the nearest frame. */
export const toFrames = (ms: number, fps: number) => Math.round((ms * fps) / 1000);

/** Sorted, clamped, overlapping stretches folded, touching ones joined (one clip per real cut). */
export function keptSegments(keep: TimeRange[] | null, durationMs: number): TimeRange[] {
  const src = keep?.length ? keep : [{ start: 0, end: durationMs }];
  const sorted = src
    .map((r) => ({ start: Math.max(0, r.start), end: Math.min(durationMs, r.end) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Where a recording-clock time lands on the edited timeline, in frames, or null when it was cut. */
export function editedFrame(t: number, segments: TimelineLayout["segments"], fps: number): number | null {
  const f = toFrames(t, fps);
  for (const s of segments) if (f >= s.from && f < s.from + s.frames) return s.at + (f - s.from);
  const last = segments[segments.length - 1];
  return last && f === last.from + last.frames ? last.at + last.frames : null;
}

function placeTrack(segments: TimelineLayout["segments"], media: TimelineMedia, fps: number): Placed[] {
  const end = media.durationMs != null ? toFrames(media.durationMs, fps) : Infinity;
  const items: Placed[] = [];
  for (const s of segments) {
    const covered = Math.max(0, Math.min(s.frames, end - s.from));
    if (covered > 0) items.push({ kind: "clip", at: s.at, frames: covered, from: s.from, media });
    // the file is shorter than the take here (a track that stopped early): the rest is empty
    if (covered < s.frames) items.push({ kind: "gap", at: s.at + covered, frames: s.frames - covered });
  }
  // neighbouring gaps become one
  const out: Placed[] = [];
  for (const it of items) {
    const last = out[out.length - 1];
    if (it.kind === "gap" && last?.kind === "gap") last.frames += it.frames;
    else out.push({ ...it });
  }
  return out;
}

/** The whole layout: kept stretches, every track, markers and captions on the edited timeline. */
export function layoutTimeline(input: TimelineInput): TimelineLayout {
  const fps = input.fps > 0 ? input.fps : 30;
  const ranges = keptSegments(input.keep, input.durationMs);
  const segments: TimelineLayout["segments"] = [];
  let at = 0;
  for (const r of ranges) {
    const from = toFrames(r.start, fps);
    const frames = toFrames(r.end, fps) - from;
    if (frames <= 0) continue;
    segments.push({ at, from, frames });
    at += frames;
  }
  const tracks: PlacedTrack[] = [
    ...input.video.map((v) => ({ name: v.name, kind: "video" as const, items: placeTrack(segments, v.media, fps) })),
    ...input.audio.map((a) => ({ name: a.name, kind: "audio" as const, items: placeTrack(segments, a.media, fps) })),
  ];

  const markers: PlacedMarker[] = [];
  for (const m of input.markers) {
    const f = editedFrame(m.t, segments, fps);
    if (f == null || f >= at) continue;
    const len = Math.max(1, toFrames(m.durationMs ?? 0, fps));
    markers.push({ at: f, frames: Math.min(len, at - f), name: m.name, kind: m.kind, comment: m.comment });
  }
  markers.sort((a, b) => a.at - b.at);

  // a caption keeps the words that were not cut; its edges follow its first and last kept word
  const captions: PlacedCaption[] = [];
  for (const line of input.captions) {
    const kept = line.words
      .map((w) => ({ w, s: editedFrame(w.start, segments, fps), e: editedFrame(w.end, segments, fps), mid: editedFrame((w.start + w.end) / 2, segments, fps) }))
      .filter((x) => x.mid != null);
    if (!kept.length) continue;
    const s = kept[0].s ?? kept[0].mid!;
    const lastWord = kept[kept.length - 1];
    const lineEnd = editedFrame(line.end, segments, fps);
    const e = Math.max(lastWord.e ?? lastWord.mid! + 1, lineEnd != null && lineEnd > s ? lineEnd : 0, s + 1);
    const text = kept.map((x) => x.w.text).join(" ").trim();
    if (text) captions.push({ at: s, frames: Math.min(e, at) - s, text });
  }
  captions.sort((a, b) => a.at - b.at);
  for (let i = 0; i < captions.length - 1; i++) captions[i].frames = Math.max(1, Math.min(captions[i].frames, captions[i + 1].at - captions[i].at));

  return { name: input.name, fps, width: input.width, height: input.height, frames: at, segments, tracks, markers, captions: captions.filter((c) => c.frames > 0), metadata: input.metadata ?? {} };
}

/** A path as a file:// URL (spaces, accents and Windows drive letters handled). */
export function fileUrl(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(p)) p = `/${p}`;
  else if (p.startsWith("//")) return `file:${p.split("/").map((s, i) => (i < 2 ? s : encodeURIComponent(s))).join("/")}`;
  return `file://${p.split("/").map((s, i) => (i === 1 && /^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join("/")}`;
}
