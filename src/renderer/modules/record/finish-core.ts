// Ending a take safely, as pure rules (tested in finish-core.test.ts). Stop must always finish:
// a recorder whose encoder died never fires "stop", and a chunk write that never answers held the
// take in "stopping" with take.json left on "recording" (QA, 1.1.0: Stop hung for over 12 s).

/** How long Stop waits for each recorder to hand over its last data. */
export const STOP_WAIT_MS = 3000;
/** How long Stop waits for the last chunks to reach the disk. */
export const WRITE_WAIT_MS = 8000;
/** A recording track that hands over no data for this long has stopped recording. */
export const STALL_MS = 6000;

/** Resolves true when `p` settles within `ms`, false when the time ran out first (never rejects). */
export function settleWithin(p: Promise<unknown>, ms: number, timer: (fn: () => void, ms: number) => unknown = setTimeout): Promise<boolean> {
  return new Promise((done) => {
    let over = false;
    timer(() => { if (!over) { over = true; done(false); } }, ms);
    p.then(() => { if (!over) { over = true; done(true); } }, () => { if (!over) { over = true; done(true); } });
  });
}

export interface TrackClock {
  track: string;
  /** when the recorder was started (wall ms), null while it waits for its delayed start */
  startedAt: number | null;
  /** when it last handed over data (wall ms) */
  lastDataAt: number | null;
}

/**
 * Tracks that should be delivering data but have gone quiet: started, not paused, nothing for
 * STALL_MS (each hands a chunk over every second while it records).
 */
export function stalledTracks(tracks: TrackClock[], now: number, paused: boolean, stallMs = STALL_MS): string[] {
  if (paused) return [];
  return tracks.filter((t) => t.startedAt != null && now - Math.max(t.startedAt, t.lastDataAt ?? 0) > stallMs).map((t) => t.track);
}
