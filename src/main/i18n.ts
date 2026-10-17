// The main process's language (dialogs, errors it sends to windows) and the door every window asks
// for theirs. settings.json holds the choice; "system" follows the system's preferred languages.
import { app, BrowserWindow, ipcMain } from "electron";
import { IPC } from "../shared/ipc";
import { getLang, getLocale, localeFor, resolveLang, setLang } from "../shared/i18n";
import { getSettings } from "./settings";

const systemLocales = () => {
  try { const p = app.getPreferredSystemLanguages(); if (p.length) return p; } catch { /* older systems */ }
  return [app.getLocale()];
};

const info = () => ({ lang: getLang(), locale: getLocale(), setting: getSettings().language });

/** Applies the saved choice; when it changed, every open window switches too. */
export function applyLanguage() {
  const sys = systemLocales();
  const l = resolveLang(getSettings().language, sys);
  const before = `${getLang()} ${getLocale()}`;
  setLang(l, localeFor(l, sys));
  if (`${getLang()} ${getLocale()}` === before) return;
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(IPC.langChanged, info());
}

export function registerLanguageIpc() {
  applyLanguage();
  ipcMain.handle(IPC.langGet, () => info());
}
