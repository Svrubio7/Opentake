// OWNED BY: ux. Settings as the main process sees them (folders, naming, after export), and the
// window's own preferences: first run done, dismissed suggestions, the Record panel's open section.
import { create } from "zustand";
import { IPC } from "@shared/ipc";
import type { AppSettings, FolderChoice, Permissions, SettingsView } from "@shared/types";

const bridge = () => (typeof window !== "undefined" ? window.take : undefined);

export const shellApi = {
  get: () => bridge()!.invoke(IPC.settingsGet) as Promise<SettingsView>,
  set: (p: Partial<AppSettings>) => bridge()!.invoke(IPC.settingsSet, p) as Promise<SettingsView>,
  chooseRecordings: () => bridge()!.invoke(IPC.settingsChooseRecordings) as Promise<FolderChoice>,
  /** "default" or a past folder's index */
  useRecordings: (which: "default" | number) => bridge()!.invoke(IPC.settingsUseRecordings, which) as Promise<FolderChoice>,
  chooseExportDir: () => bridge()!.invoke(IPC.settingsChooseExportDir) as Promise<FolderChoice>,
  /** resolves to an error line, or "" when the folder opened */
  openFolder: (which: "recordings" | "export" | number) => bridge()!.invoke(IPC.settingsOpenFolder, which) as Promise<string>,
  permissions: () => bridge()!.invoke(IPC.permissions) as Promise<Permissions>,
  openPrivacy: (kind: "camera" | "microphone" | "screen" | "accessibility") => bridge()!.invoke(IPC.openPrivacy, kind) as Promise<boolean>,
  rename: (takeId: string, title: string) => bridge()!.invoke(IPC.takeRename, takeId, title) as Promise<string>,
  recover: () => bridge()!.invoke(IPC.takesRecover) as Promise<number>,
};

export type RecordSection = "setup" | "look" | "overlays";
export type TabId = "record" | "takes" | "audio" | "camera" | "prompter" | "settings";

interface Prefs {
  /** the first-run setup was finished or skipped */
  onboarded: boolean;
  /** suggestions dismissed for good */
  dismissed: string[];
  recordSection: RecordSection;
}

const KEY = "take.shell.prefs";
const DEFAULT_PREFS: Prefs = { onboarded: false, dismissed: [], recordSection: "setup" };

function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Prefs> | null;
    if (!p) return DEFAULT_PREFS;
    return {
      onboarded: !!p.onboarded,
      dismissed: Array.isArray(p.dismissed) ? p.dismissed.filter((d) => typeof d === "string") : [],
      recordSection: p.recordSection === "look" || p.recordSection === "overlays" ? p.recordSection : "setup",
    };
  } catch { return DEFAULT_PREFS; }
}

interface ShellState extends Prefs {
  view: SettingsView | null;
  /** one line from the last folder change that failed */
  folderError: string | null;
  setupOpen: boolean;
  shortcutsOpen: boolean;
  set: (p: Partial<ShellState>) => void;
}

export const useShell = create<ShellState>((set) => ({
  ...loadPrefs(),
  view: null,
  folderError: null,
  setupOpen: false,
  shortcutsOpen: false,
  set: (p) => set(p),
}));

useShell.subscribe((s, prev) => {
  if (s.onboarded === prev.onboarded && s.dismissed === prev.dismissed && s.recordSection === prev.recordSection) return;
  try { localStorage.setItem(KEY, JSON.stringify({ onboarded: s.onboarded, dismissed: s.dismissed, recordSection: s.recordSection })); } catch { /* storage off */ }
});

/** Reads the settings and the folders' state again (after a change, or when a tab opens). */
export async function refreshSettings() {
  if (!bridge()) return;
  try { useShell.getState().set({ view: await shellApi.get() }); } catch { /* main not ready */ }
}

/** Applies a folder choice: the new view, or the reason it was refused. */
export function applyChoice(r: FolderChoice) {
  if (r.cancelled) return;
  useShell.getState().set({ folderError: r.ok ? null : r.error ?? "That folder cannot be used.", ...(r.view ? { view: r.view } : {}) });
}

export const dismiss = (id: string) => {
  const s = useShell.getState();
  if (!s.dismissed.includes(id)) s.set({ dismissed: [...s.dismissed, id] });
};

/** Opens a tab in the rail (App listens for this). */
export const goTo = (tab: TabId) => window.dispatchEvent(new CustomEvent("opentake:tab", { detail: tab }));
/** Opens the Record tab on one of its sections. */
export const goToRecord = (section: RecordSection) => { useShell.getState().set({ recordSection: section }); goTo("record"); };

const fmtGb = (b: number) => (b >= 1024 ** 4 ? `${(b / 1024 ** 4).toFixed(1)} TB` : `${(b / 1024 ** 3).toFixed(b < 10 * 1024 ** 3 ? 1 : 0)} GB`);
export const freeLabel = (b: number | null) => (b == null ? "" : `${fmtGb(b)} free`);
