// OWNED BY: record agent. The big preview in the middle, its control bar, and the Record panel.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Monitor, Pause, PictureInPicture2, Play, Square, Video, X } from "lucide-react";
import type { OutputAspect, RecordMode, ScreenSource } from "@shared/types";
import { Button, Card, Field, Hint, Segmented, Slider, Switch } from "../../ui";
import { api, hasBridge } from "./api";
import { compositor } from "./engine";
import { clampBubble, formatClock, hitBubble, needsCamera, needsScreen, snapBubble } from "./layout-core";
import { IntroOutroCard, KeysCard, LogoCard, NameCard, PointerCard } from "./branding-panel";
import { BackgroundCard, CameraBubbleCard, FrameCard, LooksCard, WindowCard } from "./look-panel";
import { useOverlays } from "./overlays";
import { EditorHost } from "../editor";
import { startRecording, stopRecording, switchScene, togglePause, wireRecorder } from "./recorder";
import { goTo, goToRecord, useShell, type RecordSection } from "../shell/store";
import { isStale, noticeLifetimeMs } from "./notice-core";
import { Keys } from "../shell/Shortcuts";
import { ReadinessCard, Suggestions, useProblems } from "./readiness";
import { DockLevel, StageEmpty } from "./stage-empty";
import { currentLayout, isBusy, useRecord } from "./store";
import { PrompterToggle } from "../teleprompter/record-link";
import { DrawCard } from "../draw";
import { SystemSoundControls } from "./system-audio-panel";
import "./record.css";

export { TakesPanel } from "./takes-panel";

// ---------- Stage ----------

/** What will be recorded: screen + camera bubble, or the camera alone. */
export function Stage() {
  const host = useRef<HTMLDivElement>(null);
  const status = useRecord((s) => s.status);
  const countdownValue = useRecord((s) => s.countdownValue);
  const mode = useRecord((s) => s.mode);
  const aspect = useRecord((s) => s.aspect);
  const sourceId = useRecord((s) => s.sourceId);
  const drag = useRef<{ kind: "move" | "resize"; dx: number; dy: number; startSize: number; startDist: number } | null>(null);
  const [cursor, setCursor] = useState("default");

  useEffect(() => {
    wireRecorder();
    const c = compositor().canvas;
    c.className = "rec-canvas";
    host.current?.appendChild(c);
    return () => { c.remove(); };
  }, []);

  const toCanvas = (e: ReactPointerEvent) => {
    const c = compositor().canvas;
    const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, W: c.width, H: c.height };
  };

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = useRecord.getState();
    if (s.mode !== "screen-camera") return;
    const p = toCanvas(e);
    const hit = hitBubble(s.bubble, p.W, p.H, p.x, p.y);
    if (!hit) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const cx = s.bubble.cx * p.W, cy = s.bubble.cy * p.H;
    drag.current = { kind: hit, dx: p.x - cx, dy: p.y - cy, startSize: s.bubble.size, startDist: Math.max(1, Math.hypot(p.x - cx, p.y - cy)) };
  };

  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = useRecord.getState();
    if (s.mode !== "screen-camera") return;
    const p = toCanvas(e);
    const d = drag.current;
    if (!d) {
      const hit = hitBubble(s.bubble, p.W, p.H, p.x, p.y);
      compositor().bubbleHover = hit;
      setCursor(hit === "move" ? "grab" : hit === "resize" ? "nwse-resize" : "default");
      return;
    }
    if (d.kind === "move") {
      s.set({ bubble: clampBubble({ ...s.bubble, cx: (p.x - d.dx) / p.W, cy: (p.y - d.dy) / p.H }, p.W, p.H) });
    } else {
      const cx = s.bubble.cx * p.W, cy = s.bubble.cy * p.H;
      const k = Math.hypot(p.x - cx, p.y - cy) / d.startDist;
      s.set({ bubble: clampBubble({ ...s.bubble, size: d.startSize * k }, p.W, p.H) });
    }
  };

  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    const s = useRecord.getState();
    const L = currentLayout(s);
    s.set({ bubble: snapBubble(s.bubble, L.width, L.height) });
  };

  return (
    <div className={mode === "screen-camera" && status === "idle" && sourceId ? "rec-stage has-tip" : "rec-stage"} data-aspect={aspect}>
      <div
        className="rec-canvas-host"
        ref={host}
        style={{ cursor: drag.current ? "grabbing" : cursor }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={() => { if (!drag.current) compositor().bubbleHover = null; }}
      />
      {status === "countdown" && <div className="rec-countdown" key={countdownValue}>{countdownValue}</div>}
      <StageEmpty />
      {mode === "screen-camera" && status === "idle" && sourceId && <div className="rec-stage-tip">Drag the camera to move it, drag its edge to resize</div>}
    </div>
  );
}

