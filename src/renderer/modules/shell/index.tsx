// OWNED BY: ux. The shell's window-wide parts: the Settings panel, the first-run setup, the shortcuts
// sheet, and the quiet background work (recovering interrupted takes, telling main what is running
// so closing the window can ask first).
import { useEffect } from "react";
import { IPC } from "@shared/ipc";
import { t } from "@shared/i18n";
import { hasBridge } from "../record/api";
import { refreshTakes, stopForQuit } from "../record/recorder";
import { useRecord } from "../record/store";
import { FirstRun } from "./FirstRun";
import { ShortcutsSheet } from "./Shortcuts";
import { refreshSettings, shellApi } from "./store";

export { SettingsPanel } from "./SettingsPanel";
export { Keys } from "./Shortcuts";
export { useShell, goTo, goToRecord, dismiss, refreshSettings, freeLabel, type TabId, type RecordSection } from "./store";

/** Tells main whether a take records or exports run, and answers its "save and quit". Renders nothing. */
function BusyReporter() {
  const recording = useRecord((s) => s.status !== "idle");
  const exporting = useRecord((s) => Object.values(s.exports).filter((e) => !e.done).length);
  useEffect(() => { if (hasBridge()) window.take.send(IPC.appBusy, { recording, exporting }); }, [recording, exporting]);
  useEffect(() => {
    if (!hasBridge()) return;
    return window.take.on(IPC.appQuitRequest, () => {
      void stopForQuit().finally(() => window.take.send(IPC.appQuitNow));
    });
  }, []);
  return null;
}

/** Once per launch: finish takes the app closed on, and say so. */
function StartupTasks() {
  useEffect(() => {
    if (!hasBridge()) return;
    void refreshSettings();
    void shellApi.recover().then(async (n) => {
      if (!n) return;
      await refreshTakes();
      const s = useRecord.getState();
      if (!s.notice && !s.error) {
        s.set({ notice: t("shell.recovered", { count: n }), noticeAction: "takes" });
      }
    }, () => {});
  }, []);
  return null;
}

export function ShellHost() {
  return (
    <>
      <BusyReporter />
      <StartupTasks />
      <FirstRun />
      <ShortcutsSheet />
    </>
  );
}
