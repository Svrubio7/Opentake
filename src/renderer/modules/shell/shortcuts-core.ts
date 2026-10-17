// Every keyboard shortcut in OpenTake, for the shortcuts sheet (tested in shortcuts-core.test.ts).
// Keys are written with "Mod" for Ctrl (Cmd on a Mac) so one list serves both.

export interface Shortcut { keys: string[]; does: string }
export interface ShortcutGroup { title: string; note?: string; items: Shortcut[] }

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: "From any app",
    note: "These work while OpenTake is open, even when another app is in front.",
    items: [
      { keys: ["Mod", "Shift", "R"], does: "Start or stop recording" },
      { keys: ["Mod", "Shift", "P"], does: "Pause or resume" },
      { keys: ["Mod", "Shift", "1"], does: "Scene: camera only" },
      { keys: ["Mod", "Shift", "2"], does: "Scene: screen and camera" },
      { keys: ["Mod", "Shift", "3"], does: "Scene: screen only" },
      { keys: ["Mod", "Shift", "L"], does: "Show or hide the name card" },
      { keys: ["Mod", "Shift", "D"], does: "Draw on the screen, on or off" },
    ],
  },
  {
    title: "Teleprompter",
    note: "From any app while the prompter shows. Inside the prompter the same keys work without Ctrl and Alt.",
    items: [
      { keys: ["Mod", "Alt", "Space"], does: "Play or pause" },
      { keys: ["Mod", "Alt", "Up"], does: "Faster" },
      { keys: ["Mod", "Alt", "Down"], does: "Slower" },
      { keys: ["Mod", "Alt", "Right"], does: "Next sentence" },
      { keys: ["Mod", "Alt", "Left"], does: "Previous sentence" },
      { keys: ["Mod", "Alt", "Home"], does: "Back to the start" },
      { keys: ["Mod", "Alt", "T"], does: "Click-through on or off" },
    ],
  },
  {
    title: "While drawing",
    items: [
      { keys: ["Esc"], does: "Stop drawing" },
      { keys: ["Mod", "Z"], does: "Undo the last stroke" },
      { keys: ["C"], does: "Clear everything" },
      { keys: ["P"], does: "Pen" },
      { keys: ["H"], does: "Highlighter" },
      { keys: ["A"], does: "Arrow" },
      { keys: ["R"], does: "Rectangle" },
      { keys: ["Right click"], does: "Rub out one stroke" },
    ],
  },
  {
    title: "Take editor",
    items: [
      { keys: ["Space"], does: "Play or pause" },
      { keys: ["J"], does: "Back" },
      { keys: ["K"], does: "Pause" },
      { keys: ["L"], does: "Play" },
      { keys: ["Left"], does: "One frame back (Shift: one second)" },
      { keys: ["Right"], does: "One frame forward (Shift: one second)" },
      { keys: ["I"], does: "Set the in point" },
      { keys: ["O"], does: "Set the out point" },
      { keys: ["S"], does: "Split at the playhead" },
      { keys: ["Delete"], does: "Remove a part, or restore a cut" },
      { keys: ["Mod", "Z"], does: "Undo" },
      { keys: ["Mod", "Shift", "Z"], does: "Redo" },
      { keys: ["Mod", "Wheel"], does: "Zoom the timeline" },
    ],
  },
  {
    title: "In this window",
    items: [
      { keys: ["?"], does: "Show these shortcuts" },
      { keys: ["Esc"], does: "Close a dialog" },
    ],
  },
];

/** The keys as they read on this computer: Ctrl on Windows and Linux, Cmd on a Mac (Alt reads Option). */
export function keyLabel(key: string, mac: boolean): string {
  if (key === "Mod") return mac ? "Cmd" : "Ctrl";
  if (key === "Alt" && mac) return "Option";
  return key;
}

/** The shortcut in one line ("Ctrl+Shift+R"), for hover hints. */
export const shortcutText = (keys: string[], mac: boolean) => keys.map((k) => keyLabel(k, mac)).join("+");

/** "?" opens the sheet unless someone is typing (a text box, a script, a select). */
export function opensSheet(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }, target: { tagName?: string; isContentEditable?: boolean } | null): boolean {
  if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return false;
  const tag = (target?.tagName ?? "").toUpperCase();
  return !(tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable);
}