// ---------- Control bar under the stage ----------

/** Clears the bar's message the moment it stops being true, and lets information go after a while. */
function useMessageJanitor() {
  const folderOk = useShell((v) => (v.view ? v.view.recordings.state === "ok" : null));
  const notice = useRecord((s) => s.notice);
  useEffect(() => {
    const check = () => {
      const s = useRecord.getState();
      const state = { mode: s.mode, sourceId: s.sourceId, status: s.status, folderOk: useShell.getState().view ? useShell.getState().view!.recordings.state === "ok" : null, nameCard: s.lowerThird.enabled };
      const notice = s.notice && isStale(s.notice, state) ? null : s.notice;
      const error = s.error && isStale(s.error, state) ? null : s.error;
      if (notice === s.notice && error === s.error) return;
      // the action belongs to the message on show; with none left it goes too
      s.set({ notice, error, ...(notice || error ? {} : { noticeAction: null }) });
    };
    check();
    return useRecord.subscribe(check);
  }, [folderOk]);
  // information goes by itself; errors stay until fixed or dismissed
  useEffect(() => {
    const ms = notice ? noticeLifetimeMs(notice) : null;
    if (!ms) return;
    const t = setTimeout(() => { if (useRecord.getState().notice === notice) useRecord.getState().set({ notice: null, noticeAction: null }); }, ms);
    return () => clearTimeout(t);
  }, [notice]);
}

// the scenes: pick one before a take, or switch live while recording (Ctrl+Shift+1, 2, 3)
const MODES: { value: RecordMode; label: ReactNode; hint: string }[] = [
  { value: "camera", label: <Video />, hint: "Camera only (Ctrl+Shift+1)" },
  { value: "screen-camera", label: <PictureInPicture2 />, hint: "Screen and camera (Ctrl+Shift+2)" },
  { value: "screen", label: <Monitor />, hint: "Screen only (Ctrl+Shift+3)" },
];
const ASPECTS: OutputAspect[] = ["16:9", "9:16", "1:1"];
const aspectLabel = (a: OutputAspect, w: number, h: number) => (a === "custom" ? `${w}×${h}` : a);

