// ffmpeg for the MCP server: probing, one frame as a PNG, silence detection. Every run is watched
// (src/main/record/ffmpeg-run.ts) so a stuck ffmpeg is stopped instead of hanging a tool call.
import type { TimeRange } from "../shared/types";
import { parseDurationMs, parseVideoSize } from "../main/record/export-core";
import { hasAudioStream } from "../main/record/ffmpeg-core";
import { runWatched } from "../main/record/ffmpeg-run";
import { cutAudioArgs } from "../main/record/export-core";

export interface Probe { durationMs: number | null; width?: number; height?: number; video: boolean; audio: boolean; format?: string; stderr: string }

export class Ff {
  constructor(readonly bin: string) {}

  async run(args: string[], onStdout?: (s: string) => void): Promise<{ code: number; stderr: string }> {
    return runWatched(this.bin, args, { onStdout });
  }

  async probe(file: string): Promise<Probe> {
    const r = await this.run(["-nostdin", "-hide_banner", "-i", file]);
    const size = parseVideoSize(r.stderr);
    const format = /Input #0, ([\w,]+), from/.exec(r.stderr)?.[1];
    return { durationMs: parseDurationMs(r.stderr), width: size?.width, height: size?.height, video: /Stream #\d+:\d+.*: Video:/.test(r.stderr), audio: hasAudioStream(r.stderr), format, stderr: r.stderr };
  }

  /**
   * One frame at `ms` as a PNG, scaled to `width` (never up). `seekable` files are seeked before
   * decoding (fast); a MediaRecorder file has no index, so it is decoded up to that point.
   */
  async frame(file: string, ms: number, width: number, seekable: boolean): Promise<Buffer> {
    const at = (Math.max(0, ms) / 1000).toFixed(3);
    const out: Buffer[] = [];
    const args = [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      ...(seekable ? ["-ss", at] : []), "-i", file, ...(seekable ? [] : ["-ss", at]),
      "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2:flags=bicubic`, "-f", "image2pipe", "-vcodec", "png", "pipe:1",
    ];
    const r = await runWatched(this.bin, args, { onData: (d) => out.push(d) });
    const png = Buffer.concat(out);
    if (r.code !== 0 || !png.length) throw new Error(`Could not read a frame at ${at} s${r.stderr ? `: ${r.stderr.trim().split("\n").pop()}` : ""}`);
    return png;
  }

  /** silencedetect over the take's sound (or only over the kept stretches). */
  async silences(file: string, filter: string, keep: TimeRange[] | null = null): Promise<string> {
    const r = await this.run(keep ? cutAudioArgs(file, keep, filter) : ["-nostdin", "-hide_banner", "-i", file, "-vn", "-af", filter, "-f", "null", "-"]);
    return r.stderr;
  }
}
