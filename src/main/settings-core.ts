// Where takes and exports go, and what they are called: pure rules (tested in settings-core.test.ts).
// The renderer imports these too, so the Settings preview and the export dialog show the same name
// the main process will write.
import type { AfterExport, AppSettings, ExportDestination } from "../shared/types";
import { t } from "../shared/i18n";

export const DEFAULT_NAME_TEMPLATE = "{date} {time} {title} {preset}";

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  recordingsDir: null,
  exportDestination: "take",
  exportDir: null,
  nameTemplate: DEFAULT_NAME_TEMPLATE,
  afterExport: "reveal",
  pastRecordingsDirs: [],
  language: "system",
  theme: "system",
};

/** The words a name template can use, for the Settings help line. */
export const NAME_TOKENS: { token: string; means: string }[] = [
  { token: "{date}", means: "the day the take was recorded, 2026-10-17" },
  { token: "{time}", means: "the time it started, 14.05" },
  { token: "{title}", means: "the take's title, when you gave it one" },
  { token: "{preset}", means: "the export preset, like reels or youtube" },
];

const DESTINATIONS: ExportDestination[] = ["take", "folder", "ask"];
const AFTER: AfterExport[] = ["reveal", "open", "nothing"];
const MAX_TEMPLATE = 120;
const MAX_PAST = 5;

const isPath = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 1024 && !v.includes("\0");

/** Settings from disk (or the renderer): anything unknown or malformed falls back to the default. */
export function sanitizeSettings(raw: unknown): AppSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof AppSettings, unknown>>;
  const template = typeof r.nameTemplate === "string" ? r.nameTemplate.replace(/[\r\n\t]/g, " ").slice(0, MAX_TEMPLATE) : "";
  return {
    version: 1,
    recordingsDir: isPath(r.recordingsDir) ? r.recordingsDir : null,
    exportDestination: DESTINATIONS.includes(r.exportDestination as ExportDestination) ? (r.exportDestination as ExportDestination) : "take",
    exportDir: isPath(r.exportDir) ? r.exportDir : null,
    nameTemplate: template.trim() ? template : DEFAULT_NAME_TEMPLATE,
    afterExport: AFTER.includes(r.afterExport as AfterExport) ? (r.afterExport as AfterExport) : "reveal",
    pastRecordingsDirs: Array.isArray(r.pastRecordingsDirs) ? r.pastRecordingsDirs.filter(isPath).slice(0, MAX_PAST) : [],
    language: r.language === "en" || r.language === "es" ? r.language : "system",
    theme: r.theme === "light" || r.theme === "dark" ? r.theme : "system",
  };
}

/** Remembers the folder takes were going to before a change (newest first, no repeats, never the new one). */
export function withPastDir(past: string[], previous: string, next: string, same: (a: string, b: string) => boolean): string[] {
  return [previous, ...past].filter((p, i, all) => !same(p, next) && all.findIndex((q) => same(p, q)) === i).slice(0, MAX_PAST);
}

// Windows refuses these characters and names anywhere; macOS and Linux refuse "/" and NUL.
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
const MAX_NAME = 120;

/**
 * One file or folder name that works on every system: accents and other scripts are kept, characters
 * Windows refuses become a dash, no dot or space at the end, no reserved device name, at most 120 characters.
 */