export function RecordBar() {
  const status = useRecord((s) => s.status);
  const mode = useRecord((s) => s.mode);
  const aspect = useRecord((s) => s.aspect);
  const customW = useRecord((s) => s.customWidth);
  const customH = useRecord((s) => s.customHeight);
  const sourceId = useRecord((s) => s.sourceId);
  const sourceName = useRecord((s) => s.sourceName);
  const elapsedMs = useRecord((s) => s.elapsedMs);
  const error = useRecord((s) => s.error);
  const notice = useRecord((s) => s.notice);
  const noticeAction = useRecord((s) => s.noticeAction);
  const set = useRecord((s) => s.set);
  const outro = useOverlays((o) => o.outroEndsAt != null);
  const [picking, setPicking] = useState(false);
  const busy = isBusy(status);
  const live = status === "recording" || status === "paused";
  const bridge = hasBridge();
  useMessageJanitor();
  // the stage, the setup and the readiness card all ask for the picker
  useEffect(() => {
    const open = () => { const s = useRecord.getState(); if (needsScreen(s.mode) && (!isBusy(s.status) || !s.sourceId)) setPicking(true); };
    window.addEventListener("opentake:pick-screen", open);
    return () => window.removeEventListener("opentake:pick-screen", open);
  }, []);
  const msgAction = noticeAction && (
    <button type="button" className="rec-msg-action" onClick={() => { if (noticeAction === "overlays") goToRecord("overlays"); else goTo(noticeAction); set({ error: null, notice: null, noticeAction: null }); }}>
      {noticeAction === "takes" ? "Open Takes" : noticeAction === "overlays" ? "Open Overlays" : "Open Settings"}
    </button>
  );

  return (
    <div className="rec-dock">
      {error && <div className="rec-msg danger" role="alert"><span>{error}</span>{msgAction}<button type="button" className="rec-msg-x" onClick={() => set({ error: null, noticeAction: null })} title="Dismiss" aria-label="Dismiss"><X /></button></div>}
      {notice && !error && <div className="rec-msg" role="status"><span>{notice}</span>{msgAction}<button type="button" className="rec-msg-x" onClick={() => set({ notice: null, noticeAction: null })} title="Dismiss" aria-label="Dismiss"><X /></button></div>}
      <div className="rec-bar">
        <div className="rec-bar-side">
          <Segmented icon label={live ? "Scene: switch while recording" : "What to record"} value={mode} options={MODES} onChange={switchScene} disabled={status === "stopping"} />
          <span className="rec-sep" aria-hidden />
          {needsScreen(mode) && (
            // mid-take a screen can be picked only if the take began without one (its own track is already running otherwise)
            <Button className="rec-src" disabled={(busy && (!!sourceId || status === "stopping")) || !bridge} onClick={() => setPicking(true)} title={sourceName ? `Recording ${sourceName}. Click to change.` : "Choose a screen or window"}>
              <Monitor /><span>{sourceId ? sourceName : "Choose screen"}</span>
            </Button>
          )}
          <PrompterToggle />
        </div>

        <div className="rec-bar-main">
          {!busy && (
            <Button variant="ink" size="lg" className="rec-go" onClick={startRecording} disabled={!bridge} title="Start recording (Ctrl+Shift+R)">
              <span className="rec-dot still" />Record
            </Button>
          )}
          {status === "countdown" && <Button size="lg" onClick={() => void stopRecording()}>Cancel</Button>}
          {live && (
            <>
              <span className={status === "paused" ? "rec-clock paused" : "rec-clock"}><span className="rec-dot" />{formatClock(elapsedMs)}</span>
              <Button size="icon" onClick={togglePause} title={status === "paused" ? "Resume (Ctrl+Shift+P)" : "Pause (Ctrl+Shift+P)"} aria-label={status === "paused" ? "Resume" : "Pause"}>
                {status === "paused" ? <Play /> : <Pause />}
              </Button>
              {outro && <span className="note">Outro</span>}
              <Button variant="danger" size="lg" onClick={() => void stopRecording()} title={outro ? "End the take now" : "Stop (Ctrl+Shift+R)"}><Square />{outro ? "Stop now" : "Stop"}</Button>
            </>
          )}
          {status === "stopping" && <span className="note">Saving the take</span>}
        </div>

        <div className="rec-bar-side end">
          <DockLevel />
          <span className="rec-sep" aria-hidden />
          {/* the three common frames, plus the current one when the Record panel set another */}
          <Segmented label="Frame" value={aspect}
            options={(ASPECTS.includes(aspect) ? ASPECTS : [...ASPECTS, aspect]).map((a) => ({ value: a, label: aspectLabel(a, customW, customH), hint: a === "custom" ? "A custom frame (Record panel, Frame)" : `Record a ${a} frame` }))}
            onChange={(a) => set({ aspect: a })} disabled={busy} />
        </div>
      </div>
      {picking && <SourcePicker onClose={() => setPicking(false)} />}
    </div>
  );
}

