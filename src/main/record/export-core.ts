// The editor's export as pure ffmpeg arguments (tested in export-core.test.ts): cuts, frame presets,
// MP4 / WebM / GIF, quality or a target file size (two passes), and captions burned in with libass.
// The plain "Export MP4" with no edit keeps using compositeArgs / hiresArgs in ffmpeg-core.ts.
import type { ExportOutput, ExportPreset, TimeRange } from "../../shared/types";
import type { hiresGraph } from "./ffmpeg-core";

export interface PresetSpec {
  label: string;
  /** in file names: take-reels.mp4 */
  slug: string;
  size: { width: number; height: number } | null;
  hint: string;
  /** platform limits worth a warning */
  maxSec?: number;
  maxMB?: number;
}

export const PRESETS: Record<ExportPreset, PresetSpec> = {
  original: { label: "Original", slug: "", size: null, hint: "The take's own frame and size" },
  youtube: { label: "YouTube 1080p", slug: "youtube", size: { width: 1920, height: 1080 }, hint: "1920 by 1080, 16:9" },
  vertical: { label: "Reels, TikTok, Shorts", slug: "reels", size: { width: 1080, height: 1920 }, hint: "1080 by 1920, 9:16", maxSec: 180 },
  square: { label: "Square", slug: "square", size: { width: 1080, height: 1080 }, hint: "1080 by 1080, 1:1" },
  linkedin: { label: "LinkedIn", slug: "linkedin", size: { width: 1920, height: 1080 }, hint: "1920 by 1080, up to 10 minutes", maxSec: 600 },
  x: { label: "X (Twitter)", slug: "x", size: { width: 1280, height: 720 }, hint: "1280 by 720, up to 2:20 and 512 MB", maxSec: 140, maxMB: 512 },
  custom: { label: "Custom", slug: "custom", size: null, hint: "Your own width and height" },
};

export const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

/** The output frame for a preset (and the GIF's own smaller frame). */
export function resolveFrame(o: ExportOutput, src: { width: number; height: number }) {
  let W: number, H: number;
  if (o.preset === "custom") {
    W = even(Math.min(4096, Math.max(16, o.width ?? src.width)));
    H = even(Math.min(4096, Math.max(16, o.height ?? src.height)));
  } else {
    const s = PRESETS[o.preset].size;
    W = even(s ? s.width : src.width);
    H = even(s ? s.height : src.height);
  }
  if (o.format === "gif" && o.gif) {
    const gw = even(Math.min(W, Math.max(64, o.gif.width)));
    return { W, H, gifW: gw, gifH: even((H * gw) / W) };
  }
  return { W, H, gifW: null, gifH: null };
}

