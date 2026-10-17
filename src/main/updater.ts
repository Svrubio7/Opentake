// OWNED BY: shell agent. Auto update from the GitHub releases (electron-updater).
// Checks 10 s after launch and every 6 hours, downloads in the background where this copy can
// replace itself, and restarts only when the person says so and no take is recording or exporting.
// A portable exe or an unsigned mac build cannot replace itself: it only says a new version is out.
import { app, BrowserWindow, ipcMain, shell } from "electron";
import electronUpdater, { type AppUpdater, type UpdateInfo } from "electron-updater";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IPC } from "../shared/ipc";
import type { UpdateStatus } from "../shared/types";
import {
  CHECK_EVERY_MS, DEFAULT_REPO, FIRST_CHECK_MS, canRestart, cleanVersion, errorText, releaseUrl, repoFrom, updateMode,
} from "./updater-core";

function readRepo() {
  try {
    const pkg = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8")) as { repository?: unknown };
    return repoFrom(pkg.repository) ?? DEFAULT_REPO;
  } catch {
    return DEFAULT_REPO;
  }
}

export function registerUpdater() {
  const repo = readRepo();
  // the fake version is a dev tool: a packaged app never reads it
  const fakeVersion = app.isPackaged ? null : cleanVersion(process.env.OPENTAKE_FAKE_VERSION);
  const mode = updateMode({
    platform: process.platform,
    packaged: app.isPackaged,
    portableDir: process.env.PORTABLE_EXECUTABLE_DIR,
    appImage: process.env.APPIMAGE,
    macSigned: import.meta.env.MAIN_VITE_MAC_SIGNED === "1",
    fakeVersion: fakeVersion ?? undefined,
  });

  let status: UpdateStatus = {
    current: fakeVersion ?? app.getVersion(), mode, phase: "idle", releaseUrl: releaseUrl(repo), busy: false, fake: !!fakeVersion,
  };
  let manual = false;
  let checking = false;
  let updater: AppUpdater | null = null;

  const broadcast = () => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.updateStatus, status);
  };
  const patch = (p: Partial<UpdateStatus>) => { status = { ...status, ...p }; broadcast(); };

  ipcMain.handle(IPC.updateStatus, () => status);
  ipcMain.on(IPC.updateBusy, (_e, busy: unknown) => {
    patch({ busy: !!busy });
    // quitting during a take loses it anyway; never let the installer run on top of that
    if (updater) updater.autoInstallOnAppQuit = mode === "install" && !fakeVersion && !status.busy;
  });
  ipcMain.handle(IPC.updateOpenRelease, () => shell.openExternal(releaseUrl(repo, status.version)));

  if (mode === "off") {
    ipcMain.handle(IPC.updateCheck, () => status);
    ipcMain.handle(IPC.updateInstall, () => false);
    return;
  }

  const u: AppUpdater = electronUpdater.autoUpdater;
  updater = u;
  u.logger = null;
  u.autoDownload = mode === "install";
  u.autoInstallOnAppQuit = mode === "install" && !fakeVersion;
  u.allowDowngrade = false;
  // electron-builder writes resources/app-update.yml for the installers; a dev run or a plain folder
  // build has none, so the same feed is written from package.json
  if (fakeVersion || !existsSync(join(process.resourcesPath, "app-update.yml"))) {
    const own = join(app.getPath("userData"), "update-feed.yml");
    const cacheDir = fakeVersion ? "opentake-updater-dev" : "opentake-updater";
    writeFileSync(own, `provider: github\nowner: ${repo.owner}\nrepo: ${repo.repo}\nupdaterCacheDirName: ${cacheDir}\n`);
    u.forceDevUpdateConfig = !app.isPackaged;
    u.updateConfigPath = own;
  }
  if (fakeVersion) {
    // dev: compare the real releases against the fake version
    const SemVer = u.currentVersion.constructor as new (v: string) => typeof u.currentVersion;
    (u as { currentVersion: unknown }).currentVersion = new SemVer(fakeVersion);
  }

  const found = (info: UpdateInfo) => ({ version: info.version, releaseUrl: releaseUrl(repo, info.version) });
  u.on("checking-for-update", () => { if (manual) patch({ phase: "checking", error: undefined }); });
  u.on("update-not-available", () => patch({ phase: "none", checkedAt: Date.now(), error: undefined }));
  u.on("update-available", (info) => patch({ ...found(info), phase: mode === "install" ? "downloading" : "available", percent: 0, checkedAt: Date.now(), error: undefined }));
  u.on("download-progress", (p) => patch({ phase: "downloading", percent: Math.round(p.percent) }));
  u.on("update-downloaded", (info) => patch({ ...found(info), phase: "ready", percent: 100 }));
  u.on("error", (e) => {
    // a failed background check stays quiet; the About popover shows it when asked
    patch({ phase: status.phase === "downloading" ? "available" : "error", error: errorText(e), checkedAt: Date.now() });
  });

  const check = async (asked = false) => {
    // a found or downloaded update stays as it is until the restart
    if (checking || status.phase === "ready" || status.phase === "downloading") return status;
    checking = true;
    manual = asked;
    try { await u.checkForUpdates(); } catch (e) { patch({ phase: "error", error: errorText(e), checkedAt: Date.now() }); }
    finally { checking = false; manual = false; }
    return status;
  };

  ipcMain.handle(IPC.updateCheck, () => check(true));
  ipcMain.handle(IPC.updateInstall, () => {
    if (!canRestart({ ready: status.phase === "ready", busy: status.busy, mode, fake: !!fakeVersion })) return false;
    // isSilent false shows the installer's progress; forceRunAfter reopens the app
    setImmediate(() => u.quitAndInstall(false, true));
    return true;
  });

  setTimeout(() => void check(), FIRST_CHECK_MS);
  setInterval(() => void check(), CHECK_EVERY_MS).unref();
}
