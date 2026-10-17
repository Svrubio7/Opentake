// A take's timeline as OpenTimelineIO JSON (.otio), written by hand from the layout in timeline-core.ts.
// Pure (tested in otio-core.test.ts). Schemas: Timeline.1, Stack.1, Track.1, Clip.2, Gap.1, Marker.2,
// ExternalReference.1, TimeRange.1, RationalTime.1 (OpenTimelineIO 0.15 and later read them).
// OTIO has no caption track, so captions are markers named with their text (also written as .srt).
import { fileUrl, type MarkerKind, type Placed, type TimelineLayout } from "./timeline-core";

const rt = (value: number, rate: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const range = (start: number, duration: number, rate: number) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(start, rate), duration: rt(duration, rate) });

/** OTIO's marker colours (Marker.Color). */
export const MARKER_COLORS: Record<MarkerKind, string> = { click: "GREEN", scene: "PURPLE", chapter: "BLUE", caption: "YELLOW" };

function item(p: Placed, rate: number) {
  if (p.kind === "gap") {
    return { OTIO_SCHEMA: "Gap.1", name: "", source_range: range(0, p.frames, rate), effects: [], markers: [], enabled: true, metadata: {} };
  }
  const media = p.media;
  const available = media.durationMs != null ? Math.round((media.durationMs * rate) / 1000) : null;
  return {
    OTIO_SCHEMA: "Clip.2",
    name: media.file.split(/[\\/]/).pop() ?? media.id,
    source_range: range(p.from, p.frames, rate),
    effects: [],
    markers: [],
    enabled: true,
    metadata: { opentake: { media: media.id } },
    active_media_reference_key: "DEFAULT_MEDIA",
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: "ExternalReference.1",
        name: media.id,
        target_url: fileUrl(media.file),
        available_range: available != null ? range(0, available, rate) : null,
        available_image_bounds: null,
        metadata: { opentake: { width: media.width ?? null, height: media.height ?? null, has_video: media.hasVideo, has_audio: media.hasAudio } },
      },
    },
  };
}

function marker(name: string, at: number, frames: number, rate: number, color: string, kind: MarkerKind, comment?: string) {
  return { OTIO_SCHEMA: "Marker.2", name, marked_range: range(at, frames, rate), color, comment: comment ?? "", metadata: { opentake: { kind } } };
}

/**
 * OTIO has no standard place for the frame size, so editors open a timeline at their default size.
 * FilmCraft reads its sequence settings from metadata.filmcraft (its own OTIO export writes them there):
 * this is that block, complete, because a partial one is ignored. Other editors skip the key.
 */
function filmcraftSettings(l: TimelineLayout) {
  const fps = Math.abs(l.fps - Math.round(l.fps)) < 0.001 ? { num: Math.round(l.fps), den: 1 } : { num: Math.round(l.fps * 1001), den: 1001 };
  return {
    settings: {
      width: l.width, height: l.height, frame_rate: fps, par: [1, 1], sample_rate: 48000, drop_frame: false,
      preset: `Custom ${l.width}x${l.height} ${Math.round(l.fps * 100) / 100}`, audio_master: "Stereo", preview_codec: "ProRes 422",
      max_bit_depth: false, max_render_quality: false, working_space: "Rec. 709", color: { working: "Rec709", wide_gamut: false, auto_tone_map: true },
    },
  };
}

/** The OTIO document as a plain object (JSON.stringify it to write the file). */
export function toOtio(l: TimelineLayout, o: { captionMarkers?: boolean } = {}): Record<string, unknown> {
  const rate = l.fps;
  const tracks = l.tracks.map((t) => ({
    OTIO_SCHEMA: "Track.1",
    name: t.name,
    kind: t.kind === "video" ? "Video" : "Audio",
    source_range: null,
    effects: [],
    markers: [],
    enabled: true,
    metadata: {},
    children: t.items.map((p) => item(p, rate)),
  }));
  const markers = [
    ...l.markers.map((m) => marker(m.name, m.at, m.frames, rate, MARKER_COLORS[m.kind], m.kind, m.comment)),
    ...(o.captionMarkers === false ? [] : l.captions.map((c) => marker(c.text, c.at, c.frames, rate, MARKER_COLORS.caption, "caption"))),
  ].sort((a, b) => a.marked_range.start_time.value - b.marked_range.start_time.value);
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: l.name,
    global_start_time: null,
    metadata: { opentake: { ...l.metadata, width: l.width, height: l.height, fps: l.fps }, filmcraft: filmcraftSettings(l) },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      source_range: null,
      effects: [],
      markers,
      enabled: true,
      metadata: {},
      children: tracks,
    },
  };
}

export const otioJson = (l: TimelineLayout, o?: { captionMarkers?: boolean }) => JSON.stringify(toOtio(l, o), null, 2);
