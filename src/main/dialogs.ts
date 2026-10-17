// System dialogs and "show in folder" behind one door. A test run sets OPENTAKE_FAKE_DIALOGS to a JSON
// file ({ "folder": "C:\\x" | "cancel", "save": "C:\\x\\a.mp4" | "cancel", "message": 0 }) and nothing
// opens on screen: pickers return the answer, Explorer and Finder calls are only logged.
import { dialog, shell, type BrowserWindow } from "electron";
import { readFileSync } from "node:fs";
import { t } from "../shared/i18n";

interface FakeAnswers { folder?: string; save?: string; message?: number }

function fake(): FakeAnswers | null {
  const file = process.env.OPENTAKE_FAKE_DIALOGS;
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, "utf8")) as FakeAnswers; } catch { return {}; }
}

const parent = (w: BrowserWindow | null) => (w && !w.isDestroyed() ? w : undefined);

/** A folder picker; null when cancelled. */
export async function pickFolder(win: BrowserWindow | null, title: string, defaultPath?: string): Promise<string | null> {
  const f = fake();
  if (f) { console.log("[fake-dialog] folder", title, defaultPath); return !f.folder || f.folder === "cancel" ? null : f.folder; }
  const opts = { title, defaultPath, properties: ["openDirectory", "createDirectory", "promptToCreate"] as ("openDirectory" | "createDirectory" | "promptToCreate")[] };
  const p = parent(win);
  const r = p ? await dialog.showOpenDialog(p, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

/** A Save dialog for one export; null when cancelled. The system asks before replacing a file. */
export async function pickSaveFile(win: BrowserWindow | null, defaultPath: string, ext: string): Promise<string | null> {
  const f = fake();
  if (f) { console.log("[fake-dialog] save", defaultPath); return !f.save || f.save === "cancel" ? null : f.save; }
  const name = ext === "gif" ? "GIF" : ext.toUpperCase();
  const opts = { title: t("main.export.dialogTitle"), defaultPath, filters: [{ name: t("main.export.filterName", { format: name }), extensions: [ext] }] };
  const p = parent(win);
  const r = p ? await dialog.showSaveDialog(p, opts) : await dialog.showSaveDialog(opts);
  return r.canceled || !r.filePath ? null : r.filePath;
}

/** A question with buttons; returns the index of the button pressed. */
export async function ask(win: BrowserWindow | null, o: { message: string; detail?: string; buttons: string[]; defaultId?: number; cancelId?: number }): Promise<number> {
  const f = fake();
  if (f) { console.log("[fake-dialog] ask", o.message); return f.message ?? o.cancelId ?? 0; }
  const opts = { type: "question" as const, noLink: true, ...o };
  const p = parent(win);
  return (p ? await dialog.showMessageBox(p, opts) : await dialog.showMessageBox(opts)).response;
}

/** Shows a file selected in Explorer or Finder. */
export function revealFile(path: string) {
  if (fake()) return console.log("[fake-shell] reveal", path);
  shell.showItemInFolder(path);
}

/** Opens a folder, or a file in its default app. Resolves to an error line, or "" when it opened. */
export async function openPath(path: string): Promise<string> {
  if (fake()) { console.log("[fake-shell] open", path); return ""; }
  return shell.openPath(path);
}

/** Opens a system settings page (privacy permissions). */
export async function openExternal(url: string) {
  if (fake()) return console.log("[fake-shell] external", url);
  await shell.openExternal(url);
}
