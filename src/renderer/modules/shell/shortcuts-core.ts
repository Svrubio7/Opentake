// Every keyboard shortcut in OpenTake, for the shortcuts sheet (tested in shortcuts-core.test.ts).
// Keys are written with "Mod" for Ctrl (Cmd on a Mac) so one list serves both.
import { t, type PlainKey as Key } from "../../../shared/i18n";

export interface Shortcut { keys: string[]; does: string }
export interface ShortcutGroup { title: string; note?: string; items: Shortcut[] }

const group = (title: Key, note: Key | null, items: [string[], Key][]): ShortcutGroup => ({
  title: t(title), ...(note ? { note: t(note) } : {}), items: items.map(([keys, does]) => ({ keys, does: t(does) })),
});

/** The groups in the current language (read at render: the language can change while the app runs). */
export const shortcutGroups = (): ShortcutGroup[] => [
  group("sc.global", "sc.global.note", [
    [["Mod", "Shift", "R"], "sc.toggle"],
    [["Mod", "Shift", "P"], "sc.pause"],
    [["Mod", "Shift", "1"], "sc.sceneCamera"],
    [["Mod", "Shift", "2"], "sc.sceneScreenCamera"],
    [["Mod", "Shift", "3"], "sc.sceneScreen"],
    [["Mod", "Shift", "L"], "sc.nameCard"],
    [["Mod", "Shift", "D"], "sc.draw"],
  ]),
  group("sc.prompter", "sc.prompter.note", [
    [["Mod", "Alt", "Space"], "sc.playPause"],
    [["Mod", "Alt", "Up"], "sc.faster"],
    [["Mod", "Alt", "Down"], "sc.slower"],
    [["Mod", "Alt", "Right"], "sc.nextSentence"],
    [["Mod", "Alt", "Left"], "sc.prevSentence"],
    [["Mod", "Alt", "Home"], "sc.toStart"],
    [["Mod", "Alt", "T"], "sc.clickThrough"],
  ]),
  group("sc.drawing", null, [
    [["Esc"], "sc.stopDrawing"],
    [["Mod", "Z"], "sc.undoStroke"],
    [["C"], "sc.clear"],
    [["P"], "sc.pen"],
    [["H"], "sc.highlighter"],
    [["A"], "sc.arrow"],
    [["R"], "sc.rect"],
    [["Right click"], "sc.rubOut"],
  ]),
  group("sc.editor", null, [
    [["Space"], "sc.playPause"],
    [["J"], "sc.back"],
    [["K"], "sc.pauseOnly"],
    [["L"], "sc.play"],
    [["Left"], "sc.frameBack"],
    [["Right"], "sc.frameForward"],
    [["I"], "sc.in"],
    [["O"], "sc.out"],
    [["S"], "sc.split"],
    [["Delete"], "sc.remove"],
    [["Mod", "Z"], "sc.undo"],
    [["Mod", "Shift", "Z"], "sc.redo"],
    [["Mod", "Wheel"], "sc.zoom"],
  ]),
  group("sc.window", null, [
    [["?"], "sc.show"],
    [["Esc"], "sc.closeDialog"],
  ]),
];

// the keys with a printed name of their own in Spanish (Mayús, Espacio, Supr...)
const NAMED: Record<string, Key> = {
  Shift: "key.Shift", Space: "key.Space", Delete: "key.Delete", Home: "key.Home", Up: "key.Up", Down: "key.Down",
  Left: "key.Left", Right: "key.Right", "Right click": "key.RightClick", Wheel: "key.Wheel",
};

/** The keys as they read on this computer: Ctrl on Windows and Linux, Cmd on a Mac (Alt reads Option). */
export function keyLabel(key: string, mac: boolean): string {
  if (key === "Mod") return mac ? "Cmd" : "Ctrl";
  if (key === "Alt" && mac) return t("key.Option");
  return NAMED[key] ? t(NAMED[key]) : key;
}

/** The shortcut in one line ("Ctrl+Shift+R"), for hover hints. */
export const shortcutText = (keys: string[], mac: boolean) => keys.map((k) => keyLabel(k, mac)).join("+");

/** "?" opens the sheet unless someone is typing (a text box, a script, a select). */
export function opensSheet(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return false;
  const tag = (target?.tagName ?? "").toUpperCase();
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable);
}
