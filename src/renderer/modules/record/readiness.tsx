// The top of the Record panel: whether everything a take needs is there (screen, mic, camera, the
// recordings folder), each missing piece with the one action that fixes it, and a couple of gentle
// suggestions (shell/suggestions-core.ts).
import { useEffect, useRef, useState } from "react";
import { HardDrive, ListChecks, Mic, Monitor, Video, X, type LucideIcon } from "lucide-react";
import { Button, Card, Tag } from "../../ui";
import { shortPath } from "../../../main/settings-core";
import { getEngine } from "../audio/engine";
import { useAudioStore } from "../audio/store";
import { retryCamera } from "../camera/engine";
import { useCamera } from "../camera/store";
import { applyChoice, dismiss, freeLabel, goTo, goToRecord, refreshSettings, shellApi, useShell } from "../shell/store";
import { TIGHT_DISK_BYTES, looksLikeHeadphones, setupSuggestions, type SuggestionAction } from "../shell/suggestions-core";
import { needsCamera, needsScreen } from "./layout-core";
import { useRecord } from "./store";
import { systemAudioKey, systemAudioWanted } from "./system-audio-core";

type Tone = "good" | "warn" | "danger" | "neutral";
interface Row {
  key: "screen" | "mic" | "camera" | "disk";
  label: string;
  icon: LucideIcon;
  tone: Tone;
  /** the main line: the device, the screen, the free space */
  value: string;
  /** a second line, or the state when the value is a name */
  sub?: string;
  title?: string;
  /** used share of the drive, 0..1 */
  used?: number;
  action?: { label: string; run: () => void };
}

export const pickScreen = () => window.dispatchEvent(new Event("opentake:pick-screen"));

const STATE_WORD: Record<Tone, string> = { good: "Ready", warn: "Waiting", danger: "Needs a fix", neutral: "Off" };

function useRows(): Row[] {
  const mode = useRecord((s) => s.mode);
  const sourceName = useRecord((s) => s.sourceName);
  const sourceId = useRecord((s) => s.sourceId);
  const busy = useRecord((s) => s.status !== "idle");
  const mic = useAudioStore((s) => s.status);
  const micLabel = useAudioStore((s) => s.activeLabel);
  const cam = useCamera((s) => s.status);
  const camLabel = useCamera((s) => (s.devices.find((d) => d.deviceId === s.deviceId) ?? s.devices[0])?.label ?? "");
  const camSize = useCamera((s) => s.actual);
  const view = useShell((s) => s.view);
  const rows: Row[] = [];
  if (needsScreen(mode)) {
    rows.push(sourceId
      ? { key: "screen", label: "Screen", icon: Monitor, tone: "good", value: sourceName ?? "Chosen", sub: "Captured", title: sourceName ?? undefined, action: busy ? undefined : { label: "Change", run: pickScreen } }
      : { key: "screen", label: "Screen", icon: Monitor, tone: "warn", value: "Not chosen yet", sub: "Pick a screen or a window", action: { label: "Choose", run: pickScreen } });
  }
  const micName = micLabel.replace(/^(Default|Predeterminado) - /, "");
  rows.push(mic === "running" ? { key: "mic", label: "Mic", icon: Mic, tone: "good", value: micName || "Microphone", title: micLabel }
    : mic === "error" ? { key: "mic", label: "Mic", icon: Mic, tone: "danger", value: "Not working", sub: "Check the Mic tab", action: { label: "Fix", run: () => goTo("audio") } }
      : { key: "mic", label: "Mic", icon: Mic, tone: "warn", value: "Starting", sub: "Opening the microphone" });
  if (needsCamera(mode)) {
    const c = { key: "camera" as const, label: "Camera", icon: Video };
    rows.push(cam === "live" ? { ...c, tone: "good", value: camLabel.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "") || "Camera", sub: camSize ? `${camSize.h}p, ${camSize.fps} fps` : "Working", title: camLabel }
      : cam === "busy" ? { ...c, tone: "danger", value: "In use by another app", sub: "Close the call or recorder using it", action: { label: "Try again", run: retryCamera } }
        : cam === "denied" ? { ...c, tone: "danger", value: "Blocked", sub: "Allow it in privacy settings", action: { label: "Fix", run: () => goTo("camera") } }
          : cam === "nocamera" ? { ...c, tone: "danger", value: "No camera found", sub: "Plug one in, then try again", action: { label: "Try again", run: retryCamera } }
            : cam === "error" ? { ...c, tone: "danger", value: "Not working", action: { label: "Fix", run: () => goTo("camera") } }
              : { ...c, tone: "warn", value: "Starting", sub: "Opening the camera" });
  }
  if (view) {
    const r = view.recordings;
    const d = { key: "disk" as const, label: "Disk", icon: HardDrive, title: r.path };
    rows.push(r.state === "ok"
      ? { ...d, tone: r.freeBytes != null && r.freeBytes < TIGHT_DISK_BYTES ? "warn" : "good", value: r.freeBytes != null ? freeLabel(r.freeBytes) : "Ready", sub: shortPath(r.path, 34),
        used: r.freeBytes != null && r.totalBytes ? 1 - r.freeBytes / r.totalBytes : undefined, action: { label: "Change", run: () => goTo("settings") } }
      : { ...d, tone: "danger", value: r.state === "missing" ? "Folder not available" : "Cannot write there", sub: shortPath(r.path, 34), action: { label: "Choose", run: async () => applyChoice(await shellApi.chooseRecordings()) } });
  }
  return rows;
}

/** How many things stop a take right now (shown on the Setup section from the other sections). */
export function useProblems(): number {
  return useRows().filter((r) => r.tone === "danger").length;
}

/** The processed voice's level, drawn straight from the engine (no React render per frame). */
function MicLevel() {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => getEngine().onOutput((m) => {
    if (bar.current) bar.current.style.transform = `scaleX(${Math.max(0, Math.min(1, (m.rmsDb + 60) / 60))})`;
  }), []);
  return <span className="st-level" aria-hidden><span ref={bar} /></span>;
}

function StatusTile({ r }: { r: Row }) {
  const Icon = r.icon;
  return (
    <div className={`st-tile ${r.tone}`} title={r.title}>
      <div className="st-head">
        <span className="st-mark" aria-hidden><Icon /></span>
        <span className="eyebrow">{r.label}</span>
        <span className={`st-state ${r.tone}`} title={STATE_WORD[r.tone]} aria-label={STATE_WORD[r.tone]}><i /></span>
      </div>
      <b className="st-value">{r.value}</b>
      {r.key === "mic" && r.tone === "good" ? <MicLevel />
        : r.used != null ? <span className="st-bar" aria-label={`${Math.round(r.used * 100)}% of the drive used`}><span style={{ width: `${Math.round(r.used * 100)}%` }} /></span> : null}
      <div className="st-foot">
        {r.sub && <span className="st-sub">{r.sub}</span>}
        {r.action && <Button size="sm" variant={r.tone === "good" ? "ghost" : "outline"} className="st-act" onClick={r.action.run}>{r.action.label}</Button>}
      </div>
    </div>
  );
}

export function ReadinessCard() {
  const rows = useRows();
  const ready = rows.every((r) => r.tone === "good");
  const problems = rows.filter((r) => r.tone === "danger").length;
  return (
    <Card title="Before you record" icon={ListChecks} action={<Tag tone={ready ? "good" : problems ? "danger" : "warn"}>{ready ? "Ready" : problems ? "Needs a fix" : "Almost ready"}</Tag>}>
      <div className="st-grid">{rows.map((r) => <StatusTile key={r.key} r={r} />)}</div>
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