export function sanitizeFileName(name: string, fallback = "OpenTake take"): string {
  let s = name.normalize("NFC").replace(BAD_CHARS, "-").replace(/\s+/g, " ").trim();
  // cut by whole characters so an emoji or an accent is never split in half
  const chars = Array.from(s);
  if (chars.length > MAX_NAME) s = chars.slice(0, MAX_NAME).join("");
  s = s.replace(/^[\s.-]+|[\s.]+$/g, "");
  if (!s) s = fallback;
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/** A take's title as typed: one line, no control characters, at most 80 characters. Empty = no title. */
export function cleanTitle(title: unknown): string {
  if (typeof title !== "string") return "";
  return Array.from(title.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()).slice(0, 80).join("").trim();
}

export interface NameParts {
  /** when the take was recorded (ms) */
  createdAt: number;
  title?: string | null;
  /** words for the export kind: "reels captions", "hires youtube", "" for a plain export */
  preset?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Fills a template and makes it a safe file name (without the extension). */
export function renderName(template: string, p: NameParts): string {
  const d = new Date(p.createdAt);
  const values: Record<string, string> = {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}.${pad(d.getMinutes())}`,
    title: cleanTitle(p.title ?? ""),
    preset: (p.preset ?? "").trim(),
  };
  const filled = template.replace(/\{(\w+)\}/g, (all, k: string) => (k.toLowerCase() in values ? values[k.toLowerCase()] : all));
  // an empty token leaves its separator behind: "2026-10-17 14.05  " or "Demo - "
  const tidy = filled.replace(/\s+/g, " ").replace(/\s+([-_,])(?:\s+\1)+\s+/g, " $1 ").replace(/(\s*[-_,]\s*)+$/g, "").replace(/^(\s*[-_,]\s*)+/g, "").trim();
  return sanitizeFileName(tidy, `OpenTake ${values.date} ${values.time}`);
}

/** The export kind as words for {preset}, from the old file name: take-hires-reels-captions.mp4 -> "hires reels captions". */
export function presetWords(legacyFileName: string): string {
  return legacyFileName.replace(/\.\w+$/, "").replace(/^take-?/, "").replace(/-/g, " ").trim();
}

/**
 * The first free name: "Name.mp4", then "Name (2).mp4", "Name (3).mp4"... Every extension in `alsoCheck`
 * (the .srt and .vtt written beside a video) must be free too, so nothing is ever overwritten.
 */
export function uniqueName(stem: string, ext: string, exists: (fileName: string) => boolean, alsoCheck: string[] = []): string {
  const free = (s: string) => !exists(`${s}.${ext}`) && alsoCheck.every((e) => !exists(`${s}.${e}`));
  if (free(stem)) return `${stem}.${ext}`;
  for (let i = 2; i < 10000; i++) {
    const s = `${stem} (${i})`;
    if (free(s)) return `${s}.${ext}`;
  }
  return `${stem} ${Date.now()}.${ext}`;
}

/** An export failure in words a person can act on (the ffmpeg detail stays for the log). */
export function friendlyExportError(message: string): string {
  if (/No space left on device|ENOSPC|not enough space|disk full/i.test(message)) {
    return t("main.export.driveFull");
  }
  if (/Permission denied|EACCES|EPERM|read-only file system|EROFS/i.test(message)) {
    return t("main.export.cannotWrite");
  }
  if (/Export cancelled/.test(message)) return t("main.export.cancelled");
  return message;
}

/** The last "time=HH:MM:SS.xx" ffmpeg printed: how long a file without a length in its header really runs. */
export function lastStatsTimeMs(stderr: string): number | null {
  const all = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const m = all[all.length - 1];
  if (!m) return null;
  const ms = Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
  return ms > 0 ? ms : null;
}

/** Whether a path sits on the folder or inside it (paths already resolved; Windows compares without case). */
export function isInside(child: string, folder: string, windows: boolean): boolean {
  const norm = (p: string) => {
    const s = p.replace(/[\\/]+/g, "/").replace(/\/$/, "");
    return windows ? s.toLowerCase() : s;
  };
  const c = norm(child), f = norm(folder);
  return c === f || c.startsWith(`${f}/`);
}

/**
 * The part of a path that must already exist for it to be "there": a Windows drive or network share,
 * or a removable volume on macOS (/Volumes/X) and Linux (/media/<user>/X, /run/media/<user>/X, /mnt/X).
 * When it is gone the drive is unplugged, and the folder must never be made again on the system disk.
 */
export function mountRoot(p: string, platform: string): string {
  if (platform === "win32") {
    const unc = /^(\\\\[^\\/]+[\\/][^\\/]+)/.exec(p);
    if (unc) return `${unc[1]}\\`;
    const drive = /^([a-zA-Z]:)/.exec(p);
    return drive ? `${drive[1]}\\` : p;
  }
  const parts = p.split("/").filter(Boolean);
  if (parts[0] === "Volumes" && parts[1]) return `/Volumes/${parts[1]}`;
  if (parts[0] === "media" && parts[2]) return `/media/${parts[1]}/${parts[2]}`;
  if (parts[0] === "run" && parts[1] === "media" && parts[3]) return `/run/media/${parts[2]}/${parts[3]}`;
  if (parts[0] === "mnt" && parts[1]) return `/mnt/${parts[1]}`;
  return "/";
}

/** A long path shortened from the left so the folder names stay readable: "…\Videos\OpenTake recordings". */
export function shortPath(p: string, max = 44): string {
  if (p.length <= max) return p;
  const sep = p.includes("\\") ? "\\" : "/";
  const parts = p.split(/[\\/]/).filter(Boolean);
  let out = parts[parts.length - 1] ?? p;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}${sep}${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  if (out.length + 2 > max) out = `${Array.from(out).slice(-(max - 2)).join("")}`;
  return `…${sep}${out}`;
}
