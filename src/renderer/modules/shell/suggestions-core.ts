// Gentle suggestions: a few rules over what the app already knows, each shown until it is acted on
// or dismissed (then never again). Pure: a snapshot in, at most a couple of suggestions out.
import type { ExportPreset, RecordMode } from "@shared/types";

export type SuggestionAction = "look" | "camera" | "settings" | "system-sound-off" | "reels" | "captions";
export interface Suggestion { id: string; text: string; action?: { label: string; does: SuggestionAction } }

/** Under this the recordings drive is worth a word before a long take (under an hour of 1080p with separate tracks). */
export const TIGHT_DISK_BYTES = 15 * 1024 ** 3;
/** A take longer than this is worth captions. */
export const LONG_TAKE_MS = 3 * 60_000;
/** How many suggestions the Record panel shows at once. */
export const MAX_SHOWN = 2;

export interface SetupSnapshot {
  mode: RecordMode;
  backgroundId: string;
  /** the camera's lighting verdict while it is live, else null */
  cameraLight: "good" | "ok" | "poor" | null;
  /** the computer's sound is going into this take */
  systemSound: boolean;
  /** whether the sound comes out of headphones (null: cannot tell) */
  headphones: boolean | null;
  freeBytes: number | null;
  /** a take is running: suggestions wait */
  busy: boolean;
}

/** The suggestions for the Record panel, most useful first. */
export function setupSuggestions(s: SetupSnapshot, dismissed: ReadonlySet<string>): Suggestion[] {
  if (s.busy) return [];
  const out: Suggestion[] = [];
  if (s.freeBytes != null && s.freeBytes < TIGHT_DISK_BYTES) {
    out.push({ id: "disk-tight", text: `The recordings drive has ${(s.freeBytes / 1024 ** 3).toFixed(1)} GB free. A folder on a bigger drive leaves room for long takes.`, action: { label: "Choose a folder", does: "settings" } });
  }
  if (s.systemSound && s.headphones === false) {
    out.push({ id: "headphones", text: "Computer sound is on and your speakers can echo into the mic. Headphones keep the voice clean.", action: { label: "Turn computer sound off", does: "system-sound-off" } });
  }
  if (s.mode !== "screen" && s.cameraLight === "poor") {
    out.push({ id: "camera-dim", text: "Your camera looks dim. Face a window or a lamp, or let Auto lighting help in the Camera tab.", action: { label: "Open Camera", does: "camera" } });
  }
  if (s.mode !== "camera" && s.backgroundId === "none") {
    out.push({ id: "screen-background", text: "Your screen fills the frame edge to edge. A background with a little padding looks more finished.", action: { label: "Pick a background", does: "look" } });
  }
  return out.filter((x) => !dismissed.has(x.id)).slice(0, MAX_SHOWN);
}

/** The export dialog's suggestion: a vertical take on a landscape or square preset. */
export function exportSuggestion(frame: { width: number; height: number } | undefined, preset: ExportPreset, dismissed: ReadonlySet<string>): Suggestion | null {
  if (!frame || dismissed.has("export-reels")) return null;
  const vertical = frame.height > frame.width * 1.2;
  if (!vertical || preset === "vertical" || preset === "custom") return null;
  return { id: "export-reels", text: "This take is vertical. The Reels, TikTok, Shorts preset keeps it full screen at 1080 by 1920.", action: { label: "Use it", does: "reels" } };
}

/** A take row's suggestion: captions for a long take that has none. */
export function takeSuggestion(t: { durationMs: number | null; hasCaptions: boolean }, dismissed: ReadonlySet<string>): Suggestion | null {
  if (dismissed.has("take-captions") || t.hasCaptions || t.durationMs == null || t.durationMs < LONG_TAKE_MS) return null;
  return { id: "take-captions", text: "A long take: captions help everyone who watches without sound.", action: { label: "Make captions", does: "captions" } };
}

/** Whether an output device's name sounds like headphones (null when there is no name to read). */
export function looksLikeHeadphones(label: string | null | undefined): boolean | null {
  if (!label) return null;
  return /head ?(phone|set)|earbud|ear ?phone|airpods|buds|auricular|cascos|casque|kopfh/i.test(label);
}
