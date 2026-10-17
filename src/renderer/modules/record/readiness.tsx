// The top of the Record panel: whether everything a take needs is there (screen, mic, camera, the
// recordings folder), each missing piece with the one action that fixes it, and a couple of gentle
// suggestions (shell/suggestions-core.ts).
import { useEffect, useRef, useState } from "react";
import { HardDrive, ListChecks, Mic, Monitor, Video, X, type LucideIcon } from "lucide-react";
import { t } from "@shared/i18n";
import { Button, Card, Tag } from "../../ui";
import { shortPath } from "../../../main/settings-core";
import { useStream } from "@core/useStream";
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

const stateWord = (tone: Tone) => (tone === "good" ? t("record.ready.ready") : tone === "warn" ? t("record.ready.waiting") : tone === "danger" ? t("record.needsFix") : t("record.ready.off"));

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
      ? { key: "screen", label: t("record.ready.screen"), icon: Monitor, tone: "good", value: sourceName ?? t("record.ready.chosen"), sub: t("record.ready.captured"), title: sourceName ?? undefined, action: busy ? undefined : { label: t("record.ready.change"), run: pickScreen } }
      : { key: "screen", label: t("record.ready.screen"), icon: Monitor, tone: "warn", value: t("record.ready.notChosen"), sub: t("record.ready.pickScreen"), action: { label: t("record.ready.choose"), run: pickScreen } });
  }
  const micName = micLabel.replace(/^(Default|Predeterminado) - /, "");
  rows.push(mic === "running" ? { key: "mic", label: t("record.ready.mic"), icon: Mic, tone: "good", value: micName || t("record.ready.microphone"), title: micLabel, action: { label: t("record.ready.openMic"), run: () => goTo("audio") } }
    : mic === "error" ? { key: "mic", label: t("record.ready.mic"), icon: Mic, tone: "danger", value: t("record.ready.notWorking"), sub: t("record.ready.checkMic"), action: { label: t("record.ready.fix"), run: () => goTo("audio") } }
      : { key: "mic", label: t("record.ready.mic"), icon: Mic, tone: "warn", value: t("record.ready.starting"), sub: t("record.ready.openingMic") });
  if (needsCamera(mode)) {
    const c = { key: "camera" as const, label: t("record.ready.camera"), icon: Video };
    rows.push(cam === "live" ? { ...c, tone: "good", value: camLabel.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, "") || t("record.ready.camera"), sub: camSize ? `${camSize.h}p` : t("record.ready.working"), title: camLabel, action: { label: t("record.ready.openCamera"), run: () => goTo("camera") } }
      : cam === "busy" ? { ...c, tone: "danger", value: t("record.ready.camBusy"), sub: t("record.ready.camBusySub"), action: { label: t("record.ready.tryAgain"), run: retryCamera } }
        : cam === "denied" ? { ...c, tone: "danger", value: t("record.ready.blocked"), sub: t("record.ready.blockedSub"), action: { label: t("record.ready.fix"), run: () => goTo("camera") } }
          : cam === "nocamera" ? { ...c, tone: "danger", value: t("record.ready.noCamera"), sub: t("record.ready.noCameraSub"), action: { label: t("record.ready.tryAgain"), run: retryCamera } }
            : cam === "error" ? { ...c, tone: "danger", value: t("record.ready.notWorking"), action: { label: t("record.ready.fix"), run: () => goTo("camera") } }
              : { ...c, tone: "warn", value: t("record.ready.starting"), sub: t("record.ready.openingCamera") });
  }
  if (view) {
    const r = view.recordings;
    const d = { key: "disk" as const, label: t("record.ready.disk"), icon: HardDrive, title: r.path };
    rows.push(r.state === "ok"
      ? { ...d, tone: r.freeBytes != null && r.freeBytes < TIGHT_DISK_BYTES ? "warn" : "good", value: r.freeBytes != null ? freeLabel(r.freeBytes) : t("record.ready.ready"), sub: shortPath(r.path, 34),
        used: r.freeBytes != null && r.totalBytes ? 1 - r.freeBytes / r.totalBytes : undefined, action: { label: t("record.ready.change"), run: () => goTo("settings") } }
      : { ...d, tone: "danger", value: r.state === "missing" ? t("record.ready.folderMissing") : t("record.ready.cannotWrite"), sub: shortPath(r.path, 34), action: { label: t("record.ready.choose"), run: async () => applyChoice(await shellApi.chooseRecordings()) } });
  }
  return rows;
}

