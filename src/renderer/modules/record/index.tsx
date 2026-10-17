// OWNED BY: record agent. The big preview in the middle, its control bar, and the Record panel.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Monitor, Pause, PictureInPicture2, Play, Square, Video, X } from "lucide-react";
import type { OutputAspect, RecordMode, ScreenSource } from "@shared/types";
import { num, t } from "@shared/i18n";
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
      {mode === "screen-camera" && status === "idle" && sourceId && <div className="rec-stage-tip">{t("record.stage.tip")}</div>}
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
const modes = (): { value: RecordMode; label: ReactNode; hint: string }[] => [
  { value: "camera", label: <Video />, hint: t("record.mode.camera") },
  { value: "screen-camera", label: <PictureInPicture2 />, hint: t("record.mode.screenCamera") },
  { value: "screen", label: <Monitor />, hint: t("record.mode.screen") },
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
      {noticeAction === "takes" ? t("record.msg.openTakes") : noticeAction === "overlays" ? t("record.msg.openOverlays") : t("record.msg.openSettings")}
    </button>
  );

  return (
    <div className="rec-dock">
      {error && <div className="rec-msg danger" role="alert"><span>{error}</span>{msgAction}<button type="button" className="rec-msg-x" onClick={() => set({ error: null, noticeAction: null })} title={t("record.dismiss")} aria-label={t("record.dismiss")}><X /></button></div>}
      {notice && !error && <div className="rec-msg" role="status"><span>{notice}</span>{msgAction}<button type="button" className="rec-msg-x" onClick={() => set({ notice: null, noticeAction: null })} title={t("record.dismiss")} aria-label={t("record.dismiss")}><X /></button></div>}
      <div className="rec-bar">
        <div className="rec-bar-side">
          <Segmented icon label={live ? t("record.bar.sceneLive") : t("record.bar.whatToRecord")} value={mode} options={modes()} onChange={switchScene} disabled={status === "stopping"} />
          <span className="rec-sep" aria-hidden />
          {needsScreen(mode) && (
            // mid-take a screen can be picked only if the take began without one (its own track is already running otherwise)
            <Button className="rec-src" disabled={(busy && (!!sourceId || status === "stopping")) || !bridge} onClick={() => setPicking(true)} title={sourceName ? t("record.bar.sourceTitle", { name: sourceName }) : t("record.bar.chooseSource")}>
              <Monitor /><span>{sourceId ? sourceName : t("record.bar.chooseScreen")}</span>
            </Button>
          )}
          <PrompterToggle />
        </div>

        <div className="rec-bar-main">
          {!busy && (
            <Button variant="ink" size="lg" className="rec-go" onClick={startRecording} disabled={!bridge} title={t("record.bar.startTitle")}>
              <span className="rec-dot still" />{t("record.bar.record")}
            </Button>
          )}
          {status === "countdown" && <Button size="lg" onClick={() => void stopRecording()}>{t("record.cancel")}</Button>}
          {live && (
            <>
              <span className={status === "paused" ? "rec-clock paused" : "rec-clock"}><span className="rec-dot" />{formatClock(elapsedMs)}</span>
              <Button size="icon" onClick={togglePause} title={status === "paused" ? t("record.bar.resumeTitle") : t("record.bar.pauseTitle")} aria-label={status === "paused" ? t("record.bar.resume") : t("record.bar.pause")}>
                {status === "paused" ? <Play /> : <Pause />}
              </Button>
              {outro && <span className="note">{t("record.bar.outro")}</span>}
              <Button variant="danger" size="lg" onClick={() => void stopRecording()} title={outro ? t("record.bar.endNowTitle") : t("record.bar.stopTitle")}><Square />{outro ? t("record.bar.stopNow") : t("record.bar.stop")}</Button>
            </>
          )}
          {status === "stopping" && <span className="note">{t("record.bar.saving")}</span>}
        </div>

        <div className="rec-bar-side end">
          <DockLevel />
          {/* the frame cannot change during a take, so it makes room for the take's own controls */}
          {!busy && <span className="rec-sep" aria-hidden />}
          {/* the three common frames, plus the current one when the Record panel set another */}
          {!busy && (
            <Segmented label={t("record.bar.frame")} value={aspect}
              options={(ASPECTS.includes(aspect) ? ASPECTS : [...ASPECTS, aspect]).map((a) => ({ value: a, label: aspectLabel(a, customW, customH), hint: a === "custom" ? t("record.bar.customFrame") : t("record.bar.aspectHint", { aspect: a }) }))}
              onChange={(a) => set({ aspect: a })} />
          )}
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
    <button type="button" className={status === "paused" ? "rail-rec paused" : "rail-rec"} onClick={onOpen} title={status === "paused" ? t("record.rail.paused") : t("record.rail.recording")}>
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
      set({ sourceId: null, sourceName: null, displayId: null, error: t("record.picker.captureFailed", { name: s.name, reason: e instanceof Error ? e.message : String(e) }) });
    }
  };
  const screens = sources?.filter((s) => s.id.startsWith("screen:")) ?? [];
  const windows = sources?.filter((s) => !s.id.startsWith("screen:")) ?? [];
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label={t("record.picker.title")}>
        <div className="row">
          <h2 className="modal-title">{t("record.picker.title")}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("record.close")}><X /></Button>
        </div>
        {err && <p className="note note-danger">{err}</p>}
        {!sources && !err && <p className="note">{t("record.picker.looking")}</p>}
        {([["screens", screens], ["windows", windows]] as const).map(([kind, list]) => list.length > 0 && (
          <div key={kind} className="stack">
            <h3 className="rec-pick-title">{kind === "screens" ? t("record.picker.screens") : t("record.picker.windows")}{kind === "windows" && <Hint text={t("record.picker.windowsHint")} />}</h3>
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

const sections = (): { value: RecordSection; label: string; hint: string }[] => [
  { value: "setup", label: t("record.section.setup"), hint: t("record.section.setupHint") },
  { value: "look", label: t("record.section.look"), hint: t("record.section.lookHint") },
  { value: "overlays", label: t("record.section.overlays"), hint: t("record.section.overlaysHint") },
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

  if (!hasBridge()) return <div className="cards"><Card className="card-danger"><p className="note note-danger">{t("record.needsApp")}</p></Card></div>;

  return (
    <div className="cards">
      <div className="rec-sections">
        <Segmented fill value={section} label={t("record.sections.label")}
          options={sections().map((x) => ({
            ...x,
            hint: x.value === "setup" && problems ? t("record.section.needsFixHint") : x.hint,
            label: x.value === "overlays" && overlays > 0 ? <>{x.label}<span className="rec-count tnum" aria-label={t("record.section.countOn", { count: overlays })}>{overlays}</span></>
              : x.value === "setup" && problems > 0 && section !== "setup" ? <>{x.label}<i className="rec-alert" aria-label={t("record.needsFix")} /></> : x.label,
          }))}
          onChange={(recordSection) => setShell({ recordSection })} />
      </div>

      {section === "setup" && (
        <>
          <ReadinessCard />
          <Suggestions />
          <Card title={t("card.recording")}>
            <div className="row">
              <span className="row-label">{t("record.fps.label")} <Hint text={t("record.fps.hint")} /></span>
              <Segmented<30 | 60> value={s.fps} options={[{ value: 30, label: "30 fps" }, { value: 60, label: "60 fps" }]} onChange={(fps) => s.set({ fps })} disabled={busy} />
            </div>
            <Switch label={t("record.countdown")} checked={s.countdown} onChange={(countdown) => s.set({ countdown })} />
            <Switch label={t("record.iso")} hint={t("record.iso.hint")} checked={s.isoTracks} onChange={(isoTracks) => s.set({ isoTracks })} disabled={busy} />
            <SystemSoundControls />
            <div className="rec-keys-line">
              <span className="note"><Keys keys={["Mod", "Shift", "R"]} /> {t("record.keysLine")}</span>
              <Button variant="link" onClick={() => setShell({ shortcutsOpen: true })} title={t("record.allShortcutsTitle")}>{t("record.allShortcuts")}</Button>
            </div>
          </Card>

          {needsScreen(s.mode) && (
            <Card title={t("card.autoZoom")} hint={t("record.zoom.hint")}>
              <Switch label={t("record.zoom.switch")} checked={s.zoomEnabled} onChange={(zoomEnabled) => s.set({ zoomEnabled })} disabled={busy} />
              {s.zoomEnabled && <Slider label={t("record.zoom.slider")} value={s.zoomScale} min={1.4} max={2.4} step={0.1} onChange={(zoomScale) => s.set({ zoomScale })} format={(v) => `${num(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x`} />}
              {s.tracking && (
                <p className="note" title={s.tracking.reason ?? undefined}>
                  {!s.tracking.normalized ? t("record.zoom.window") :
                    s.tracking.hooks ? t("record.zoom.hooks") :
                      t("record.zoom.cursor")}
                </p>
              )}
            </Card>
          )}

          <Card title={t("card.whenYouStop")} hint={t("record.stop.hint")}>
            <Switch label={t("record.stop.autoExport")} checked={s.autoExport} onChange={(autoExport) => s.set({ autoExport })} />
            <Field label={t("record.loudness")} inline hint={t("record.loudness.hint")}>
              <select className="select" value={s.loudness} onChange={(e) => s.set({ loudness: e.target.value as typeof s.loudness })}>
                <option value="off">{t("record.loudness.off")}</option>
                <option value="-14">{t("record.loudness.social")}</option>
                <option value="-16">{t("record.loudness.podcast")}</option>
              </select>
            </Field>
            <Switch label={t("record.trim")} checked={s.trimSilence} onChange={(trimSilence) => s.set({ trimSilence })} />
            <Button variant="link" className="rec-where" onClick={() => goTo("settings")}>{t("record.where")}</Button>
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
