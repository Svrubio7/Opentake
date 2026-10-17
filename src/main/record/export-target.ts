// Where an export is written and under what name: the Settings choice (next to the take, a fixed
// folder, or a Save dialog), the name template, and a free name so nothing is ever overwritten.
import type { BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ExportOptions } from "../../shared/types";
import { pickSaveFile } from "../dialogs";
import { ensureWritable, folderStatus, getSettings } from "../settings";
import { presetWords, renderName, uniqueName } from "../settings-core";
import { readCaptions } from "./editor-store";
import { exportFileName, resolveFrame } from "./export-core";
import type { TakeMeta } from "./takes";
import { t } from "../../shared/i18n";

/** the folder the last Save dialog ended in, offered first next time */
let lastAskedDir: string | null = null;

/** The file name stem a take's export gets from the template (also shown in the export dialog). */
export function exportStem(o: Pick<ExportOptions, "kind" | "output">, meta: Pick<TakeMeta, "createdAt" | "title">): string {
  const output = o.output;
  const frame = output ? resolveFrame(output, { width: 1920, height: 1080 }) : undefined;
  return renderName(getSettings().nameTemplate, { createdAt: meta.createdAt, title: meta.title, preset: presetWords(exportFileName(o.kind, output, frame)) });
}

/**
 * The absolute path to write, or null when the person cancelled the Save dialog. Throws a plain line
 * when the chosen folder cannot be used (its drive unplugged, no permission).
 */
export async function exportTarget(o: ExportOptions, meta: TakeMeta, takeFolder: string, win: BrowserWindow | null): Promise<string | null> {
  const s = getSettings();
  const ext = o.output?.format ?? "mp4";
  const stem = exportStem(o, meta);
  // the .srt and .vtt written beside a video need free names too
  const withCaptions = ext !== "gif" && !!(await readCaptions(o.takeId))?.lines.length;
  const also = withCaptions ? ["srt", "vtt"] : [];

  if (s.exportDestination === "ask" && o.manual) {
    const start = lastAskedDir && existsSync(lastAskedDir) ? lastAskedDir : s.exportDir && existsSync(s.exportDir) ? s.exportDir : takeFolder;
    const picked = await pickSaveFile(win, join(start, uniqueName(stem, ext, (n) => existsSync(join(start, n)), also)), ext);
    if (!picked) return null;
    const file = extname(picked).toLowerCase() === `.${ext}` ? picked : `${picked}.${ext}`;
    const err = await ensureWritable(dirname(file));
    if (err) throw new Error(err);
    lastAskedDir = dirname(file);
    return file;
  }

  // a fixed folder (the export on stop with "ask" goes next to the take: nobody is there to answer)
  const folder = s.exportDestination === "folder" && s.exportDir ? s.exportDir : takeFolder;
  if (folder !== takeFolder) {
    const st = await folderStatus(folder);
    if (st.state === "missing") throw new Error(t("main.export.folderMissing", { path: st.path }));
    const err = await ensureWritable(folder);
    if (err) throw new Error(err);
  }
  return join(folder, uniqueName(stem, ext, (n) => existsSync(join(folder, n)), also));
}
