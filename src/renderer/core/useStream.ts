import { useSyncExternalStore } from "react";
import type { StreamKind } from "@shared/types";
import { getStream, subscribeStreams } from "./streams";

export function useStream(kind: StreamKind) {
  return useSyncExternalStore(subscribeStreams, () => getStream(kind));
}
