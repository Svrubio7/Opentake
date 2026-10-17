import { describe, expect, it } from "vitest";
import { editedFrame, fileUrl, keptSegments, layoutTimeline, toFrames, type TimelineInput, type TimelineMedia } from "./timeline-core";
import { toOtio } from "./otio-core";
import { fcpTime, frameDuration, toFcpxml } from "./fcpxml-core";
import { cleanChapters, parseCaptionStyle, parseChapters } from "./take-extras";

const comp: TimelineMedia = { id: "composite", file: "C:\\Takes\\2026-10-17 14.05\\composite.webm", durationMs: 10_000, hasVideo: true, hasAudio: true, width: 1920, height: 1080 };

const input = (over: Partial<TimelineInput> = {}): TimelineInput => ({
  name: "Demo", fps: 30, width: 1920, height: 1080, durationMs: 10_000,
  keep: [{ start: 0, end: 2000 }, { start: 5000, end: 8000 }],
  video: [{ name: "V1", media: comp }], audio: [{ name: "A1", media: comp }],
  markers: [{ t: 1000, name: "Click", kind: "click" }, { t: 3000, name: "Cut away", kind: "click" }, { t: 6000, name: "Intro", kind: "chapter" }],
  captions: [{ id: "a", start: 500, end: 1500, words: [{ text: "Hello", start: 500, end: 900 }, { text: "there", start: 1000, end: 1500 }] },
    { id: "b", start: 2500, end: 3500, words: [{ text: "gone", start: 2500, end: 3500 }] }],
  ...over,
});

describe("timeline layout", () => {
  it("rounds to frames and keeps clips back to back", () => {
    expect(toFrames(1000, 30)).toBe(30);
    expect(toFrames(1017, 30)).toBe(31);
    const l = layoutTimeline(input());
    expect(l.segments).toEqual([{ at: 0, from: 0, frames: 60 }, { at: 60, from: 150, frames: 90 }]);
    expect(l.frames).toBe(150);
    expect(l.tracks[0].items).toEqual([
      { kind: "clip", at: 0, frames: 60, from: 0, media: comp },
      { kind: "clip", at: 60, frames: 90, from: 150, media: comp },
    ]);
  });

  it("joins touching stretches (a split is not a cut) and clamps to the take", () => {
    expect(keptSegments([{ start: 0, end: 1000 }, { start: 1000, end: 2000 }, { start: 9000, end: 99_000 }], 10_000)).toEqual([{ start: 0, end: 2000 }, { start: 9000, end: 10_000 }]);
    expect(keptSegments(null, 4000)).toEqual([{ start: 0, end: 4000 }]);
  });

  it("drops markers in cut stretches and moves the rest to edited time", () => {
    const l = layoutTimeline(input());
    expect(l.markers.map((m) => [m.name, m.at])).toEqual([["Click", 30], ["Intro", 90]]);
    expect(editedFrame(3000, l.segments, 30)).toBeNull();
  });

  it("keeps captions whose words survive and drops the cut ones", () => {
    const l = layoutTimeline(input());
    expect(l.captions).toEqual([{ at: 15, frames: 30, text: "Hello there" }]);
  });

  it("leaves a gap where a track's file is shorter than the take", () => {
    const short = { ...comp, id: "system", file: "C:\\t\\system.webm", durationMs: 6000, hasVideo: false };
    const l = layoutTimeline(input({ audio: [{ name: "A1", media: short }] }));
    expect(l.tracks[1].items).toEqual([
      { kind: "clip", at: 0, frames: 60, from: 0, media: short },
      { kind: "clip", at: 60, frames: 30, from: 150, media: short },
      { kind: "gap", at: 90, frames: 60 },
    ]);
  });

  it("writes file URLs for Windows, UNC and POSIX paths", () => {
    expect(fileUrl("C:\\Users\\Ana María\\take #1\\composite.webm")).toBe("file:///C:/Users/Ana%20Mar%C3%ADa/take%20%231/composite.webm");
    expect(fileUrl("/home/ana/OpenTake recordings/a.webm")).toBe("file:///home/ana/OpenTake%20recordings/a.webm");
    expect(fileUrl("\\\\nas\\share\\a b.webm")).toBe("file://nas/share/a%20b.webm");
  });
});

