// OWNED BY: record agent. The sidebar panel and the big preview in the middle.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { BubbleShape, OutputAspect, RecordMode, ScreenSource, TakeInfo } from "@shared/types";
import { api, hasBridge } from "./api";
import { compositor } from "./engine";
import { BACKGROUNDS, clampBubble, formatClock, hitBubble, needsCamera, needsScreen, snapBubble } from "./layout-core";
import { exportTake, refreshTakes, startRecording, stopRecording, togglePause, wireRecorder } from "./recorder";
import { currentLayout, isBusy, useRecord } from "./store";
import "./record.css";

// ---------- Stage ----------

/** What will be recorded: screen + camera bubble, or the camera alone. */
export function Stage() {
  const host = useRef<HTMLDivElement>(null);
  const status = useRecord((s) => s.status);
  const countdownValue = useRecord((s) => s.countdownValue);
  const elapsedMs = useRecord((s) => s.elapsedMs);
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

  const live = status === "recording" || status === "paused";
  return (
    <div className="rec-stage" data-aspect={aspect}>
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
      {live && (
        <div className={status === "paused" ? "rec-live paused" : "rec-live"}>
          <span className="rec-dot" />
          {status === "paused" ? "Paused" : "Recording"} <b>{formatClock(elapsedMs)}</b>
        </div>
      )}
      {mode === "screen-camera" && status === "idle" && <div className="rec-stage-tip">Drag the camera to move it, drag its edge to resize</div>}
    </div>
  );
}

// ---------- Panel ----------

const MODES: { id: RecordMode; label: string }[] = [
  { id: "camera", label: "Camera only" },
  { id: "screen-camera", label: "Screen + camera" },
  { id: "screen", label: "Screen only" },
];
const ASPECTS: OutputAspect[] = ["16:9", "9:16", "1:1"];

