// A short hold on reading pixels back from the GPU while a take's recorders start.
// Starting MediaRecorders sets up their video encoders on the GPU; for a few hundred ms any
// synchronous readback (MediaPipe's readPixels, getImageData of a video or WebGL canvas) waits for
// them on the main thread. Measured: one face-detector readback blocked the page for ~470 ms at
// the start of every take, so the camera picture and a live composite froze for that long.
// The recorder asks for quiet; the camera keeps its last mask, face and meter until it ends.

let quietUntil = 0;

/** Asks every module to skip GPU readbacks for the next `ms` (a later end never shortens it). */
export function holdGpuReadbacks(ms: number, now = performance.now()) {
  quietUntil = Math.max(quietUntil, now + ms);
}

/** True while readbacks should wait. */
export const gpuReadbacksHeld = (now = performance.now()) => now < quietUntil;

// ---- readbacks right after a composite frame ----
// A synchronous readback waits 10-17 ms for the GPU. Done at a random moment it often made the
// compositor miss its next 60 fps frame; done right after the compositor drew one, the wait fits
// inside the 16.7 ms before the next. Each module queues its readback under a key (one at a time).

const queued = new Map<string, () => void>();
let lastFrameAt = -Infinity;

/** No compositor frame for this long: readbacks run at once (nothing to stay out of the way of). */
export const FRAMES_STOPPED_MS = 100;

/** Runs `job` right after the next composite frame, or now when no frames are being drawn. */
export function afterNextFrame(key: string, job: () => void, now = performance.now()) {
  if (now - lastFrameAt > FRAMES_STOPPED_MS) { queued.delete(key); job(); return; }
  queued.set(key, job);
}

/** The compositor drew a frame: one queued readback runs now, the rest after the next frames. */
export function frameDrawn(now = performance.now()) {
  lastFrameAt = now;
  const first = queued.entries().next();
  if (first.done) return;
  queued.delete(first.value[0]);
  first.value[1]();
}
