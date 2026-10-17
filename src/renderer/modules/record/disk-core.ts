// Disk space decisions for a take: warn before it starts, warn and then stop while it runs.
// Pure: bytes and bitrates in, a verdict out.

/** Under this much free space a new take starts with a warning. */
export const LOW_DISK_BYTES = 2 * 1024 ** 3;
/** While recording: warn under this many minutes left, stop under the second. */
export const WARN_MINUTES = 10;
export const STOP_MINUTES = 1;
/** How often a running take checks the drive. */
export const DISK_POLL_MS = 30_000;
/** Every track that carries sound writes it at this rate (recorder.ts asks MediaRecorder for it). */
export const AUDIO_BPS = 192_000;

export interface TakeStreams {
  /** video bitrate of the composite and of each ISO video track, bits a second */
  videoBps: number[];
  /** how many of the files carry sound */
  audioTracks: number;
}

/** What a take writes, in bits a second. Recorders aim at their bitrate, so this is an upper estimate. */
export const takeBitrate = (t: TakeStreams) => t.videoBps.reduce((a, b) => a + b, 0) + t.audioTracks * AUDIO_BPS;

/** Minutes of recording that fit in `freeBytes` at `bitsPerSecond`. */
export function minutesLeft(freeBytes: number, bitsPerSecond: number): number {
  if (bitsPerSecond <= 0) return Infinity;
  return Math.max(0, freeBytes) * 8 / bitsPerSecond / 60;
}

export type DiskLevel = "ok" | "low" | "stop";
export interface DiskVerdict { level: DiskLevel; message?: string }

const gb = (b: number) => (b / 1024 ** 3).toFixed(1);

export function diskBeforeTake(freeBytes: number): DiskVerdict {
  if (freeBytes >= LOW_DISK_BYTES) return { level: "ok" };
  return { level: "low", message: `Only ${gb(freeBytes)} GB free on the recordings drive. The take may stop early.` };
}

export function diskWhileRecording(freeBytes: number, bitsPerSecond: number): DiskVerdict {
  const m = minutesLeft(freeBytes, bitsPerSecond);
  if (m < STOP_MINUTES) return { level: "stop", message: "Stopped: the recordings drive is almost full. The take is saved." };
  if (m < WARN_MINUTES) {
    const n = Math.floor(m);
    return { level: "low", message: `The recordings drive is almost full: about ${n} minute${n === 1 ? "" : "s"} left.` };
  }
  return { level: "ok" };
}
