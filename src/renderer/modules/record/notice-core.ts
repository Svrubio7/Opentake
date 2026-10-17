// When a message under the stage stops being true. Every notice and error the record bar can show is
// matched here with the state that makes it stale, so a message never outlives its reason (tested in
// notice-core.test.ts). Informational notices also go away by themselves after a while.
// A message is kept in the language it was shown in, so each one is matched in English and Spanish.
import type { RecordMode } from "@shared/types";
import { tIn, type Key, type Msg } from "../../../shared/i18n";
import { en } from "../../../shared/i18n/en";
import { es } from "../../../shared/i18n/es";
import { needsScreen } from "./layout-core";

/** The English forms (what the tests and the logs read); show them with t() of the same key. */
// the English forms, for tests; the app shows t(key) and matches both languages (is() below)
export const PICK_NOTICE = tIn("en", "record.notice.pick");
export const WINDOW_CLOSED_NOTICE = tIn("en", "record.notice.windowClosed");
export const NAME_CARD_NOTICE = tIn("en", "record.notice.nameCard");
export const SAVED_NOTICE = tIn("en", "record.notice.saved");

const forms = (m: Msg) => (typeof m === "string" ? [m] : [m.one, m.other]);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cache = new Map<string, RegExp>();
/** A template as a pattern: every {variable} matches anything. */
const pattern = (tpl: string) => {
  let re = cache.get(tpl);
  if (!re) { re = new RegExp(`^${tpl.split(/\{\w+\}/).map(esc).join("[\\s\\S]*?")}$`); cache.set(tpl, re); }
  return re;
};
/** The message is one of these keys, in either language. */
const is = (msg: string, ...keys: Key[]) => keys.some((k) => [...forms(en[k]), ...forms(es[k])].some((f) => pattern(f).test(msg)));

// folder problems also come from the main process (settings.ts) in its own words
const FOLDER_PROBLEM = /recordings folder .*(is not available|cannot write)|cannot write to the recordings folder|carpeta de grabaciones .*(no está disponible|no puede escribir)|no puede escribir en la carpeta de grabaciones/i;
// "a take was recovered" comes from the shell
const RECOVERED = /(was|were) recovered and (is|are) in Takes|recuperadas? .*\bTomas\b/i;

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
  if (is(msg, "record.notice.pick", "record.notice.windowClosed", "record.notice.windowClosedShort")) return screenGone;
  if (is(msg, "record.picker.captureFailed")) return screenGone;
  if (FOLDER_PROBLEM.test(msg) || is(msg, "record.notice.folderMissing", "record.notice.folderReadonly")) return s.folderOk === true;
  // about the take that was running: once it has ended the message has no subject
  if (is(msg, "record.notice.noComputerSound", "record.notice.noComputerSoundWhy", "record.disk.minutes", "record.disk.low")) {
    return s.status === "idle";
  }
  if (is(msg, "record.notice.nameCard")) return s.nameCard;
  return false;
}

/** How long an informational notice stays (ms); null = until dismissed or stale. Errors never time out. */
export function noticeLifetimeMs(msg: string): number | null {
  if (is(msg, "record.notice.saved")) return 12_000;
  if (is(msg, "record.notice.nameCard")) return 8_000;
  if (RECOVERED.test(msg)) return 20_000;
  return null;
}