/** Scale into the frame: the same shape scales, another shape fits with bars or fills and crops. */
export function frameFilter(src: { width: number; height: number }, W: number, H: number, fit: "fit" | "fill"): string {
  // always a scale, even at the same size: ffmpeg 6.1 crashes when a cut hi-res chain goes straight to the encoder
  const same = Math.abs(src.width / src.height - W / H) < 0.01;
  if (same) return `scale=${W}:${H}:flags=lanczos,setsar=1`;
  if (fit === "fill") return `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},setsar=1`;
  return `scale=${W}:${H}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

const sec = (ms: number) => (ms / 1000).toFixed(3);
const range = (r: TimeRange) => (Number.isFinite(r.end) ? `start=${sec(r.start)}:end=${sec(r.end)}` : `start=${sec(r.start)}`);

/**
 * Cuts as filters: one trim per kept stretch, joined by concat. Times are seconds on the input clock,
 * and the output starts at 0, so anything after this (captions) runs on the edited timeline.
 * `v` / `a` are input labels; null `a` means a silent take.
 */
export function cutFilters(v: string, a: string | null, keep: TimeRange[] | null, tag = "k"): { parts: string[]; v: string; a: string | null } {
  if (!keep) return { parts: [], v, a };
  const n = keep.length;
  if (n === 0) throw new Error("Nothing is left after the cuts");
  const parts: string[] = [];
  if (n === 1) {
    parts.push(`[${v}]trim=${range(keep[0])},setpts=PTS-STARTPTS[${tag}v]`);
    if (a) parts.push(`[${a}]atrim=${range(keep[0])},asetpts=PTS-STARTPTS[${tag}a]`);
    return { parts, v: `${tag}v`, a: a ? `${tag}a` : null };
  }
  parts.push(`[${v}]split=${n}${keep.map((_, i) => `[${tag}sv${i}]`).join("")}`);
  if (a) parts.push(`[${a}]asplit=${n}${keep.map((_, i) => `[${tag}sa${i}]`).join("")}`);
  keep.forEach((r, i) => {
    parts.push(`[${tag}sv${i}]trim=${range(r)},setpts=PTS-STARTPTS[${tag}v${i}]`);
    if (a) parts.push(`[${tag}sa${i}]atrim=${range(r)},asetpts=PTS-STARTPTS[${tag}a${i}]`);
  });
  const ins = keep.map((_, i) => (a ? `[${tag}v${i}][${tag}a${i}]` : `[${tag}v${i}]`)).join("");
  parts.push(`${ins}concat=n=${n}:v=1:a=${a ? 1 : 0}[${tag}v]${a ? `[${tag}a]` : ""}`);
  return { parts, v: `${tag}v`, a: a ? `${tag}a` : null };
}

/** Audio only, through the same cuts: for measuring loudness and silence on what will be exported. */
export function cutAudioArgs(input: string, keep: TimeRange[] | null, filter: string): string[] {
  const parts: string[] = [];
  let a = "0:a:0";
  if (keep && keep.length) {
    const n = keep.length;
    if (n === 1) parts.push(`[0:a:0]atrim=${range(keep[0])},asetpts=PTS-STARTPTS[ca]`);
    else {
      parts.push(`[0:a:0]asplit=${n}${keep.map((_, i) => `[s${i}]`).join("")}`);
      keep.forEach((r, i) => parts.push(`[s${i}]atrim=${range(r)},asetpts=PTS-STARTPTS[c${i}]`));
      parts.push(`${keep.map((_, i) => `[c${i}]`).join("")}concat=n=${n}:v=0:a=1[ca]`);
    }
    a = "ca";
  }
  parts.push(`[${a}]${filter}[m]`);
  return ["-nostdin", "-hide_banner", "-i", input, "-filter_complex", parts.join(";"), "-map", "[m]", "-f", "null", "-"];
}

/** File name that says what the export is: take.mp4, take-reels.mp4, take-hires-square-captions.webm, take.gif */
export function exportFileName(kind: "composite" | "hires", o: ExportOutput | undefined, frame?: { W: number; H: number }): string {
  const base = kind === "hires" ? "take-hires" : "take";
  if (!o) return `${base}.mp4`;
  const slug = o.preset === "custom" && frame ? `${frame.W}x${frame.H}` : PRESETS[o.preset].slug;
  return `${base}${slug ? `-${slug}` : ""}${o.captions ? "-captions" : ""}.${o.format}`;
}

/** Video bitrate for a target size: what is left after the audio, with a little room for the container. */
export function sizeBitrateKbps(mb: number, durationSec: number, audioKbps: number): number {
  if (!(durationSec > 0)) return 2000;
  const totalKbits = mb * 8000 * 0.85; // x264 lands up to 10% over on short takes
  return Math.max(150, Math.floor(totalKbits / durationSec - audioKbps));
}

export const AUDIO_KBPS = { mp4: 192, mp4Size: 128, webm: 128 } as const;

/** Warnings shown in the export dialog before you start. */
export function exportWarnings(o: ExportOutput, durationSec: number | null): string[] {
  const out: string[] = [];
  const p = PRESETS[o.preset];
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
  if (durationSec != null && p.maxSec && durationSec > p.maxSec) out.push(`${p.label} takes up to ${clock(p.maxSec)}. This export runs ${clock(durationSec)}.`);
  if (p.maxMB && o.quality.mode === "size" && o.quality.mb > p.maxMB) out.push(`${p.label} takes files up to ${p.maxMB} MB.`);
  if (o.format === "gif" && durationSec != null && durationSec > 15) out.push("A GIF this long will be very large. Under 15 seconds works best.");
  if (o.format === "gif" && o.quality.mode === "size") out.push("A GIF cannot aim for a file size; it uses its frame rate and width.");
  return out;
}

export type SourceGraph =
  | { kind: "composite"; input: string; fps: number }
  | { kind: "hires"; graph: ReturnType<typeof hiresGraph>; fps: number };

export interface EditExportInput {
  source: SourceGraph;
  /** the source picture's size (composite file, or the hi-res frame) */
  srcSize: { width: number; height: number };
  audio: boolean;
  /** kept stretches in ms on the input clock; null = all of it */
  keep: TimeRange[] | null;
  /** the second-pass loudnorm filter, or null */
  loudness: string | null;
  output: ExportOutput;
  /** ASS file and fonts folder, relative to the working directory (the take folder) */
  burn?: { ass: string; fontsDir?: string } | null;
  out: string;
  /** the edited length in seconds (stops both streams together; the screen and the sound can differ by a frame) */
  limitSec?: number | null;
  /** two-pass encoding for a target size */
  pass?: { n: 1 | 2; log: string; kbps: number } | null;
}

/** Everything the editor export runs in one ffmpeg call (or one of the two passes). */
export function editExportArgs(p: EditExportInput): string[] {
  const o = p.output;
  const gif = o.format === "gif";
  // the first of two passes only measures the picture
  const audio = p.audio && !gif && p.pass?.n !== 1;
  const parts: string[] = [];
  const inputs: string[] = [];
  let v: string;
  let a: string | null = null;
  if (p.source.kind === "composite") {
    inputs.push("-i", p.source.input);
    parts.push(`[0:v:0]fps=${p.source.fps},setsar=1[src]`);
    v = "src";
    if (audio) a = "0:a:0";
  } else {
    const g = p.source.graph;
    inputs.push(...g.inputs);
    parts.push(...g.parts);
    v = g.last;
    if (audio) a = `${g.audioIdx}:a:0`;
  }
  const cut = cutFilters(v, a, p.keep);
  parts.push(...cut.parts);
  v = cut.v;
  a = cut.a;

  const { W, H, gifW, gifH } = resolveFrame(o, p.srcSize);
  let chain = frameFilter(p.srcSize, W, H, o.fit);
  if (p.burn) chain += `,ass=filename=${p.burn.ass}${p.burn.fontsDir ? `:fontsdir=${p.burn.fontsDir}` : ""}`;
  if (gif && o.gif) {
    parts.push(`[${v}]${chain},fps=${Math.max(1, Math.min(30, o.gif.fps))},scale=${gifW}:${gifH}:flags=lanczos,split[g1][g2]`);
    parts.push("[g1]palettegen=stats_mode=diff[pal]");
    parts.push("[g2][pal]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[vo]");
  } else {
    parts.push(`[${v}]${chain}[vo]`);
  }
  if (a && p.loudness) { parts.push(`[${a}]${p.loudness}[ao]`); a = "ao"; }

  const fps = p.source.fps;
  const maps = ["-map", "[vo]", ...(a ? ["-map", a.includes(":") ? a : `[${a}]`] : [])];
  let codec: string[];
  if (gif) codec = ["-loop", "0", "-f", "gif"];
  else if (o.format === "webm") {
    const q = p.pass ? ["-b:v", `${p.pass.kbps}k`, "-pass", String(p.pass.n), "-passlogfile", p.pass.log]
      : ["-crf", String(vp9Crf(o.quality.mode === "crf" ? o.quality.crf : 23)), "-b:v", "0"];
    codec = ["-c:v", "libvpx-vp9", "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", ...q, "-pix_fmt", "yuv420p", "-fps_mode", "cfr", "-r", String(fps),
      ...(a ? ["-c:a", "libopus", "-b:a", `${AUDIO_KBPS.webm}k`, "-ar", "48000"] : ["-an"])];
  } else {
    const q = p.pass ? ["-b:v", `${p.pass.kbps}k`, "-pass", String(p.pass.n), "-passlogfile", p.pass.log]
      : ["-crf", String(o.quality.mode === "crf" ? o.quality.crf : 18)];
    codec = ["-c:v", "libx264", "-preset", "medium", ...q, "-profile:v", "high", "-pix_fmt", "yuv420p", "-fps_mode", "cfr", "-r", String(fps),
      ...(a ? ["-c:a", "aac", "-b:a", `${p.pass ? AUDIO_KBPS.mp4Size : AUDIO_KBPS.mp4}k`, "-ar", "48000"] : ["-an"]),
      "-movflags", "+faststart"];
  }
  const target = p.pass?.n === 1 ? ["-f", "null", "-"] : [p.out];
  return [
    "-nostdin", "-y", "-hide_banner",
    ...inputs,
    "-filter_complex", parts.join(";"),
    ...maps, ...codec,
    // the export's length, set outright: -shortest with this graph (concat, loudnorm) could deadlock at the end
    ...(p.limitSec && Number.isFinite(p.limitSec) ? ["-t", p.limitSec.toFixed(3)] : []),
    "-progress", "pipe:1", "-nostats",
    ...target,
  ];
}

/** The x264 crf scale mapped onto VP9's (similar quality, VP9 numbers run higher). */
export const vp9Crf = (x264: number) => Math.round(Math.min(63, Math.max(0, x264 + 13)));

/** "Stream #0:0: Video: vp8, yuv420p, 1920x1080" -> the size */
export function parseVideoSize(probeStderr: string): { width: number; height: number } | null {
  const m = /Stream #\d+:\d+.*: Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(probeStderr);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** "Duration: 00:01:02.50" -> ms, null for N/A (a MediaRecorder file before remuxing). */
export function parseDurationMs(probeStderr: string): number | null {
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(probeStderr);
  return m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : null;
}

/** Peaks for the waveform from mono f32le samples: the loudest sample in each bucket, rounded. */
export function computePeaks(samples: Float32Array, sampleRate: number, perSecond: number): number[] {
  const bucket = Math.max(1, Math.round(sampleRate / perSecond));
  const out = new Array<number>(Math.ceil(samples.length / bucket));
  for (let i = 0; i < out.length; i++) {
    let m = 0;
    const end = Math.min(samples.length, (i + 1) * bucket);
    for (let j = i * bucket; j < end; j++) { const v = Math.abs(samples[j]); if (v > m) m = v; }
    out[i] = Math.round(Math.min(1, m) * 1000) / 1000;
  }
  return out;
}
