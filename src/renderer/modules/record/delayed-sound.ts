// The composite's sound for a delayed take (delay-core.ts): the voice waits as long as the picture.
/**
 * The composite's sound, ms behind: the picture is drawn that far behind real time, so the
 * voice waits as long and the file keeps lip sync. Only the composite gets it; the ISO tracks stay live.
 */
export function delayedSound(tracks: MediaStreamTrack[], ms: number): { tracks: MediaStreamTrack[]; dispose: () => void } {
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
  const dest = ctx.createMediaStreamDestination();
  const delay = ctx.createDelay(ms / 1000 + 1);
  // the full delay, even though the trip through this AudioContext adds about 50 ms of its own:
  // measured in takes against the same takes without the delay, the full delay is what keeps lip sync
  delay.delayTime.value = ms / 1000;
  delay.connect(dest);
  // one source per track: a stream source only reads a stream's first audio track
  for (const t of tracks) ctx.createMediaStreamSource(new MediaStream([t])).connect(delay);
  void ctx.resume();
  return { tracks: dest.stream.getAudioTracks(), dispose: () => { void ctx.close(); } };
}