function Segmented<T extends string | number>({ value, options, onChange, disabled }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="rec-seg">
      {options.map((o) => (
        <button key={String(o.id)} disabled={disabled} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={disabled ? "rec-toggle off" : "rec-toggle"} title={hint}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <i />
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  return (
    <label className="rec-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <em>{format ? format(value) : value}</em>
    </label>
  );
}

function SourcePicker({ onClose }: { onClose: () => void }) {
  const [sources, setSources] = useState<ScreenSource[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.sources().then(setSources, (e) => setErr(String(e))); }, []);
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
    <div className="rec-picker">
      <div className="rec-picker-head"><b>Choose what to record</b><button onClick={onClose}>Close</button></div>
      {err && <p className="rec-error">{err}</p>}
      {!sources && !err && <p className="rec-muted">Looking for screens and windows...</p>}
      {[["Screens", screens], ["Windows", windows]].map(([title, list]) => (list as ScreenSource[]).length > 0 && (
        <div key={title as string}>
          <h4>{title as string}</h4>
          <div className="rec-picker-grid">
            {(list as ScreenSource[]).map((s) => (
              <button key={s.id} className="rec-source" onClick={() => choose(s)}>
                <img src={s.thumbnail} alt="" />
                <span>{s.name}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
      {windows.length > 0 && <p className="rec-muted">Auto zoom follows clicks on whole screens. On a single window it stays off.</p>}
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
        <div>
          <b>{fmtDate(take.createdAt)}</b>
          <span className="rec-muted">
            {take.durationMs != null ? formatClock(take.durationMs) : "Length unknown"} · {MODE_LABEL[take.mode]} · {fmtSize(take.sizeBytes)}
            {take.status === "recording" && !active ? " · Recovered" : ""}
          </span>
        </div>
        {take.files.mp4 && <span className="rec-badge">MP4</span>}
      </div>
      {running && (
        <div className="rec-progress">
          <div className="rec-bar"><i style={{ width: progress.ratio == null ? "100%" : `${Math.round(progress.ratio * 100)}%` }} className={progress.ratio == null ? "indet" : ""} /></div>
          <span>{progress.stage}{progress.ratio != null ? ` ${Math.round(progress.ratio * 100)}%` : ""}</span>
          <button onClick={() => api.cancelExport(take.id)}>Cancel</button>
        </div>
      )}
      {progress?.error && <p className="rec-error">{progress.error}</p>}
      {confirm ? (
        <div className="rec-take-actions">
          <span className="rec-muted">Move this take to the Recycle Bin?</span>
          <button className="danger" onClick={del}>Delete</button>
          <button onClick={() => setConfirm(false)}>Keep</button>
        </div>
      ) : (
        <div className="rec-take-actions">
          <button disabled={running || active || !take.files.composite} onClick={() => exportTake(take.id, "composite")}>{take.files.mp4 ? "Export again" : "Export MP4"}</button>
          {take.files.screen && (
            <button disabled={running || active} title="The screen track at its native resolution, with the zoom redone from the click timeline" onClick={() => exportTake(take.id, "hires")}>Hi-res</button>
          )}
          <button onClick={() => api.revealTake(take.id, take.files.hires ?? take.files.mp4)}>Show</button>
          <button disabled={running || active} onClick={() => setConfirm(true)}>Delete</button>
        </div>
      )}
    </li>
  );
}

export function RecordPanel() {
  const s = useRecord();
  const [picking, setPicking] = useState(false);
  const busy = isBusy(s.status);
  const live = s.status === "recording" || s.status === "paused";

  useEffect(() => { wireRecorder(); }, []);
  // a new mode that drops the screen releases the capture; one that needs it asks for a source
  useEffect(() => {
    if (!needsScreen(s.mode) && s.sourceId) {
      s.set({ sourceId: null, sourceName: null, displayId: null });
      void compositor().useScreen(null, null);
    }
  }, [s.mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const setBubble = (p: Partial<typeof s.bubble>) => {
    const L = currentLayout(s);
    s.set({ bubble: clampBubble({ ...s.bubble, ...p }, L.width, L.height) });
  };

  if (!hasBridge()) return <div className="rec-panel"><p className="rec-error">The recorder needs the desktop app.</p></div>;

  return (
    <div className="rec-panel">
      <section>
        <Segmented value={s.mode} options={MODES} onChange={(mode) => s.set({ mode })} disabled={busy} />
      </section>

      {needsScreen(s.mode) && (
        <section>
          <h3>Source</h3>
          <div className="rec-source-current">
            <span>{s.sourceName ?? "Nothing selected"}</span>
            <button disabled={busy} onClick={() => setPicking(true)}>{s.sourceId ? "Change" : "Choose"}</button>
          </div>
          {picking && <SourcePicker onClose={() => setPicking(false)} />}
        </section>
      )}

      <section>
        <h3>Layout</h3>
        <div className="rec-row"><span>Frame</span><Segmented value={s.aspect} options={ASPECTS.map((a) => ({ id: a, label: a }))} onChange={(aspect) => s.set({ aspect })} disabled={busy} /></div>
        {s.mode === "screen-camera" && (
          <>
            <div className="rec-row">
              <span>Camera</span>
              <Segmented<BubbleShape> value={s.bubble.shape} options={[{ id: "circle", label: "Circle" }, { id: "rounded", label: "Rounded" }]} onChange={(shape) => setBubble({ shape })} />
            </div>
            <Slider label="Camera size" value={s.bubble.size} min={0.12} max={0.5} step={0.01} onChange={(size) => setBubble({ size })} format={(v) => `${Math.round(v * 100)}%`} />
          </>
        )}
        {needsScreen(s.mode) && (
          <>
            <div className="rec-swatches">
              {BACKGROUNDS.map((b) => (
                <button key={b.id} title={b.label} className={b.id === s.backgroundId ? "on" : ""} style={{ background: b.css }} onClick={() => s.set({ backgroundId: b.id })}>
                  {b.id === "none" ? "None" : ""}
                </button>
              ))}
            </div>
            {s.backgroundId !== "none" && (
              <>
                <Slider label="Padding" value={s.padding} min={0} max={0.12} step={0.005} onChange={(padding) => s.set({ padding })} format={(v) => `${Math.round(v * 100)}%`} />
                <Slider label="Corners" value={s.cornerRadius} min={0} max={48} step={1} onChange={(cornerRadius) => s.set({ cornerRadius })} format={(v) => `${v}px`} />
              </>
            )}
          </>
        )}
      </section>

      {needsScreen(s.mode) && (
        <section>
          <h3>Auto zoom</h3>
          <Toggle label="Zoom into clicks" checked={s.zoomEnabled} onChange={(zoomEnabled) => s.set({ zoomEnabled })} disabled={busy} />
          {s.zoomEnabled && <Slider label="Zoom" value={s.zoomScale} min={1.4} max={2.4} step={0.1} onChange={(zoomScale) => s.set({ zoomScale })} format={(v) => `${v.toFixed(1)}x`} />}
          {s.tracking && (
            <p className="rec-muted">
              {!s.tracking.normalized ? "A single window is selected: zoom stays off." :
                s.tracking.hooks ? "Clicks are tracked across the whole screen." :
                  `Global clicks are unavailable, so the zoom follows where the cursor stops.${s.tracking.reason ? ` (${s.tracking.reason})` : ""}`}
            </p>
          )}
        </section>
      )}

      <section>
        <h3>Recording</h3>
        <div className="rec-row"><span>Frame rate</span><Segmented<30 | 60> value={s.fps} options={[{ id: 30, label: "30 fps" }, { id: 60, label: "60 fps" }]} onChange={(fps) => s.set({ fps })} disabled={busy} /></div>
        <Toggle label="3, 2, 1 countdown" checked={s.countdown} onChange={(countdown) => s.set({ countdown })} />
        <Toggle label="Save separate screen and camera tracks" hint="For editing later: the raw screen and camera as their own files" checked={s.isoTracks} onChange={(isoTracks) => s.set({ isoTracks })} disabled={busy} />
        <p className="rec-muted">
          Mic: {s.micSource === "fallback" ? "default microphone (the Mic tab is not ready)" : s.micSource === "none" ? "none found" : "processed voice from the Mic tab"}
          {needsCamera(s.mode) && <> · Camera: {s.cameraSource === "fallback" ? "default camera" : s.cameraSource === "none" ? "none found" : "from the Camera tab"}</>}
        </p>

        <div className="rec-controls">
          {!busy && <button className="rec-big" onClick={startRecording}><span className="rec-dot" /> Start recording</button>}
          {s.status === "countdown" && <button className="rec-big" onClick={() => void stopRecording()}>Cancel</button>}
          {live && (
            <>
              <div className="rec-timer">{formatClock(s.elapsedMs)}</div>
              <button onClick={togglePause}>{s.status === "paused" ? "Resume" : "Pause"}</button>
              <button className="rec-stop" onClick={() => void stopRecording()}>Stop</button>
            </>
          )}
          {s.status === "stopping" && <div className="rec-muted">Saving the take...</div>}
        </div>
        <p className="rec-muted rec-keys"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> start or stop · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> pause</p>
        {s.error && <p className="rec-error" onClick={() => s.set({ error: null })}>{s.error}</p>}
        {s.notice && !s.error && <p className="rec-notice" onClick={() => s.set({ notice: null })}>{s.notice}</p>}
      </section>

      <section>
        <h3>Export</h3>
        <div className="rec-row">
          <span>Loudness</span>
          <select value={s.loudness} onChange={(e) => s.set({ loudness: e.target.value as typeof s.loudness })}>
            <option value="off">As recorded</option>
            <option value="-14">-14 LUFS (social)</option>
            <option value="-16">-16 LUFS (podcast, YouTube)</option>
          </select>
        </div>
        <Toggle label="Trim silence at start and end" checked={s.trimSilence} onChange={(trimSilence) => s.set({ trimSilence })} />
        <Toggle label="Export MP4 when I stop" checked={s.autoExport} onChange={(autoExport) => s.set({ autoExport })} />
      </section>

      <section>
        <div className="rec-takes-head">
          <h3>Takes</h3>
          <button onClick={() => api.openFolder()}>Open folder</button>
        </div>
        {s.takes.length === 0 ? <p className="rec-muted">Your recordings will appear here.</p> : (
          <ul className="rec-takes">{s.takes.map((t) => <TakeRow key={t.id} take={t} />)}</ul>
        )}
      </section>
    </div>
  );
}
