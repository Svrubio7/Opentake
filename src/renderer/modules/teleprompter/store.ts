// Controller state for the prompter (main window). The panel edits it, IPC mirrors it to the
// prompter window, and settings and scripts persist in localStorage.
import { create } from "zustand";
import type { PrompterState } from "@shared/types";
import { IPC } from "@shared/ipc";
import { t } from "@shared/i18n";
import { DEFAULT_STATE, detectLang, parseScript, reduceCommand, type Lang, type ParsedScript, type PrompterCommand } from "./prompter-core";
import type { VoiceStatus } from "./voice";

export interface SavedScript { id: string; title: string; text: string; updatedAt: number }

export interface WindowOptions { opacity: number; clickThrough: boolean; hideFromCapture: boolean }

/** The in-window overlay box, as fractions of the main window so it survives resizes. */
export interface OverlayRect { x: number; y: number; w: number; h: number }

export interface Settings {
  countdownSec: number;
  langChoice: "auto" | Lang;
  /** limit recognition to the script's own words */
  scriptWordsOnly: boolean;
  /** dB over the room noise that counts as talking (voice pacing) */
  vadMargin: number;
  window: WindowOptions;
  /** where the prompter shows: over the app (default) or popped out into its own window */
  display: "overlay" | "window";
  overlay: OverlayRect;
  /** open the prompter by itself when a take starts and there is a script */
  showOnRecord: boolean;
}

interface Store {
  state: PrompterState;
  settings: Settings;
  scripts: SavedScript[];
  currentId: string | null;
  windowOpen: boolean;
  overlayOpen: boolean;
  shortcutsFailed: string[];
  voice: VoiceStatus;
  heard: string;
  patch: (p: Partial<PrompterState>) => void;
  setSettings: (p: Partial<Settings>) => void;
  command: (cmd: PrompterCommand) => void;
  setScript: (text: string) => void;
  newScript: () => void;
  loadScript: (id: string) => void;
  deleteScript: (id: string) => void;
}

