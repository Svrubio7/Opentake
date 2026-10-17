// OWNED BY: record agent. The big preview in the middle, its control bar, and the Record panel.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { FolderOpen, Monitor, Pause, PictureInPicture2, Play, Square, Trash, Video, X } from "lucide-react";
import type { OutputAspect, RecordMode, ScreenSource, TakeInfo } from "@shared/types";
import { Button, Card, Field, Hint, Segmented, Slider, Switch, Tag } from "../../ui";
import { api, hasBridge } from "./api";
import { compositor } from "./engine";
import { clampBubble, formatClock, hitBubble, needsCamera, needsScreen, snapBubble } from "./layout-core";
import { IntroOutroCard, KeysCard, LogoCard, NameCard, PointerCard } from "./branding-panel";
import { BackgroundCard, CameraBubbleCard, FrameCard, LooksCard, WindowCard } from "./look-panel";
import { useOverlays } from "./overlays";
import { exportTake, refreshTakes, startRecording, stopRecording, switchScene, togglePause, wireRecorder } from "./recorder";
import { currentLayout, isBusy, useRecord } from "./store";
import { PrompterToggle } from "../teleprompter/record-link";
import { DrawCard } from "../draw";
import "./record.css";

// ---------- Stage ----------

/** What will be recorded: screen + camera bubble, or the camera alone. */
export function Stage() {
  const host = useRef<HTMLDivElement>(null);
  const status = useRecord((s) => s.status);
  const countdownValue = useRecord((s) => s.countdownValue);
  const mode = useRecord((s) => s.mode);
  const aspect = useRecord((s) => s.aspect);
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
    <div className={mode === "screen-camera" && status === "idle" ? "rec-stage has-tip" : "rec-stage"} data-aspect={aspect}>
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
      {mode === "screen-camera" && status === "idle" && <div className="rec-stage-tip">Drag the camera to move it, drag its edge to resize</div>}
    </div>
  );
}

// ---------- Control bar under the stage ----------

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
  const set = useRecord((s) => s.set);
  const outro = useOverlays((o) => o.outroEndsAt != null);
  const [picking, setPicking] = useState(false);
  const busy = isBusy(status);
  const live = status === "recording" || status === "paused";
  const bridge = hasBridge();

  return (
    <div className="rec-dock">
      {error && <button type="button" className="rec-msg danger" onClick={() => set({ error: null })} title="Dismiss">{error}<X /></button>}
      {notice && !error && <button type="button" className="rec-msg" onClick={() => set({ notice: null })} title="Dismiss">{notice}<X /></button>}
      <div className="rec-bar">
        <div className="rec-bar-side">
          <Segmented icon label={live ? "Scene: switch while recording" : "What to record"} value={mode} options={MODES} onChange={switchScene} disabled={status === "stopping"} />
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
    set({ sourceId: s.id, sourceName: s.name, displayId: s.displayId ?? null, error: null });
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

const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);
const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const MODE_LABEL: Record<RecordMode, string> = { camera: "Camera", "screen-camera": "Screen + camera", screen: "Screen" };