/** How many things stop a take right now (shown on the Setup section from the other sections). */
export function useProblems(): number {
  return useRows().filter((r) => r.tone === "danger").length;
}

/** The processed voice's level, drawn straight from the engine (no React render per frame). */
/** The mic input over the last few seconds as a row of bars, drawn on a canvas (no React render per frame). */
function MicLevel() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const levels: number[] = new Array(28).fill(0);
    let last = 0;
    return getEngine().onInput((m) => {
      const c = ref.current;
      if (!c) return;
      const now = performance.now();
      if (now - last < 70) return; // about 14 bars a second
      last = now;
      levels.shift();
      levels.push(Math.max(0, Math.min(1, (m.rmsDb + 60) / 54)));
      const dpr = window.devicePixelRatio || 1;
      const W = c.clientWidth, H = c.clientHeight;
      if (c.width !== Math.round(W * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const g = c.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const css = getComputedStyle(c);
      const on = css.getPropertyValue("--brand").trim() || "#006f4f";
      const off = css.getPropertyValue("--switch-off").trim() || "#dcdce3";
      const step = W / levels.length, bw = Math.max(2, step - 3);
      levels.forEach((v, i) => {
        const h = Math.max(3, v * (H - 2));
        g.fillStyle = v > 0.04 ? on : off;
        g.beginPath();
        g.roundRect(i * step + (step - bw) / 2, (H - h) / 2, bw, h, bw / 2);
        g.fill();
      });
    });
  }, []);
  return <canvas ref={ref} className="st-media st-wave" aria-hidden />;
}

/** A tiny live picture of a stream (the chosen screen, the camera), muted and never focusable. */
function LiveThumb({ kind }: { kind: "screen" | "camera" }) {
  const stream = useStream(kind);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) void v.play().catch(() => {});
  }, [stream]);
  return <span className="st-media" aria-hidden>{stream ? <video ref={ref} muted playsInline /> : null}</span>;
}

function StatusTile({ r }: { r: Row }) {
  const Icon = r.icon;
  const run = r.action?.run;
  // every good tile shows something live or measured in the same strip, so the row lines up
  const media = r.tone !== "good" ? null : r.key === "screen" || r.key === "camera" ? <LiveThumb kind={r.key} /> : r.key === "mic" ? <MicLevel /> : null;
  return (
    <button type="button" className={`st-tile ${r.tone}`} title={r.title ? `${r.title}${r.action ? ` (${r.action.label})` : ""}` : r.action?.label} onClick={run} disabled={!run}>
      <span className="st-head">
        <span className="st-mark" aria-hidden><Icon /></span>
        <span className="eyebrow">{r.label}</span>
        <span className={`st-state ${r.tone}`} aria-label={stateWord(r.tone)}><i /></span>
      </span>
      {media}
      <span className="st-text">
        <b className="st-value">{r.value}</b>
        {r.sub && <span className="st-sub">{r.sub}</span>}
      </span>
      {r.used != null && <span className="st-bar"><span style={{ width: `${Math.round(r.used * 100)}%` }} /></span>}
      {r.action && r.tone !== "good" && <span className="st-fix">{r.action.label}</span>}
    </button>
  );
}

export function ReadinessCard() {
  const rows = useRows();
  const ready = rows.every((r) => r.tone === "good");
  const problems = rows.filter((r) => r.tone === "danger").length;
  return (
    <Card title={t("record.ready.title")} icon={ListChecks} action={<Tag tone={ready ? "good" : problems ? "danger" : "warn"}>{ready ? t("record.ready.ready") : problems ? t("record.needsFix") : t("record.ready.almost")}</Tag>}>
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
    <div className="tips" aria-label={t("record.suggestions")}>
      {list.map((tip) => (
        <div key={tip.id} className="tip">
          <span>{tip.text}</span>
          <div className="tip-actions">
            {tip.action && <Button size="sm" onClick={() => act(tip.action!.does)}>{tip.action.label}</Button>}
            <Button size="icon-sm" variant="ghost" onClick={() => dismiss(tip.id)} title={t("record.dontSuggest")} aria-label={t("record.dismiss")}><X /></Button>
          </div>
        </div>
      ))}
    </div>
  );
}
