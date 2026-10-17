// OWNED BY: ux. The short first-run setup: what you record, your mic and camera (and the permissions
// they need), and where takes go. Every step can be skipped; Settings opens it again.
import { useEffect, useState, type ReactNode } from "react";
import { Monitor, PictureInPicture2, Video, X } from "lucide-react";
import type { Permissions, PermissionState, RecordMode } from "@shared/types";
import { t, type PlainKey as Key } from "@shared/i18n";
import { Button, Tag } from "../../ui";
import { LanguageSwitch } from "./SettingsPanel";
import { shortPath } from "../../../main/settings-core";
import { selectDevice } from "../audio/actions";
import { useAudioStore } from "../audio/store";
import { CameraPreview } from "../camera";
import { retryCamera } from "../camera/engine";
import { useCamera } from "../camera/store";
import { api, hasBridge } from "../record/api";
import { switchScene } from "../record/recorder";
import { useRecord } from "../record/store";
import { applyChoice, freeLabel, refreshSettings, shellApi, useShell } from "./store";

const modes = (): { value: RecordMode; title: string; text: string; icon: ReactNode }[] => [
  { value: "camera", title: t("fr.mode.camera"), text: t("fr.mode.camera.text"), icon: <Video /> },
  { value: "screen-camera", title: t("fr.mode.screenCamera"), text: t("fr.mode.screenCamera.text"), icon: <PictureInPicture2 /> },
  { value: "screen", title: t("fr.mode.screen"), text: t("fr.mode.screen.text"), icon: <Monitor /> },
];

type Tone = "good" | "warn" | "danger" | "neutral";
const CAM_STATUS: Record<string, { tone: Tone; text: Key }> = {
  live: { tone: "good", text: "fr.cam.live" },
  starting: { tone: "warn", text: "fr.cam.starting" },
  denied: { tone: "danger", text: "fr.cam.denied" },
  nocamera: { tone: "danger", text: "fr.cam.nocamera" },
  busy: { tone: "danger", text: "fr.cam.busy" },
  error: { tone: "danger", text: "fr.cam.error" },
  idle: { tone: "neutral", text: "fr.cam.off" },
  off: { tone: "neutral", text: "fr.cam.off" },
};
const MIC_STATUS: Record<string, { tone: Tone; text: Key }> = {
  running: { tone: "good", text: "fr.mic.running" },
  starting: { tone: "warn", text: "fr.mic.starting" },
  error: { tone: "danger", text: "fr.mic.error" },
  idle: { tone: "neutral", text: "fr.mic.off" },
};

function PermissionRow({ label, state, kind, text }: { label: string; state: PermissionState | boolean; kind: "camera" | "microphone" | "screen" | "accessibility"; text: string }) {
  const ok = state === true || state === "granted";
  return (
    <div className="fr-perm">
      <div className="fr-perm-text"><b>{label}</b><span className="note">{text}</span></div>
      {ok ? <Tag tone="good">{t("fr.allowed")}</Tag> : <Button size="sm" onClick={() => void shellApi.openPrivacy(kind)}>{t("fr.openSystemSettings")}</Button>}
    </div>
  );
}