function TakeRow({ take }: { take: TakeInfo }) {
  const progress = useRecord((s) => s.exports[take.id]);
  const recordingId = useRecord((s) => (s.status !== "idle" ? s.takeId : null));
  const [confirm, setConfirm] = useState(false);
  const running = progress && !progress.done;
  const active = recordingId === take.id;
  const del = async () => {
    try { await api.deleteTake(take.id); } catch (e) { useRecord.getState().set({ error: `Could not delete: ${e instanceof Error ? e.message : e}` }); }
    setConfirm(false);
    void refreshTakes();
  };
  return (
    <li className="rec-take">
      <div className="rec-take-top">
        <div className="rec-take-text">
          <b>{fmtDate(take.createdAt)}</b>
          <span className="tnum">
            {take.durationMs != null ? formatClock(take.durationMs) : "Length unknown"} · {MODE_LABEL[take.mode]} · {fmtSize(take.sizeBytes)}
          </span>
        </div>
        <div className="rec-take-tags">
          {take.status === "recording" && !active && <Tag tone="warn" title="This take was interrupted and recovered">Recovered</Tag>}
          {take.files.mp4 && <Tag tone="good">MP4</Tag>}
        </div>
      </div>
      {running && (
        <div className="rec-progress">
          <div className="progress"><i style={{ width: progress.ratio == null ? "100%" : `${Math.round(progress.ratio * 100)}%` }} className={progress.ratio == null ? "indet" : ""} /></div>
          <span className="tnum">{progress.stage}{progress.ratio != null ? ` ${Math.round(progress.ratio * 100)}%` : ""}</span>
          <Button variant="ghost" size="sm" onClick={() => api.cancelExport(take.id)}>Cancel</Button>
        </div>
      )}
      {progress?.error && <p className="note note-danger">{progress.error}</p>}
      {confirm ? (
        <div className="rec-take-actions">
          <span className="note">Move to the Recycle Bin?</span>
          <Button variant="danger" size="sm" onClick={del}>Delete</Button>
          <Button size="sm" onClick={() => setConfirm(false)}>Keep</Button>
        </div>
      ) : (
        <div className="rec-take-actions">
          <Button size="sm" disabled={running || active || !take.files.composite} onClick={() => exportTake(take.id, "composite")}>{take.files.mp4 ? "Export again" : "Export MP4"}</Button>
          {take.files.screen && (
            <Button size="sm" disabled={running || active || !!take.sceneChanges} onClick={() => exportTake(take.id, "hires")}
              title={take.sceneChanges ? "This take switches scenes. Hi-res follows one layout, so export the MP4 instead."
                : `The screen track at its native resolution, with the zoom redone from the click timeline${take.overlays ? ". Overlays (logo, name card, keys, cards) are not redrawn in it." : ""}`}>Hi-res</Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => api.revealTake(take.id, take.files.hires ?? take.files.mp4)}>Show</Button>
          <Button variant="ghost" size="icon-sm" className="rec-del" disabled={running || active} onClick={() => setConfirm(true)} title="Delete" aria-label="Delete"><Trash /></Button>
        </div>
      )}
    </li>
  );
}

const SOURCE_TAG = {
  processed: { tone: "good", text: "From the Mic tab" },
  fallback: { tone: "warn", text: "Default microphone" },
  none: { tone: "danger", text: "None found" },
} as const;

export function RecordPanel() {
  const s = useRecord();
  const busy = isBusy(s.status);

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

  const mic = SOURCE_TAG[s.micSource === "fallback" ? "fallback" : s.micSource === "none" ? "none" : "processed"];
  const cam = s.cameraSource === "fallback" ? { tone: "warn", text: "Default camera" } as const
    : s.cameraSource === "none" ? { tone: "danger", text: "None found" } as const : { tone: "good", text: "From the Camera tab" } as const;

  return (
    <div className="cards">
      <LooksCard />
      <FrameCard />
      {(needsScreen(s.mode) || s.cameraFramed) && <BackgroundCard />}
      <WindowCard />
      {s.mode === "screen-camera" && <CameraBubbleCard />}
      {needsScreen(s.mode) && <PointerCard />}

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

      <DrawCard />
      <KeysCard />
      <LogoCard />
      <NameCard />
      <IntroOutroCard />

      <Card title="Recording">
        <div className="row">
          <span className="row-label">Frame rate</span>
          <Segmented<30 | 60> value={s.fps} options={[{ value: 30, label: "30 fps" }, { value: 60, label: "60 fps" }]} onChange={(fps) => s.set({ fps })} disabled={busy} />
        </div>
        <Switch label="3, 2, 1 countdown" checked={s.countdown} onChange={(countdown) => s.set({ countdown })} />
        <Switch label="Separate tracks" hint="Also saves the raw screen and camera as their own files, for editing later" checked={s.isoTracks} onChange={(isoTracks) => s.set({ isoTracks })} disabled={busy} />
        <div className="rec-sources">
          <div className="row"><span className="row-label">Mic</span><Tag tone={mic.tone} title={s.micSource === "fallback" ? "The Mic tab is not ready, so the default microphone is used" : undefined}>{mic.text}</Tag></div>
          {needsCamera(s.mode) && <div className="row"><span className="row-label">Camera</span><Tag tone={cam.tone}>{cam.text}</Tag></div>}
        </div>
        <p className="note rec-keys"><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>R</kbd> start or stop, <kbd>P</kbd> pause</p>
        <p className="note rec-keys"><kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> switch scene, <kbd>L</kbd> name card</p>
      </Card>

      <Card title="Export">
        <Field label="Loudness" inline>
          <select className="select" value={s.loudness} onChange={(e) => s.set({ loudness: e.target.value as typeof s.loudness })}>
            <option value="off">As recorded</option>
            <option value="-14">-14 LUFS (social)</option>
            <option value="-16">-16 LUFS (podcast, YouTube)</option>
          </select>
        </Field>
        <Switch label="Trim silence at start and end" checked={s.trimSilence} onChange={(trimSilence) => s.set({ trimSilence })} />
        <Switch label="Export MP4 when I stop" checked={s.autoExport} onChange={(autoExport) => s.set({ autoExport })} />
      </Card>

      <Card title="Takes" action={<Button variant="ghost" size="sm" onClick={() => api.openFolder()}><FolderOpen />Open folder</Button>}>
        {s.takes.length === 0 ? <p className="note">Your recordings will appear here.</p> : (
          <ul className="rec-takes">{s.takes.map((t) => <TakeRow key={t.id} take={t} />)}</ul>
        )}
      </Card>
    </div>
  );
}