/** The rail's reminder that a take is running, visible from every tab. */
export function RecordRailStatus({ onOpen }: { onOpen: () => void }) {
  const status = useRecord((s) => s.status);
  const elapsedMs = useRecord((s) => s.elapsedMs);
  if (status !== "recording" && status !== "paused") return null;
  return (
    <button type="button" className={status === "paused" ? "rail-rec paused" : "rail-rec"} onClick={onOpen} title={status === "paused" ? "Paused" : "Recording"}>
      <span className="rec-dot" />
      <span className="tnum">{formatClock(elapsedMs)}</span>
    </button>
  );
}

// ---------- Panel ----------

function SourcePicker({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.sources().then(setSources, (e) => setErr(String(e))); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const choose = async (s: ScreenSource) => {
    const set = useRecord.getState().set;
    set({ sourceId: s.id, sourceName: s.name, displayId: s.displayId ?? null });
    onClose();
    try { await compositor().useScreen(s.id, s.displayId ?? null); } catch (e) {
      set({ sourceId: null, sourceName: null, displayId: null, error: `Could not capture ${s.name}: ${e instanceof Error ? e.message : e}` });
    }
  };
  const screens = sources?.filter((s) => s.id.startsWith("screen:")) ?? [];
  const windows = sources?.filter((s) => !s.id.startsWith("screen:")) ?? [];
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label="Choose what to record">
        <div className="row">
          <h2 className="modal-title">Choose what to record</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X /></Button>
        </div>
        {err && <p className="note note-danger">{err}</p>}
        {!sources && !err && <p className="note">Looking for screens and windows</p>}
        {([["Screens", screens], ["Windows", windows]] as const).map(([title, list]) => list.length > 0 && (
          <div key={title} className="stack">
            <h3 className="rec-pick-title">{title}{title === "Windows" && <Hint text="Auto zoom follows clicks on whole screens. On a single window it stays off." />}</h3>
            <div className="rec-picker-grid">
              {list.map((s) => (
                <button key={s.id} type="button" className="rec-source" onClick={() => choose(s)} title={s.name}>
                  <img src={s.thumbnail} alt="" />
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SECTIONS: { value: RecordSection; label: string; hint: string }[] = [
  { value: "setup", label: "Setup", hint: "What is ready, the recording options and what happens when you stop" },
  { value: "look", label: "Look", hint: "Frame, background, the screen window and the camera" },
  { value: "overlays", label: "Overlays", hint: "Pointer, drawing, keys, logo, name card, intro and outro" },
];

/** How many overlays are on, for the section's label. */
function useOverlayCount(): number {
  return useRecord((s) => [s.keys.enabled, s.logo.enabled, s.lowerThird.enabled, s.intro.enabled, s.outro.enabled, s.pointer.spotlight].filter(Boolean).length);
}

export function RecordPanel() {
  const s = useRecord();
  const busy = isBusy(s.status);
  const section = useShell((v) => v.recordSection);
  const setShell = useShell((v) => v.set);
  const overlays = useOverlayCount();
  const problems = useProblems();

  useEffect(() => { wireRecorder(); }, []);
  // a new mode that drops the screen releases the capture; one that needs it asks for a source
  // (not during a take: a camera scene keeps the screen live so switching back is instant)
  useEffect(() => {
    if (!needsScreen(s.mode) && s.sourceId && !busy) {
      s.set({ sourceId: null, sourceName: null, displayId: null });
      void compositor().useScreen(null, null);
    }
  }, [s.mode, busy]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasBridge()) return <div className="cards"><Card className="card-danger"><p className="note note-danger">The recorder needs the desktop app.</p></Card></div>;

  return (
    <div className="cards">
      <div className="rec-sections">
        <Segmented fill value={section} label="Record settings"
          options={SECTIONS.map((x) => ({
            ...x,
            hint: x.value === "setup" && problems ? "Something needs a fix before you record" : x.hint,
            label: x.value === "overlays" && overlays > 0 ? <>{x.label}<span className="rec-count tnum" aria-label={`${overlays} on`}>{overlays}</span></>
              : x.value === "setup" && problems > 0 && section !== "setup" ? <>{x.label}<i className="rec-alert" aria-label="Needs a fix" /></> : x.label,
          }))}
          onChange={(recordSection) => setShell({ recordSection })} />
      </div>

      {section === "setup" && (
        <>
          <ReadinessCard />
          <Suggestions />
          <Card title="Recording">
            <div className="row">
              <span className="row-label">Frame rate <Hint text="60 fps is smoother for fast screen movement and makes bigger files" /></span>
              <Segmented<30 | 60> value={s.fps} options={[{ value: 30, label: "30 fps" }, { value: 60, label: "60 fps" }]} onChange={(fps) => s.set({ fps })} disabled={busy} />
            </div>
            <Switch label="3, 2, 1 countdown" checked={s.countdown} onChange={(countdown) => s.set({ countdown })} />
            <Switch label="Separate tracks" hint="Also saves the raw screen, the camera and the computer sound as their own files, for editing later" checked={s.isoTracks} onChange={(isoTracks) => s.set({ isoTracks })} disabled={busy} />
            <SystemSoundControls />
            <div className="rec-keys-line">
              <span className="note"><Keys keys={["Mod", "Shift", "R"]} /> starts and stops from any app</span>
              <Button variant="link" onClick={() => setShell({ shortcutsOpen: true })} title="Or press ? anywhere in OpenTake">All shortcuts</Button>
            </div>
          </Card>

          {needsScreen(s.mode) && (
            <Card title="Auto zoom" hint="Zooms in where you click, then eases back out">
              <Switch label="Zoom into clicks" checked={s.zoomEnabled} onChange={(zoomEnabled) => s.set({ zoomEnabled })} disabled={busy} />
              {s.zoomEnabled && <Slider label="Zoom" value={s.zoomScale} min={1.4} max={2.4} step={0.1} onChange={(zoomScale) => s.set({ zoomScale })} format={(v) => `${v.toFixed(1)}x`} />}
              {s.tracking && (
                <p className="note" title={s.tracking.reason ?? undefined}>
                  {!s.tracking.normalized ? "A single window is selected: zoom stays off." :
                    s.tracking.hooks ? "Clicks are tracked across the whole screen." :
                      "Global clicks are unavailable, so the zoom follows where the cursor stops."}
                </p>
              )}
            </Card>
          )}

          <Card title="When you stop" hint="What happens to each take as soon as you press Stop. The Export button on a take can always make other versions.">
            <Switch label="Export an MP4 right away" checked={s.autoExport} onChange={(autoExport) => s.set({ autoExport })} />
            <Field label="Loudness" inline hint="Evens out the volume. -14 LUFS suits social video, -16 LUFS podcasts and YouTube.">
              <select className="select" value={s.loudness} onChange={(e) => s.set({ loudness: e.target.value as typeof s.loudness })}>
                <option value="off">As recorded</option>
                <option value="-14">-14 LUFS (social)</option>
                <option value="-16">-16 LUFS (podcast, YouTube)</option>
              </select>
            </Field>
            <Switch label="Trim silence at start and end" checked={s.trimSilence} onChange={(trimSilence) => s.set({ trimSilence })} />
            <Button variant="link" className="rec-where" onClick={() => goTo("settings")}>Where exports go and their names</Button>
          </Card>
        </>
      )}

      {section === "look" && (
        <>
          <LooksCard />
          <FrameCard />
          {(needsScreen(s.mode) || s.cameraFramed) && <BackgroundCard />}
          <WindowCard />
          {s.mode === "screen-camera" && <CameraBubbleCard />}
        </>
      )}

      {section === "overlays" && (
        <>
          {needsScreen(s.mode) && <PointerCard />}
          <DrawCard />
          <KeysCard />
          <LogoCard />
          <NameCard />
          <IntroOutroCard />
        </>
      )}
      <EditorHost />
    </div>
  );
}
