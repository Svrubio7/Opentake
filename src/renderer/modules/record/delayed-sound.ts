// The composite's sound for a delayed take (delay-core.ts): the voice waits as long as the picture.
/** What one more audio context adds to a track passing through it. */
export const HOP_MS = 50;

/**
 * The composite's sound when nothing upstream can delay it (a microphone opened without the voice
 * engine), ms behind: the picture is drawn that far behind real time, so the
 * voice waits as long and the file keeps lip sync. Only the composite gets it; the ISO tracks stay live.
 */
export function delayedSound(tracks: MediaStreamTrack[], ms: number): { tracks: MediaStreamTrack[]; dispose: () => void } {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  const dest = ctx.createMediaStreamDestination();
  const delay = ctx.createDelay(ms / 1000 + 1);
  // the trip through this AudioContext adds HOP_MS of its own (measured: a click train straight and
  // through here, side by side, lagged 850 ms with the node at 800), so the node waits that much less
  delay.delayTime.value = Math.max(0, ms - HOP_MS) / 1000;
  delay.connect(dest);
  // one source per track: a stream source only reads a stream's first audio track
  for (const t of tracks) ctx.createMediaStreamSource(new MediaStream([t])).connect(delay);
  void ctx.resume();
  return { tracks: dest.stream.getAudioTracks(), dispose: () => { void ctx.close(); } };
}