function StepDevices({ mode, perms }: { mode: RecordMode; perms: Permissions | null }) {
  const micStatus = useAudioStore((s) => s.status);
  const micError = useAudioStore((s) => s.error);
  const micDevices = useAudioStore((s) => s.devices);
  const micId = useAudioStore((s) => s.deviceId);
  const cam = useCamera();
  const camera = mode !== "screen";
  const mic = MIC_STATUS[micStatus] ?? MIC_STATUS.idle;
  const camState = CAM_STATUS[cam.status] ?? CAM_STATUS.idle;
  const mac = perms?.platform === "darwin";
  const win = perms?.platform === "win32";
  return (
    <div className="fr-body">
      <div className="fr-device">
        <div className="row"><span className="row-label">{t("fr.microphone")}</span><Tag tone={mic.tone}>{t(mic.text)}</Tag></div>
        <select className="select" aria-label={t("fr.microphone")} value={micId && micDevices.some((d) => d.id === micId) ? micId : ""} onChange={(e) => selectDevice(e.target.value || null)}>
          <option value="">{t("fr.systemDefault")}</option>
          {micDevices.filter((d) => d.id !== "default" && d.id !== "communications").map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        {micError && <p className="note note-danger">{micError}</p>}
        {win && micStatus === "error" && <Button size="sm" variant="ghost" onClick={() => void shellApi.openPrivacy("microphone")}>{t("fr.openWinMic")}</Button>}
      </div>
      {camera && (
        <div className="fr-device">
          <div className="row"><span className="row-label">{t("fr.camera")}</span><Tag tone={camState.tone}>{t(camState.text)}</Tag></div>
          <select className="select" aria-label={t("fr.camera")} value={cam.deviceId ?? ""} disabled={!cam.devices.length} onChange={(e) => cam.set({ deviceId: e.target.value || null, resolution: null })}>
            <option value="">{cam.devices.length ? t("fr.systemDefault") : t("fr.noCamera")}</option>
            {cam.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
          </select>
          <div className="fr-cam"><CameraPreview /></div>
          {cam.status === "busy" && <p className="note note-warn">{t("fr.camBusy")}</p>}
          {cam.status === "denied" && <p className="note note-warn">{t("fr.camDenied")}</p>}
          {(cam.status === "busy" || cam.status === "error" || cam.status === "nocamera") && <Button size="sm" onClick={retryCamera}>{t("fr.tryAgain")}</Button>}
          {win && cam.status === "denied" && <Button size="sm" variant="ghost" onClick={() => void shellApi.openPrivacy("camera")}>{t("fr.openWinCam")}</Button>}
        </div>
      )}
      {mac && perms && (
        <div className="fr-perms">
          <span className="label">{t("fr.macPerms")}</span>
          {mode !== "camera" && <PermissionRow label={t("fr.perm.screen")} state={perms.screen} kind="screen" text={t("fr.perm.screen.text")} />}
          {mode !== "camera" && <PermissionRow label={t("fr.perm.accessibility")} state={perms.accessibility} kind="accessibility" text={t("fr.perm.accessibility.text")} />}
          {camera && <PermissionRow label={t("fr.camera")} state={perms.camera} kind="camera" text={t("fr.perm.camera.text")} />}
          <PermissionRow label={t("fr.microphone")} state={perms.microphone} kind="microphone" text={t("fr.perm.microphone.text")} />
        </div>
      )}
    </div>
  );
}

function StepFolder() {
  const view = useShell((s) => s.view);
  const folderError = useShell((s) => s.folderError);
  useEffect(() => { void refreshSettings(); }, []);
  if (!view) return null;
  const r = view.recordings;
  return (
    <div className="fr-body">
      <div className="fr-device">
        <span className="row-label">{t("fr.savedIn")}</span>
        <div className="set-folder"><span className="set-path" title={r.path}>{shortPath(r.path, 64)}</span><span className="set-meta tnum">{r.state === "ok" ? freeLabel(r.freeBytes) : <Tag tone="danger">{t("fr.notAvailable")}</Tag>}</span></div>
        {folderError && <p className="note note-danger">{folderError}</p>}
        <div className="wrap"><Button size="sm" onClick={async () => applyChoice(await shellApi.chooseRecordings())}>{t("fr.chooseFolder")}</Button></div>
        <p className="note">{t("fr.folderNote")}</p>
      </div>
    </div>
  );
}

const STEPS = ["mode", "devices", "folder"] as const;

export function FirstRun() {
  const open = useShell((s) => s.setupOpen);
  const onboarded = useShell((s) => s.onboarded);
  const set = useShell((s) => s.set);
  const mode = useRecord((s) => s.mode);
  const busy = useRecord((s) => s.status !== "idle");
  const [step, setStep] = useState(0);
  const [perms, setPerms] = useState<Permissions | null>(null);

  // first launch: open by itself when nothing has been recorded yet (people who already record are not stopped)
  useEffect(() => {
    if (onboarded || !hasBridge()) return;
    void api.takes().then((t) => { if (t.length === 0) set({ setupOpen: true }); else set({ onboarded: true }); }, () => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { setStep(0); void shellApi.permissions().then(setPerms, () => {}); } }, [open]);
  useEffect(() => { if (open && step === 1) void shellApi.permissions().then(setPerms, () => {}); }, [open, step]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); finish(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open || busy) return null;
  const finish = () => set({ setupOpen: false, onboarded: true });
  const done = () => {
    finish();
    // a screen take needs a screen: open the picker straight away
    if (mode !== "camera" && !useRecord.getState().sourceId) window.dispatchEvent(new Event("opentake:pick-screen"));
  };
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) finish(); }}>
      <div className="modal fr" role="dialog" aria-label={t("fr.aria")} aria-modal="true">
        <div className="row">
          <div className="fr-head">
            <span className="fr-step tnum">{t("fr.step", { step: step + 1, total: STEPS.length })}</span>
            <h2 className="modal-title">{t(`fr.title.${STEPS[step]}`)}</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={finish} aria-label={t("shell.close")}><X /></Button>
        </div>
        {step === 0 && (
          <div className="fr-modes" role="radiogroup" aria-label={t("fr.modesAria")}>
            {modes().map((m) => (
              <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} className={mode === m.value ? "fr-mode on" : "fr-mode"} onClick={() => switchScene(m.value)}>
                <span className="fr-mode-icon">{m.icon}</span>
                <b>{m.title}</b>
                <span className="note">{m.text}</span>
              </button>
            ))}
          </div>
        )}
        {step === 0 && <div className="fr-lang"><span className="row-label">{t("fr.language")}</span><LanguageSwitch /></div>}
        {step === 1 && <StepDevices mode={mode} perms={perms} />}
        {step === 2 && <StepFolder />}
        <div className="fr-foot">
          <div className="fr-dots" aria-hidden>{STEPS.map((s, i) => <i key={s} className={i === step ? "on" : ""} />)}</div>
          <Button variant="ghost" onClick={finish}>{t("fr.skip")}</Button>
          {step > 0 && <Button onClick={() => setStep(step - 1)}>{t("fr.back")}</Button>}
          {step < STEPS.length - 1 ? <Button variant="ink" onClick={() => setStep(step + 1)}>{t("fr.next")}</Button> : <Button variant="ink" onClick={done}>{t("fr.start")}</Button>}
        </div>
      </div>
    </div>
  );
}
