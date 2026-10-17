// OWNED BY: ux. The app's settings on disk (settings.json in the app's data folder): where takes are
// recorded, where exports go and what they are called. Every path is checked here; the renderer can
// only ask for a folder through the system picker or pick one this file already knows.
import { app, ipcMain, systemPreferences, type BrowserWindow } from "electron";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { access, constants, mkdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { IPC } from "../shared/ipc";
import type { AppSettings, FolderChoice, FolderStatus, Permissions, PermissionState, SettingsView } from "../shared/types";
import { openExternal, openPath, pickFolder } from "./dialogs";
import { applyLanguage } from "./i18n";
import { t } from "../shared/i18n";
import { isInside, mountRoot, sanitizeSettings, withPastDir } from "./settings-core";

const WIN = process.platform === "win32";
const file = () => join(app.getPath("userData"), "settings.json");
let cache: AppSettings | null = null;

export const defaultRecordingsDir = () => join(app.getPath("documents"), "OpenTake recordings");

export function getSettings(): AppSettings {
  if (cache) return cache;
  try { cache = sanitizeSettings(JSON.parse(readFileSync(file(), "utf8"))); } catch { cache = sanitizeSettings(null); }
  return cache;
}

async function saveSettings(next: AppSettings) {
  cache = sanitizeSettings(next);
  await mkdir(dirname(file()), { recursive: true });
  // written beside and renamed would be safer, but a half-written settings file only costs the defaults
  await writeFile(file(), JSON.stringify(cache, null, 2));
}

/** Where takes are recorded right now (the standard folder unless another was chosen). */
export const recordingsDir = () => resolve(getSettings().recordingsDir ?? defaultRecordingsDir());

export const samePath = (a: string, b: string) => isInside(resolve(a), resolve(b), WIN) && isInside(resolve(b), resolve(a), WIN);

/** The nearest folder above `p` that exists (for free space), or null when even the drive is gone. */
function existingAncestor(p: string): string | null {
  let cur = resolve(p);
  for (;;) {
    if (existsSync(cur)) return cur;
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

async function space(p: string): Promise<{ free: number | null; total: number | null }> {
  const at = existingAncestor(p);
  if (!at) return { free: null, total: null };
  try { const s = await statfs(at); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; } catch { return { free: null, total: null }; }
}

function countTakes(dir: string): number {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "take.json"))).length;
  } catch { return 0; }
}

/**
 * How a folder is doing. A folder that is not there yet is fine when its parent is (it is made on the
 * first take); it is "missing" when the parent or the whole drive is gone (an unplugged USB drive).
 */
export async function folderStatus(path: string, opts: { isDefault?: boolean; takes?: boolean } = {}): Promise<FolderStatus> {
  const p = resolve(path);
  const sp = await space(p);
  const base: FolderStatus = { path: p, isDefault: !!opts.isDefault, state: "ok", freeBytes: sp.free, totalBytes: sp.total };
  if (opts.takes) base.takes = countTakes(p);
  try {
    const s = await stat(p);
    if (!s.isDirectory()) return { ...base, state: "missing" };
    await access(p, constants.W_OK);
    return base;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return { ...base, state: "readonly" };
    // not there: it is made again on the first take, unless its drive or volume is gone
    return driveThere(p) ? base : { ...base, state: "missing" };
  }
}

/** The drive, share or removable volume of a path is connected (settings-core mountRoot). */
export const driveThere = (p: string) => existsSync(mountRoot(resolve(p), process.platform));

