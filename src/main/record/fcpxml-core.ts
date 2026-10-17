// A take's timeline as FCPXML 1.10 (Final Cut Pro, DaVinci Resolve, FilmCraft), from the layout in
// timeline-core.ts. Pure (tested in fcpxml-core.test.ts). The first video track is the spine; the other
// tracks are connected clips on lanes above (video) and below (audio) it. Markers and captions sit inside
// the spine clip they fall in, on that clip's own clock (an asset-clip's clock is its file's time).
import { fileUrl, type PlacedClip, type TimelineLayout, type TimelineMedia } from "./timeline-core";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");

/** The frame duration as FCPXML writes it: 1/30s, or 1001/30000s for the NTSC rates. */
export function frameDuration(fps: number): { num: number; den: number } {
  const ntsc = [23.976, 29.97, 47.952, 59.94, 119.88].find((r) => Math.abs(fps - r) < 0.01);
  if (ntsc) return { num: 1001, den: Math.round(ntsc * 1001 / 1000) * 1000 };
  return { num: 1, den: Math.max(1, Math.round(fps)) };
}

/** A frame count as an FCPXML time: "0s", "45/30s", "15015/30000s". */
export function fcpTime(frames: number, fps: number): string {
  if (frames === 0) return "0s";
  const { num, den } = frameDuration(fps);
  const n = frames * num;
  const g = gcd(Math.abs(n), den);
  return den / g === 1 ? `${n / g}s` : `${n / g}/${den / g}s`;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

interface Asset { id: string; media: TimelineMedia }

export function toFcpxml(l: TimelineLayout, o: { captions?: boolean; lang?: string } = {}): string {
  const fps = l.fps;
  const t = (f: number) => fcpTime(f, fps);
  const fd = frameDuration(fps);
  const formatId = "r1";
  const assets = new Map<string, Asset>();
  let next = 2;
  for (const tr of l.tracks) for (const it of tr.items) if (it.kind === "clip" && !assets.has(it.media.file)) assets.set(it.media.file, { id: `r${next++}`, media: it.media });

  const [primary, ...others] = l.tracks.filter((tr) => tr.kind === "video");
  const audio = l.tracks.filter((tr) => tr.kind === "audio");
  // an asset-clip of a file with sound carries that sound: audio from a file a video track already
  // uses (the spine's composite, the connected camera) is not added a second time
  const videoFiles = new Set(l.tracks.filter((tr) => tr.kind === "video").flatMap((tr) => tr.items.flatMap((i) => (i.kind === "clip" ? [i.media.file] : []))));
  const extraAudio = audio.filter((tr) => tr.items.some((i): i is PlacedClip => i.kind === "clip" && !videoFiles.has(i.media.file)));

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`, `<!DOCTYPE fcpxml>`, `<fcpxml version="1.10">`, `  <resources>`);
  lines.push(`    <format id="${formatId}" name="FFVideoFormatRateUndefined" frameDuration="${fd.num}/${fd.den}s" width="${l.width}" height="${l.height}" colorSpace="1-1-1 (Rec. 709)"/>`);
  for (const a of assets.values()) {
    const m = a.media;
    const dur = t(Math.round(((m.durationMs ?? 0) * fps) / 1000) || l.frames);
    const video = m.hasVideo ? ` hasVideo="1" videoSources="1" format="${formatId}"` : ` hasVideo="0"`;
    const sound = m.hasAudio ? ` hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000"` : ` hasAudio="0"`;
    lines.push(`    <asset id="${a.id}" name="${esc(m.id)}" start="0s" duration="${dur}"${video}${sound}>`);
    lines.push(`      <media-rep kind="original-media" src="${esc(fileUrl(m.file))}"/>`);
    lines.push(`    </asset>`);
  }
  lines.push(`  </resources>`, `  <library>`, `    <event name="OpenTake">`, `      <project name="${esc(l.name)}">`);
  lines.push(`        <sequence format="${formatId}" duration="${t(l.frames)}" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">`, `          <spine>`);

  let tsId = 0;
  for (const it of primary?.items ?? []) {
    if (it.kind === "gap") { lines.push(`            <gap name="Gap" offset="${t(it.at)}" start="0s" duration="${t(it.frames)}"/>`); continue; }
    const a = assets.get(it.media.file)!;
    const local = (seqFrame: number) => it.from + (seqFrame - it.at);
    const inside = (f: number) => f >= it.at && f < it.at + it.frames;
    lines.push(`            <asset-clip ref="${a.id}" name="${esc(it.media.id)}" offset="${t(it.at)}" start="${t(it.from)}" duration="${t(it.frames)}" tcFormat="NDF">`);
    // connected clips: other video tracks on lanes 1, 2... and separate audio below the spine
    others.forEach((tr, i) => {
      for (const c of tr.items) if (c.kind === "clip" && inside(c.at)) {
        const ref = assets.get(c.media.file)!;
        lines.push(`              <asset-clip ref="${ref.id}" lane="${i + 1}" name="${esc(c.media.id)}" offset="${t(local(c.at))}" start="${t(c.from)}" duration="${t(Math.min(c.frames, it.at + it.frames - c.at))}"/>`);
      }
    });
    extraAudio.forEach((tr, i) => {
      for (const c of tr.items) if (c.kind === "clip" && inside(c.at)) {
        const ref = assets.get(c.media.file)!;
        lines.push(`              <asset-clip ref="${ref.id}" lane="-${i + 1}" name="${esc(c.media.id)}" offset="${t(local(c.at))}" start="${t(c.from)}" duration="${t(Math.min(c.frames, it.at + it.frames - c.at))}" audioRole="dialogue"/>`);
      }
    });
    if (o.captions !== false) {
      const lane = others.length + 1;
      for (const c of l.captions) {
        // a caption across a cut is split at it, one part per clip
        const s = Math.max(c.at, it.at), e = Math.min(c.at + c.frames, it.at + it.frames);
        if (e <= s) continue;
        const id = `ts${++tsId}`;
        lines.push(`              <caption lane="${lane}" name="${esc(c.text.slice(0, 60))}" offset="${t(local(s))}" duration="${t(e - s)}" role="iTT?captionFormat=ITT.${esc(o.lang ?? "en")}">`);
        lines.push(`                <text placement="bottom"><text-style ref="${id}">${esc(c.text)}</text-style></text>`);
        lines.push(`                <text-style-def id="${id}"><text-style font=".SF NS Text" fontSize="13" fontFace="Regular" fontColor="1 1 1 1" backgroundColor="0 0 0 1"/></text-style-def>`);
        lines.push(`              </caption>`);
      }
    }
    for (const m of l.markers) {
      if (!inside(m.at)) continue;
      const tag = m.kind === "chapter" ? "chapter-marker" : "marker";
      const note = m.comment ? ` note="${esc(m.comment)}"` : "";
      lines.push(`              <${tag} start="${t(local(m.at))}" duration="${t(Math.max(1, Math.min(m.frames, it.at + it.frames - m.at)))}" value="${esc(m.name)}"${note}/>`);
    }
    lines.push(`            </asset-clip>`);
  }
  lines.push(`          </spine>`, `        </sequence>`, `      </project>`, `    </event>`, `  </library>`, `</fcpxml>`, ``);
  return lines.join("\n");
}
