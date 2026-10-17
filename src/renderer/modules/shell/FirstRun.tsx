// OWNED BY: ux. The short first-run setup: what you record, your mic and camera (and the permissions
// they need), and where takes go. Every step can be skipped; Settings opens it again.
import { useEffect, useState, type ReactNode } from "react";
import { Monitor, PictureInPicture2, Video, X } from "lucide-react";
import type { Permissions, PermissionState, RecordMode } from "@shared/types";
import { Button, Tag } from "../../ui";
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

const MODES: { value: RecordMode; title: string; text: string; icon: ReactNode }[] = [
  { value: "camera", title: "Me on camera", text: "Talking to the camera: videos, updates, lessons", icon: <Video /> },
  { value: "screen-camera", title: "My screen and me", text: "Demos and tutorials with your face in a corner", icon: <PictureInPicture2 /> },
  { value: "screen", title: "Only my screen", text: "Walkthroughs and bug reports, with your voice", icon: <Monitor /> },
];

const CAM_STATUS: Record<string, { tone: "good" | "warn" | "danger" | "neutral"; text: string }> = {
  live: { tone: "good", text: "Working" },
  starting: { tone: "warn", text: "Starting" },
  denied: { tone: "danger", text: "Blocked" },
  nocamera: { tone: "danger", text: "No camera found" },
  busy: { tone: "danger", text: "In use by another app" },
  error: { tone: "danger", text: "Not working" },
  idle: { tone: "neutral", text: "Off" },
  off: { tone: "neutral", text: "Off" },
};
const MIC_STATUS: Record<string, { tone: "good" | "warn" | "danger" | "neutral"; text: string }> = {
  running: { tone: "good", text: "Working" },
  starting: { tone: "warn", text: "Starting" },
  error: { tone: "danger", text: "Not working" },
  idle: { tone: "neutral", text: "Off" },
};

function PermissionRow({ label, state, kind, text }: { label: string; state: PermissionState | boolean; kind: "camera" | "microphone" | "screen" | "accessibility"; text: string }) {
  const ok = state === true || state === "granted";
  return (
    <div className="fr-perm">
      <div className="fr-perm-text"><b>{label}</b><span className="note">{text}</span></div>
      {ok ? <Tag tone="good">Allowed</Tag> : <Button size="sm" onClick={() => void shellApi.openPrivacy(kind)}>Open System Settings</Button>}
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
        <div className="row"><span className="row-label">Microphone</span><Tag tone={mic.tone}>{mic.text}</Tag></div>
        <select className="select" aria-label="Microphone" value={micId && micDevices.some((d) => d.id === micId) ? micId : ""} onChange={(e) => selectDevice(e.target.value || null)}>
          <option value="">System default</option>
          {micDevices.filter((d) => d.id !== "default" && d.id !== "communications").map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        {micError && <p className="note note-danger">{micError}</p>}
        {win && micStatus === "error" && <Button size="sm" variant="ghost" onClick={() => void shellApi.openPrivacy("microphone")}>Open Windows microphone settings</Button>}
      </div>
      {camera && (
        <div className="fr-device">
          <div className="row"><span className="row-label">Camera</span><Tag tone={camState.tone}>{camState.text}</Tag></div>
          <select className="select" aria-label="Camera" value={cam.deviceId ?? ""} disabled={!cam.devices.length} onChange={(e) => cam.set({ deviceId: e.target.value || null, resolution: null })}>
            <option value="">{cam.devices.length ? "System default" : "No camera found"}</option>
            {cam.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
          </select>
          <div className="fr-cam"><CameraPreview /></div>
          {cam.status === "busy" && <p className="note note-warn">Another app is using the camera. Close it (a video call, another recorder), then try again.</p>}
          {cam.status === "denied" && <p className="note note-warn">The camera is blocked for OpenTake in your system's privacy settings.</p>}
          {(cam.status === "busy" || cam.status === "error" || cam.status === "nocamera") && <Button size="sm" onClick={retryCamera}>Try again</Button>}
          {win && cam.status === "denied" && <Button size="sm" variant="ghost" onClick={() => void shellApi.openPrivacy("camera")}>Open Windows camera settings</Button>}
        </div>
      )}
      {mac && perms && (
        <div className="fr-perms">
          <span className="label">macOS permissions</span>
          {mode !== "camera" && <PermissionRow label="Screen Recording" state={perms.screen} kind="screen" text="Needed to record your screen. macOS asks for a restart of the app after." />}
          {mode !== "camera" && <PermissionRow label="Accessibility" state={perms.accessibility} kind="accessibility" text="For zoom on clicks and the keys overlay. Recording works without it." />}
          {camera && <PermissionRow label="Camera" state={perms.camera} kind="camera" text="To show you on camera." />}
          <PermissionRow label="Microphone" state={perms.microphone} kind="microphone" text="To record your voice." />
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
        <span className="row-label">Takes are saved in</span>
        <div className="set-folder"><span className="set-path" title={r.path}>{shortPath(r.path, 64)}</span><span className="set-meta tnum">{r.state === "ok" ? freeLabel(r.freeBytes) : <Tag tone="danger">Not available</Tag>}</span></div>
        {folderError && <p className="note note-danger">{folderError}</p>}
        <div className="wrap"><Button size="sm" onClick={async () => applyChoice(await shellApi.chooseRecordings())}>Choose another folder</Button></div>
        <p className="note">Exports go next to each take unless you pick a folder in Settings. Long takes with separate tracks can take several gigabytes, so a roomy drive helps.</p>
      </div>
    </div>
  );
}

const STEPS = ["What you record", "Mic and camera", "Where takes go"];

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
      <div className="modal fr" role="dialog" aria-label="Set up OpenTake" aria-modal="true">
        <div className="row">
          <div className="fr-head">
            <span className="fr-step tnum">Step {step + 1} of {STEPS.length}</span>
            <h2 className="modal-title">{step === 0 ? "What will you record?" : step === 1 ? "Check your mic and camera" : "Where should takes go?"}</h2>
          </div>
          <Button variant="ghost" size="icon" onClick={finish} aria-label="Close"><X /></Button>
        </div>
        {step === 0 && (
          <div className="fr-modes" role="radiogroup" aria-label="What you record">
            {MODES.map((m) => (
              <button key={m.value} type="button" role="radio" aria-checked={mode === m.value} className={mode === m.value ? "fr-mode on" : "fr-mode"} onClick={() => switchScene(m.value)}>
                <span className="fr-mode-icon">{m.icon}</span>
                <b>{m.title}</b>
                <span className="note">{m.text}</span>
              </button>
            ))}
          </div>
        )}
        {step === 1 && <StepDevices mode={mode} perms={perms} />}
        {step === 2 && <StepFolder />}
        <div className="fr-foot">
          <div className="fr-dots" aria-hidden>{STEPS.map((s, i) => <i key={s} className={i === step ? "on" : ""} />)}</div>
          <Button variant="ghost" onClick={finish}>Skip setup</Button>
          {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
          {step < STEPS.length - 1 ? <Button variant="ink" onClick={() => setStep(step + 1)}>Next</Button> : <Button variant="ink" onClick={done}>Start recording</Button>}
        </div>
      </div>
    </div>
  );
}
