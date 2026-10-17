// When a message under the stage stops being true. Every notice and error the record bar can show is
// matched here with the state that makes it stale, so a message never outlives its reason (tested in
// notice-core.test.ts). Informational notices also go away by themselves after a while.
import type { RecordMode } from "@shared/types";
import { needsScreen } from "./layout-core";

export const PICK_NOTICE = "Choose a screen or a window, then press Record again.";
export const WINDOW_CLOSED_NOTICE = "The captured window closed. Choose another screen or window.";
export const NAME_CARD_NOTICE = "Turn on the name card first (Record, Overlays).";
export const SAVED_NOTICE = "Saved. Your take is in Takes.";

export interface MessageState {
  mode: RecordMode;
  sourceId: string | null;
  status: "idle" | "countdown" | "recording" | "paused" | "stopping";
  /** the recordings folder is usable (null: not known yet) */
  folderOk: boolean | null;
  /** the name card is switched on */
  nameCard: boolean;
}

/** Whether a message no longer applies. */
export function isStale(msg: string, s: MessageState): boolean {
  const screenGone = !needsScreen(s.mode) || !!s.sourceId;
  if (msg === PICK_NOTICE || msg === WINDOW_CLOSED_NOTICE || msg === "The captured window closed.") return screenGone;
  if (msg.startsWith("Could not capture ")) return screenGone;
  if (/recordings folder .*(is not available|cannot write)|cannot write to the recordings folder/i.test(msg)) return s.folderOk === true;
  // about the take that was running: once it has ended the message has no subject
  if (msg.startsWith("Recording without computer sound") || /recordings drive is almost full: about/.test(msg) || /GB free on the recordings drive\. The take may stop early/.test(msg)) {
    return s.status === "idle";
  }
  if (msg === NAME_CARD_NOTICE) return s.nameCard;
  return false;
}

/** How long an informational notice stays (ms); null = until dismissed or stale. Errors never time out. */
export function noticeLifetimeMs(msg: string): number | null {
  if (msg === SAVED_NOTICE) return 12_000;
  if (msg === NAME_CARD_NOTICE) return 8_000;
  if (/(was|were) recovered and (is|are) in Takes/.test(msg)) return 20_000;
  return null;
}
