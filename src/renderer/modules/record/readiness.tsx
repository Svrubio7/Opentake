// The top of the Record panel: whether everything a take needs is there (screen, mic, camera, the
// recordings folder), each missing piece with the one action that fixes it, and a couple of gentle
// suggestions (shell/suggestions-core.ts).
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button, Card, Tag } from "../../ui";
import { shortPath } from "../../../main/settings-core";
import { useAudioStore } from "../audio/store";
import { retryCamera } from "../camera/engine";
import { useCamera } from "../camera/store";
import { applyChoice, dismiss, goTo, goToRecord, refreshSettings, shellApi, useShell } from "../shell/store";
import { looksLikeHeadphones, setupSuggestions, type SuggestionAction } from "../shell/suggestions-core";
import { needsCamera, needsScreen } from "./layout-core";
import { useRecord } from "./store";
import { systemAudioKey, systemAudioWanted } from "./system-audio-core";

type Tone = "good" | "warn" | "danger" | "neutral";
interface Row { label: string; tone: Tone; status: string; title?: string; action?: { label: string; run: () => void } }

export const pickScreen = () => window.dispatchEvent(new Event("opentake:pick-screen"));

function useRows(): Row[] {
  const mode = useRecord((s) => s.mode);
  const sourceName = useRecord((s) => s.sourceName);
  const sourceId = useRecord((s) => s.sourceId);
  const busy = useRecord((s) => s.status !== "idle");
  const mic = useAudioStore((s) => s.status);
  const micLabel = useAudioStore((s) => s.activeLabel);
  const cam = useCamera((s) => s.status);
  const view = useShell((s) => s.view);
  const rows: Row[] = [];
  if (needsScreen(mode)) {
    rows.push(sourceId
      ? { label: "Screen", tone: "good", status: sourceName ?? "Chosen", title: sourceName ?? undefined, action: busy ? undefined : { label: "Change", run: pickScreen } }
      : { label: "Screen", tone: "warn", status: "Not chosen yet", action: { label: "Choose", run: pickScreen } });
  }
  const micRow: Row = mic === "running" ? { label: "Mic", tone: "good", status: micLabel ? micLabel.replace(/^Default - /, "") : "Working", title: micLabel }
    : mic === "error" ? { label: "Mic", tone: "danger", status: "Not working", action: { label: "Fix", run: () => goTo("audio") } }
      : { label: "Mic", tone: "warn", status: "Starting" };
  rows.push(micRow);
  if (needsCamera(mode)) {
    const camRow: Row = cam === "live" ? { label: "Camera", tone: "good", status: "Working" }
      : cam === "busy" ? { label: "Camera", tone: "danger", status: "In use by another app", title: "Close the other app (a call, another recorder), then try again", action: { label: "Try again", run: retryCamera } }
        : cam === "denied" ? { label: "Camera", tone: "danger", status: "Blocked by the system", action: { label: "Fix", run: () => goTo("camera") } }
          : cam === "nocamera" ? { label: "Camera", tone: "danger", status: "No camera found", action: { label: "Try again", run: retryCamera } }
            : cam === "error" ? { label: "Camera", tone: "danger", status: "Not working", action: { label: "Fix", run: () => goTo("camera") } }
              : { label: "Camera", tone: "warn", status: "Starting" };
    rows.push(camRow);
  }
  if (view) {
    const r = view.recordings;
    rows.push(r.state === "ok"
      ? { label: "Saves to", tone: "good", status: shortPath(r.path, 30), title: r.path, action: { label: "Change", run: () => goTo("settings") } }
      : { label: "Saves to", tone: "danger", status: r.state === "missing" ? "Folder not available" : "Cannot write there", title: r.path, action: { label: "Choose", run: async () => applyChoice(await shellApi.chooseRecordings()) } });
  }
  return rows;
}

/** How many things stop a take right now (shown on the Setup section from the other sections). */
export function useProblems(): number {
  return useRows().filter((r) => r.tone === "danger").length;
}

export function ReadinessCard() {
  const rows = useRows();
  const ready = rows.every((r) => r.tone === "good");
  const problems = rows.filter((r) => r.tone === "danger").length;
  return (
    <Card title="Before you record" action={<Tag tone={ready ? "good" : problems ? "danger" : "warn"}>{ready ? "Ready" : problems ? "Needs a fix" : "Almost ready"}</Tag>}>
      <div className="rd-rows">
        {rows.map((r) => (
          <div key={r.label} className="rd-row">
            <span className="rd-label">{r.label}</span>
            <span className={`rd-status ${r.tone}`} title={r.title}><i className="rd-dot" /><span>{r.status}</span></span>
            {r.action ? <Button size="sm" variant={r.tone === "good" ? "ghost" : "outline"} onClick={r.action.run}>{r.action.label}</Button> : <span />}
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Whether the computer's sound plays through headphones (from the default output's name). */
function useHeadphones(): boolean | null {
  const [hp, setHp] = useState<boolean | null>(null);
  useEffect(() => {
    const read = () => navigator.mediaDevices?.enumerateDevices().then((d) => {
      const out = d.find((x) => x.kind === "audiooutput" && x.deviceId === "default") ?? d.find((x) => x.kind === "audiooutput");
      setHp(looksLikeHeadphones(out?.label));
    }, () => {});
    void read();
    navigator.mediaDevices?.addEventListener?.("devicechange", read);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", read);
  }, []);
  return hp;
}

export function Suggestions() {
  const s = useRecord();
  const light = useCamera((c) => (c.status === "live" ? c.report?.level ?? null : null));
  const freeBytes = useShell((v) => v.view?.recordings.freeBytes ?? null);
  const dismissed = useShell((v) => v.dismissed);
  const headphones = useHeadphones();
  const list = setupSuggestions({
    mode: s.mode, backgroundId: s.backgroundId, cameraLight: light, systemSound: systemAudioWanted(s.mode, s), headphones, freeBytes, busy: s.status !== "idle",
  }, new Set(dismissed));
  if (!list.length) return null;
  const act = (a: SuggestionAction) => {
    if (a === "look") goToRecord("look");
    else if (a === "camera") goTo("camera");
    else if (a === "settings") { void refreshSettings(); goTo("settings"); }
    else if (a === "system-sound-off") s.set({ [systemAudioKey(s.mode)]: false });
  };
  return (
    <div className="tips" aria-label="Suggestions">
      {list.map((t) => (
        <div key={t.id} className="tip">
          <span>{t.text}</span>
          <div className="tip-actions">
            {t.action && <Button size="sm" onClick={() => act(t.action!.does)}>{t.action.label}</Button>}
            <Button size="icon-sm" variant="ghost" onClick={() => dismiss(t.id)} title="Do not suggest this again" aria-label="Dismiss"><X /></Button>
          </div>
        </div>
      ))}
    </div>
  );
}