describe("OpenTimelineIO", () => {
  it("writes a timeline with clips, source ranges, media references and markers", () => {
    const doc = toOtio(layoutTimeline(input())) as any;
    expect(doc.OTIO_SCHEMA).toBe("Timeline.1");
    // FilmCraft takes the frame size from its own complete settings block
    expect(doc.metadata.filmcraft.settings).toMatchObject({ width: 1920, height: 1080, frame_rate: { num: 30, den: 1 } });
    const [v1, a1] = doc.tracks.children;
    expect(v1.kind).toBe("Video");
    expect(a1.kind).toBe("Audio");
    expect(v1.children).toHaveLength(2);
    const clip = v1.children[1];
    expect(clip.OTIO_SCHEMA).toBe("Clip.2");
    expect(clip.source_range.start_time).toEqual({ OTIO_SCHEMA: "RationalTime.1", rate: 30, value: 150 });
    expect(clip.source_range.duration.value).toBe(90);
    expect(clip.media_references.DEFAULT_MEDIA.target_url).toBe("file:///C:/Takes/2026-10-17%2014.05/composite.webm");
    expect(clip.media_references.DEFAULT_MEDIA.available_range.duration.value).toBe(300);
    const markers = doc.tracks.markers;
    expect(markers.map((m: any) => [m.name, m.color, m.marked_range.start_time.value])).toEqual([["Hello there", "YELLOW", 15], ["Click", "GREEN", 30], ["Intro", "BLUE", 90]]);
  });

  it("can leave caption markers out", () => {
    const doc = toOtio(layoutTimeline(input()), { captionMarkers: false }) as any;
    expect(doc.tracks.markers.some((m: any) => m.metadata.opentake.kind === "caption")).toBe(false);
  });

  it("gaps are Gap.1 items", () => {
    const short = { ...comp, durationMs: 1000 };
    const doc = toOtio(layoutTimeline(input({ video: [{ name: "V1", media: short }], audio: [] }))) as any;
    expect(doc.tracks.children[0].children.map((c: any) => c.OTIO_SCHEMA)).toEqual(["Clip.2", "Gap.1"]);
  });
});

describe("FCPXML", () => {
  it("writes frame-exact times", () => {
    expect(frameDuration(30)).toEqual({ num: 1, den: 30 });
    expect(frameDuration(29.97)).toEqual({ num: 1001, den: 30000 });
    expect(fcpTime(0, 30)).toBe("0s");
    expect(fcpTime(60, 30)).toBe("2s");
    expect(fcpTime(45, 30)).toBe("3/2s");
    expect(fcpTime(1, 29.97)).toBe("1001/30000s");
  });

  it("puts the cuts on the spine with markers and captions on each clip's own clock", () => {
    const x = toFcpxml(layoutTimeline(input()));
    expect(x).toContain(`<fcpxml version="1.10">`);
    expect(x).toContain(`<asset-clip ref="r2" name="composite" offset="0s" start="0s" duration="2s" tcFormat="NDF">`);
    expect(x).toContain(`<asset-clip ref="r2" name="composite" offset="2s" start="5s" duration="3s" tcFormat="NDF">`);
    // the chapter is at 6 s in the file: on the second clip, whose clock is the file's
    expect(x).toContain(`<chapter-marker start="6s" duration="1/30s" value="Intro"/>`);
    expect(x).toContain(`<marker start="1s" duration="1/30s" value="Click"/>`);
    expect(x).toContain(`<text-style ref="ts1">Hello there</text-style>`);
    expect(x).toContain(`src="file:///C:/Takes/2026-10-17%2014.05/composite.webm"`);
    // anchored items before markers (the DTD's order)
    const clip = x.slice(x.indexOf("start=\"0s\" duration=\"2s\""), x.indexOf("</asset-clip>"));
    expect(clip.indexOf("<caption")).toBeLessThan(clip.indexOf("<marker"));
  });

  it("connects the camera above and separate sound below the spine", () => {
    const screen = { ...comp, id: "screen", file: "C:\\t\\screen.webm", hasAudio: false };
    const cam = { ...comp, id: "camera", file: "C:\\t\\camera.webm" };
    const sys = { ...comp, id: "system", file: "C:\\t\\system.webm", hasVideo: false };
    const x = toFcpxml(layoutTimeline(input({ keep: null, video: [{ name: "V1", media: screen }, { name: "V2", media: cam }], audio: [{ name: "A1", media: cam }, { name: "A2", media: sys }], captions: [], markers: [] })));
    expect(x).toContain(`lane="1" name="camera" offset="0s" start="0s" duration="10s"`);
    // the camera clip carries its own sound: only the computer sound is added below the spine
    expect(x).not.toContain(`lane="-1" name="camera"`);
    expect(x).toContain(`lane="-1" name="system"`);
    expect(x).toContain(`name="system" start="0s" duration="10s" hasVideo="0" hasAudio="1"`);
  });

  it("escapes text", () => {
    const x = toFcpxml(layoutTimeline(input({ name: `Tom & "Jerry" <1>`, captions: [] })));
    expect(x).toContain(`<project name="Tom &amp; &quot;Jerry&quot; &lt;1&gt;">`);
  });
});

describe("take extras", () => {
  it("cleans chapters: sorted, one per moment, inside the take", () => {
    expect(cleanChapters([{ t: 5000, title: "B" }, { t: 0, title: " Intro\n" }, { t: 5000, title: "dup" }, { t: 99_000, title: "late" }, { t: 1, title: "" }, "x"], 10_000))
      .toEqual([{ t: 0, title: "Intro" }, { t: 5000, title: "B" }]);
    expect(parseChapters({ version: 2, chapters: [] }, null)).toBeNull();
  });

  it("checks caption styles", () => {
    expect(parseCaptionStyle({ style: "boxed", position: "top", margin: 0.9 })).toEqual({ style: "boxed", position: "top", margin: 0.4 });
    expect(parseCaptionStyle({ style: "neon" })).toBeNull();
  });
});