const KEY_SETTINGS = "take.prompter.settings.v1";
const KEY_SCRIPTS = "take.prompter.scripts.v1";
const MAX_SCRIPTS = 30;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function readList<T>(key: string): T[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

const DEFAULT_SETTINGS: Settings = {
  countdownSec: 3,
  langChoice: "auto",
  scriptWordsOnly: true,
  vadMargin: 12,
  window: { opacity: 1, clickThrough: false, hideFromCapture: true },
  display: "overlay",
  overlay: { x: 0.2, y: 0.01, w: 0.42, h: 0.3 },
  showOnRecord: true,
};

const PERSISTED = ["wpm", "fontSize", "mirrored", "mode", "lineWidth", "guide", "showNotes"] as const;
type Persisted = Pick<PrompterState, (typeof PERSISTED)[number]>;

export function titleOf(text: string): string {
  const first = text.split(/\r?\n/).map((l) => l.replace(/^[#>\-*\s]+/, "").trim()).find(Boolean) ?? "";
  return first.length > 48 ? first.slice(0, 47) + "…" : first || t("prompter.untitled");
}

const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

let parsedCache: { script: string; lang: Lang; parsed: ParsedScript } | null = null;
/** The parsed script for the current state, memoised. */
export function parsedFor(state: Pick<PrompterState, "script" | "lang">): ParsedScript {
  if (!parsedCache || parsedCache.script !== state.script || parsedCache.lang !== state.lang) {
    parsedCache = { script: state.script, lang: state.lang, parsed: parseScript(state.script, state.lang) };
  }
  return parsedCache.parsed;
}

const resolveLang = (choice: Settings["langChoice"], script: string): Lang => (choice === "auto" ? detectLang(script) : choice);

const initialSettings = read(KEY_SETTINGS, { ...DEFAULT_SETTINGS, prompter: {} as Partial<Persisted> });
const initialScripts = readList<SavedScript>(KEY_SCRIPTS);
const initialScript = initialScripts[0] ?? null;
const { prompter: persistedPrompter, ...settingsOnly } = initialSettings;
const initialSettingsClean: Settings = {
  ...DEFAULT_SETTINGS, ...settingsOnly,
  window: { ...DEFAULT_SETTINGS.window, ...settingsOnly.window },
  overlay: { ...DEFAULT_SETTINGS.overlay, ...settingsOnly.overlay },
};

export const usePrompter = create<Store>((set, get) => ({
  state: {
    ...DEFAULT_STATE,
    ...persistedPrompter,
    script: initialScript?.text ?? "",
    lang: resolveLang(initialSettingsClean.langChoice, initialScript?.text ?? ""),
    playing: false,
  },
  settings: initialSettingsClean,
  scripts: initialScripts,
  currentId: initialScript?.id ?? null,
  windowOpen: false,
  overlayOpen: false,
  shortcutsFailed: [],
  voice: { mic: "off", recognizer: "off" },
  heard: "",

  patch: (p) => set((s) => ({ state: { ...s.state, ...p } })),

  setSettings: (p) => set((s) => {
    const settings = { ...s.settings, ...p, window: { ...s.settings.window, ...p.window }, overlay: { ...s.settings.overlay, ...p.overlay } };
    const lang = resolveLang(settings.langChoice, s.state.script);
    return { settings, state: lang === s.state.lang ? s.state : { ...s.state, lang } };
  }),

  command: (cmd) => {
    const { state, settings } = get();
    if (cmd.type === "click-through") {
      get().setSettings({ window: { ...settings.window, clickThrough: !settings.window.clickThrough } });
      return;
    }
    if (cmd.type === "close") { set({ overlayOpen: false }); void window.take.invoke(IPC.prompterClose); return; }
    const next = reduceCommand(state, cmd, parsedFor(state), Date.now(), settings.countdownSec);
    if (next !== state) set({ state: next });
  },

  setScript: (text) => set((s) => {
    const now = Date.now();
    let { currentId, scripts } = s;
    if (!currentId) {
      if (!text.trim()) return { state: { ...s.state, script: text } };
      currentId = newId();
      scripts = [{ id: currentId, title: titleOf(text), text, updatedAt: now }, ...scripts];
    } else {
      const found = scripts.find((x) => x.id === currentId);
      const updated = { id: currentId, title: titleOf(text), text, updatedAt: now };
      scripts = [updated, ...scripts.filter((x) => x !== found)];
    }
    scripts = scripts.slice(0, MAX_SCRIPTS);
    const lang = resolveLang(s.settings.langChoice, text);
    const position = Math.min(s.state.position, parseScript(text, lang).words.length);
    return { scripts, currentId, state: { ...s.state, script: text, lang, position, target: Math.min(s.state.target, position) } };
  }),

  newScript: () => set((s) => ({
    currentId: null,
    state: { ...s.state, script: "", playing: false, position: 0, target: 0, seek: { word: 0, nonce: s.state.seek.nonce + 1 } },
  })),

  loadScript: (id) => set((s) => {
    const found = s.scripts.find((x) => x.id === id);
    if (!found) return {};
    return {
      currentId: id,
      state: {
        ...s.state, script: found.text, lang: resolveLang(s.settings.langChoice, found.text),
        playing: false, position: 0, target: 0, seek: { word: 0, nonce: s.state.seek.nonce + 1 },
      },
    };
  }),

  deleteScript: (id) => set((s) => {
    const scripts = s.scripts.filter((x) => x.id !== id);
    if (s.currentId !== id) return { scripts };
    return { scripts, currentId: null, state: { ...s.state, script: "", playing: false, position: 0, target: 0, seek: { word: 0, nonce: s.state.seek.nonce + 1 } } };
  }),
}));

// persistence: settings on every change, scripts debounced (typing)
let scriptTimer: ReturnType<typeof setTimeout> | null = null;
usePrompter.subscribe((s, prev) => {
  if (s.settings !== prev.settings || PERSISTED.some((k) => s.state[k] !== prev.state[k])) {
    const prompter = Object.fromEntries(PERSISTED.map((k) => [k, s.state[k]]));
    write(KEY_SETTINGS, { ...s.settings, prompter });
  }
  if (s.scripts !== prev.scripts) {
    if (scriptTimer) clearTimeout(scriptTimer);
    scriptTimer = setTimeout(() => write(KEY_SCRIPTS, usePrompter.getState().scripts), 400);
  }
});

/** Show the prompter where the person chose: over the app (default) or popped out in its own window. */
export function showPrompter(display: Settings["display"] = usePrompter.getState().settings.display) {
  const { setSettings } = usePrompter.getState();
  setSettings({ display });
  if (display === "overlay") {
    usePrompter.setState({ overlayOpen: true });
    void window.take.invoke(IPC.prompterClose);
  } else {
    usePrompter.setState({ overlayOpen: false });
    void window.take.invoke(IPC.prompterOpen);
  }
}

export function hidePrompter() {
  usePrompter.setState({ overlayOpen: false });
  void window.take.invoke(IPC.prompterClose);
}

/** Is the script on screen anywhere (overlay or pop-out)? */
export const prompterShown = (s: { windowOpen: boolean; overlayOpen: boolean }) => s.windowOpen || s.overlayOpen;
