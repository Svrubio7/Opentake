// The window's language: asked from main before the first render (so no English flashes by), then
// followed live when Settings changes it. useLang() at a root re-renders the whole tree on a switch.
import { createElement, Fragment, useSyncExternalStore, type ReactNode } from "react";
import { IPC } from "@shared/ipc";
import { getLang, localeFor, onLang, resolveLang, setLang, type Lang, type LangSetting } from "@shared/i18n";

export interface LangInfo { lang: Lang; locale: string; setting: LangSetting }

const bridge = () => (typeof window !== "undefined" ? window.take : undefined);

/** Sets the language before the window first draws; outside the app it follows the browser. */
export async function initLang() {
  const b = bridge();
  if (!b) {
    const sys = typeof navigator !== "undefined" ? [...navigator.languages] : [];
    const l = resolveLang("system", sys);
    setLang(l, localeFor(l, sys));
    return;
  }
  try {
    const info = (await b.invoke(IPC.langGet)) as LangInfo;
    setLang(info.lang, info.locale);
  } catch { /* main not ready: English */ }
  b.on(IPC.langChanged, (info) => { const i = info as LangInfo; setLang(i.lang, i.locale); });
}

/** The current language; the component re-renders when it changes. */
export const useLang = () => useSyncExternalStore(onLang, getLang, getLang);

/** Keeps <html lang> on the current language (screen readers, hyphenation, spell check). */
onLang(() => { if (typeof document !== "undefined") document.documentElement.lang = getLang(); });

/** A translated sentence with parts in markup: t("x", { name: "{name}" }) keeps the slot, parts.name fills it. */
export function rich(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((bit, n) => {
    const k = /^\{(\w+)\}$/.exec(bit)?.[1];
    return createElement(Fragment, { key: n }, k && k in parts ? parts[k] : bit);
  });
}
