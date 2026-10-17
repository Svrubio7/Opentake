// When the composite hands a frame to its recorder (tested in pace-core.test.ts).
// The compositor ticks on a worker timer that can only count whole milliseconds (16 ms for 60 fps).
// canvas.captureStream(60) drops any paint that comes sooner than 1/60 s after the last one, so a
// 16 ms tick lost about every other frame and a 1080p60 take recorded ~44 fps. The composite is
// now captured with captureStream(0) and each frame is asked for by hand, on this clock, and the
// compositor itself draws on it from a fast tick.

export class FramePacer {
  private next = -Infinity;
  constructor(private periodMs: number) {}

  /** True when a frame is due at `now`; keeps the cadence, and never bursts after a stall. */
  due(now: number): boolean {
    // half a millisecond early still counts: a tick that lands at 16.0 for a 16.67 period
    if (now + 0.5 < this.next) return false;
    this.next = now - this.next > this.periodMs ? now + this.periodMs : this.next + this.periodMs;
    return true;
  }
}

/**
 * How often the worker timer ticks (ms). The compositor draws on the first tick a frame is due, so a
 * frame lands at most this late: a timer at the frame period itself (16 ms) jittered to 22-30 ms
 * whenever the page was busy and every late tick was a lost frame.
 */
export const TICK_MS = 4;

/**
 * Whether a picture arrives steadily, read from a running frame count sampled on any clock:
 * `need` new frames in a row, none more than `gapMs` after the one before. A count read from the
 * video itself keeps working while the window paints nothing (minimized or covered), where a
 * requestVideoFrameCallback never fires.
 */
export class SteadyFrames {
  private count: number | null = null;
  private lastAt = 0;
  private good = 0;
  constructor(private gapMs: number, private need = 3) {}

  /** A reading of the frame count at `now`; true once the picture is steady. */
  sample(now: number, count: number): boolean {
    if (this.count == null) { this.count = count; this.lastAt = now; return false; }
    if (count === this.count) return false;
    this.good = now - this.lastAt <= this.gapMs ? this.good + 1 : 0;
    this.count = count;
    this.lastAt = now;
    return this.good >= this.need;
  }
}
