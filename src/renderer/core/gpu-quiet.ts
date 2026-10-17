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
