// The one place modules hand each other live MediaStreams.
// audio publishes "mic" (the PROCESSED voice), camera publishes "camera" (the FILTERED picture),
// record publishes "screen". The recorder reads whatever is published when recording starts.
import type { StreamKind } from "@shared/types";

const streams = new Map<StreamKind, MediaStream>();
const listeners = new Set<() => void>();

export function publishStream(kind: StreamKind, stream: MediaStream | null) {
  if (stream) streams.set(kind, stream); else streams.delete(kind);
  listeners.forEach((l) => l());
}
export function getStream(kind: StreamKind) { return streams.get(kind) ?? null; }
export function subscribeStreams(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; }
