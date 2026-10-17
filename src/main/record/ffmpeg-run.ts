// Runs ffmpeg with a watchdog: a run whose position stops moving is stopped and reported, never left
// hanging (tested in ffmpeg-run.test.ts). Activity is the -progress clock moving forward, or anything
// new on stderr (the stats line of runs without -progress, warnings).
import { spawn, type ChildProcess } from "node:child_process";
import { parseProgressTime } from "./ffmpeg-core";

/** No forward progress for this long and the run is stopped (a 4K render still moves every second). */
export const STALL_MS = 90_000;

export class FfmpegStalled extends Error {
  constructor(seconds: number) {
    super(`ffmpeg stopped making progress for ${seconds} seconds, so the export was stopped. Try again.`);
  }
}

/** Tracks the -progress clock across stdout chunks (a line can arrive in two pieces). */
export function progressTracker() {
  let carry = "";
  let last = -1;
  return {
    /** the position in ms when this chunk moved it forward, else null */
    feed(chunk: string): number | null {
      const text = carry + chunk;
      const cut = text.lastIndexOf("\n");
      carry = cut < 0 ? text : text.slice(cut + 1);
      const t = cut < 0 ? null : parseProgressTime(text.slice(0, cut));
      if (t == null || t <= last) return null;
      last = t;
      return t;
    },
  };
}

export interface WatchedOptions {
  cwd?: string;
  onStdout?: (s: string) => void;
  stallMs?: number;
  /** called with the child as soon as it starts (for cancelling) */
  onSpawn?: (p: ChildProcess) => void;
}

export function runWatched(bin: string, args: string[], o: WatchedOptions = {}): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd: o.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    o.onSpawn?.(p);
    const stallMs = o.stallMs ?? STALL_MS;
    let stderr = "";
    let stalled = false;
    let timer: ReturnType<typeof setTimeout>;
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = true; p.kill("SIGKILL"); }, stallMs);
    };
    alive();
    const tracker = progressTracker();
    // both pipes are always drained, so ffmpeg can never block on a full pipe
    p.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      alive();
    });
    p.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      if (tracker.feed(s) != null) alive();
      o.onStdout?.(s);
    });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (stalled) reject(new FfmpegStalled(Math.round(stallMs / 1000)));
      else resolve({ code: code ?? -1, stderr });
    });
  });
}