/** Makes the folder if needed and proves a file can be written there. Returns a plain error line, or null. */
export async function ensureWritable(dir: string): Promise<string | null> {
  const p = resolve(dir);
  if (!driveThere(p)) return t("main.set.driveGone", { path: p });
  try {
    await mkdir(p, { recursive: true });
    const probe = join(p, `.opentake-write-test-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    return null;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") return t("main.set.cannotWrite", { path: p });
    if (code === "ENOSPC") return t("main.set.driveFull", { path: p });
    return t("main.set.unusable", { path: p, reason: (e as Error).message });
  }
}

/** The recordings folder must be usable before a take starts; a plain line says why not. */
export async function recordingsProblem(): Promise<string | null> {
  const s = getSettings();
  const st = await folderStatus(recordingsDir(), { isDefault: !s.recordingsDir });
  if (st.state === "missing") return t("record.notice.folderMissing", { path: st.path });
  if (st.state === "readonly") return t("record.notice.folderReadonly", { path: st.path });
  return null;
}

export async function settingsView(): Promise<SettingsView> {
  const s = getSettings();
  const rec = recordingsDir();
  const past: FolderStatus[] = [];
  for (const [index, p] of s.pastRecordingsDirs.entries()) {
    if (samePath(p, rec)) continue;
    const st = await folderStatus(p, { takes: true, isDefault: samePath(p, defaultRecordingsDir()) });
    if (st.state === "missing" || (st.takes ?? 0) > 0) past.push({ ...st, index });
  }
  return {
    settings: s,
    recordings: await folderStatus(rec, { isDefault: !s.recordingsDir, takes: true }),
    exportFolder: s.exportDir ? await folderStatus(s.exportDir) : null,
    past,
    platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
  };
}

async function setRecordingsDir(next: string): Promise<FolderChoice> {
  const err = await ensureWritable(next);
  if (err) return { ok: false, error: err, view: await settingsView() };
  const s = getSettings();
  const prev = recordingsDir();
  const isDefault = samePath(next, defaultRecordingsDir());
  await saveSettings({ ...s, recordingsDir: isDefault ? null : resolve(next), pastRecordingsDirs: samePath(prev, next) ? s.pastRecordingsDirs : withPastDir(s.pastRecordingsDirs, prev, next, samePath) });
  return { ok: true, view: await settingsView() };
}

function osPermission(kind: "camera" | "microphone" | "screen"): PermissionState {
  if (process.platform !== "darwin" && process.platform !== "win32") return "granted";
  try { return systemPreferences.getMediaAccessStatus(kind) as PermissionState; } catch { return "unknown"; }
}

export function permissions(): Permissions {
  const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux";
  return {
    camera: osPermission("camera"),
    microphone: osPermission("microphone"),
    screen: platform === "darwin" ? osPermission("screen") : "granted",
    accessibility: platform === "darwin" ? systemPreferences.isTrustedAccessibilityClient(false) : true,
    platform,
  };
}

const PRIVACY_PAGES: Record<string, Record<string, string>> = {
  darwin: {
    camera: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera",
    microphone: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    screen: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
  win32: { camera: "ms-settings:privacy-webcam", microphone: "ms-settings:privacy-microphone" },
};

export function registerSettingsIpc(getMain: () => BrowserWindow | null) {
  ipcMain.handle(IPC.settingsGet, () => settingsView());

  // only the plain choices come from the renderer; folders go through the pickers below
  ipcMain.handle(IPC.settingsSet, async (_e, patch: Partial<AppSettings>) => {
    const s = getSettings();
    const p = (patch && typeof patch === "object" ? patch : {}) as Partial<AppSettings>;
    const next = sanitizeSettings({
      ...s,
      ...(p.nameTemplate !== undefined ? { nameTemplate: p.nameTemplate } : {}),
      ...(p.afterExport !== undefined ? { afterExport: p.afterExport } : {}),
      ...(p.language !== undefined ? { language: p.language } : {}),
      // a fixed folder needs a folder: without one it stays next to the take
      ...(p.exportDestination !== undefined ? { exportDestination: p.exportDestination === "folder" && !s.exportDir ? s.exportDestination : p.exportDestination } : {}),
    });
    await saveSettings(next);
    if (next.language !== s.language) applyLanguage();
    return settingsView();
  });

  ipcMain.handle(IPC.settingsChooseRecordings, async (): Promise<FolderChoice> => {
    const picked = await pickFolder(getMain(), t("main.set.pickRecordings"), recordingsDir());
    if (!picked) return { ok: false, cancelled: true };
    return setRecordingsDir(picked);
  });

  /** back to the standard folder, or to one used before (only folders this file already knows) */
  ipcMain.handle(IPC.settingsUseRecordings, async (_e, which: unknown): Promise<FolderChoice> => {
    const s = getSettings();
    const target = which === "default" ? defaultRecordingsDir() : typeof which === "number" ? s.pastRecordingsDirs[which] : undefined;
    if (!target) return { ok: false, error: t("main.set.unknownFolder") };
    return setRecordingsDir(target);
  });

  ipcMain.handle(IPC.settingsChooseExportDir, async (): Promise<FolderChoice> => {
    const s = getSettings();
    const picked = await pickFolder(getMain(), t("main.set.pickExports"), s.exportDir ?? recordingsDir());
    if (!picked) return { ok: false, cancelled: true };
    const err = await ensureWritable(picked);
    if (err) return { ok: false, error: err, view: await settingsView() };
    await saveSettings({ ...s, exportDir: resolve(picked), exportDestination: "folder" });
    return { ok: true, view: await settingsView() };
  });

  /** opens a folder the settings name: "recordings", "export" or a past folder by its index */
  ipcMain.handle(IPC.settingsOpenFolder, async (_e, which: unknown) => {
    const s = getSettings();
    const target = which === "recordings" ? recordingsDir() : which === "export" ? s.exportDir : typeof which === "number" ? s.pastRecordingsDirs[which] : null;
    if (!target) return t("main.set.unknownFolder");
    if (which === "recordings") await mkdir(target, { recursive: true }).catch(() => {});
    if (!existsSync(target)) return t("main.set.notAvailable", { path: target });
    return openPath(target);
  });

  ipcMain.handle(IPC.permissions, () => permissions());
  ipcMain.handle(IPC.openPrivacy, async (_e, kind: unknown) => {
    const url = PRIVACY_PAGES[process.platform]?.[String(kind)];
    if (url) await openExternal(url);
    return !!url;
  });
}
