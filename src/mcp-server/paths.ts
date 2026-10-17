// Where the MCP server finds OpenTake's data without Electron: the app's data folder (settings.json,
// the bridge file, the activity list), the recordings folder Settings points at, and ffmpeg.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AppSettings } from "../shared/types";
import { sanitizeSettings } from "../main/settings-core";
import { APP_INFO_FILE, type AppInfo } from "../shared/assistant";

/** The app's data folder: what the setup passed in OPENTAKE_USER_DATA, else Electron's default for "OpenTake". */
export function userDataDir(env = process.env, platform = process.platform): string {
  if (env.OPENTAKE_USER_DATA) return resolve(env.OPENTAKE_USER_DATA);
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "OpenTake");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "OpenTake");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "OpenTake");
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** What the app wrote about itself the last time it started (assistant/app.json), or null. */
export function appInfo(userData: string): AppInfo | null {
  return (readJson(join(userData, APP_INFO_FILE)) as AppInfo | null) ?? null;
}

/** Settings as the app saved them (read fresh every time: the person may change them while we run). */
export const readSettings = (userData: string): AppSettings => sanitizeSettings(readJson(join(userData, "settings.json")));

/** The recordings folder Settings points at. */
export function recordingsRoot(userData: string): string {
  const s = readSettings(userData);
  if (s.recordingsDir) return resolve(s.recordingsDir);
  return resolve(appInfo(userData)?.defaultRecordingsDir ?? join(homedir(), "Documents", "OpenTake recordings"));
}

const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/** The ffmpeg that ships inside the app, found from the running executable, the app's note, or the dev checkout. */
export function ffmpegBinary(userData: string, env = process.env): string {
  if (env.OPENTAKE_FFMPEG && existsSync(env.OPENTAKE_FFMPEG)) return env.OPENTAKE_FFMPEG;
  const exeDir = dirname(process.execPath);
  const resources = process.platform === "darwin" ? join(exeDir, "..", "Resources") : join(exeDir, "resources");
  const candidates = [
    join(resources, "app.asar.unpacked", "node_modules", "ffmpeg-static", ffmpegName),
    appInfo(userData)?.ffmpeg,
  ];
  // a dev checkout: walk up from the server script to the folder with node_modules
  let dir = dirname(resolve(process.argv[1] ?? "."));
  for (let i = 0; i < 6; i++, dir = dirname(dir)) candidates.push(join(dir, "node_modules", "ffmpeg-static", ffmpegName));
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? "ffmpeg";
}
