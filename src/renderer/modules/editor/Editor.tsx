// The take editor: a player, the timeline with cuts, and captions. It opens over the whole window
// from a take's Edit button; cuts and captions save beside the take as you work.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Pause, Play, Redo2, Scissors, Trash2, Undo2, ZoomIn, ZoomOut, ArchiveRestore, Upload } from "lucide-react";
import type { CaptionLang, CaptionLine, EditorTake, TakePeaks, TimeRange } from "@shared/types";
import { Button, Hint } from "../../ui";
import { usePrompter } from "../teleprompter/store";
import { refreshTakes } from "../record/recorder";
import { useRecord } from "../record/store";
import { activeLine, balanceRows, fromVosk, groupWords, lineText, socialChunks } from "./captions-core";
import { CaptionsPanel } from "./CaptionsPanel";
import {
  formatTime, history, indexAt, isWhole, keptDuration, playableAt, push, redo, removeAt, restore, setIn, setOut, splitAt, toEdited, undo,
  wholeTake, type History,
} from "./edit-core";
import { editorApi } from "./api";
import { openExport, useEditor } from "./store";
import { MAX_ZOOM, Timeline, type Selection } from "./Timeline";
import { transcribe } from "./transcribe";

interface Doc { keep: TimeRange[]; lines: CaptionLine[] | null; lang: CaptionLang }

const FRAME_MS = 1000 / 30;
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

export function Editor({ takeId, onClose }: { takeId: string; onClose: () => void }) {
  const [data, setData] = useState<EditorTake | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<TakePeaks | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [hist, setHist] = useState<History<Doc> | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [selection, setSelection] = useState<Selection>(null);
  const [captionJob, setCaptionJob] = useState<{ stage: string; ratio: number | null } | null>(null);
  const [captionError, setCaptionError] = useState<string | null>(null);
  const [filesNote, setFilesNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const abort = useRef<AbortController | null>(null);
  const progress = useRecord((s) => s.exports[takeId]);

  useEffect(() => {
    let live = true;
    editorApi.open(takeId).then((d) => { if (live) setData(d); }, (e) => live && setError(e instanceof Error ? e.message : String(e)));
    editorApi.peaks(takeId).then((p) => { if (live) setPeaks(p); }, () => {});
    return () => { live = false; abort.current?.abort(); };
  }, [takeId]);

  // the player knows the true length once it has read the file
  const begin = useCallback((ms: number) => {
    if (!data || hist) return;
    const d = Math.max(1, Math.round(ms));
    setDuration(d);
    const lang: CaptionLang = data.captions?.lang ?? (usePrompter.getState().state.lang === "es" ? "es" : "en");
    setHist(history({ keep: data.edit?.keep.length ? data.edit.keep : wholeTake(d), lines: data.captions?.lines ?? null, lang }));
  }, [data, hist]);

  const doc = hist?.present ?? null;
  const keep = doc?.keep ?? [];
  const change = useCallback((f: (d: Doc) => Doc) => setHist((h) => (h ? push(h, f(h.present)) : h)), []);

  // ---- saving, a moment after each change ----
  const saved = useRef<{ keep: TimeRange[] | null; lines: CaptionLine[] | null | undefined }>({ keep: null, lines: undefined });
  useEffect(() => {
    if (!doc || duration == null) return;
    if (saved.current.keep === null) { saved.current = { keep: doc.keep, lines: doc.lines }; return; }
    const timer = setTimeout(async () => {
      try {
        if (doc.keep !== saved.current.keep) {
          await editorApi.saveEdit(takeId, { version: 1, keep: doc.keep }, duration);
          saved.current.keep = doc.keep;
        }
        if (doc.lines && doc.lines !== saved.current.lines) {
          await editorApi.saveCaptions(takeId, { version: 1, lang: doc.lang, lines: doc.lines });
          saved.current.lines = doc.lines;
        }
        setSaveError(null);
        void refreshTakes();
      } catch (e) {
        setSaveError(`Could not save: ${e instanceof Error ? e.message : e}`);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [doc, duration, takeId]);

  // ---- playback that skips the cuts ----
  const seek = useCallback((ms: number) => {
    const v = video.current;
    const t = Math.max(0, Math.min(duration ?? ms, ms));
    if (v) v.currentTime = t / 1000;
    setPlayhead(t);
  }, [duration]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      const v = video.current;
      if (!v) return;
      const t = v.currentTime * 1000;
      const next = playableAt(t, keep);
      if (next == null) {
        v.pause();
        setPlaying(false);
        setPlayhead(keep[keep.length - 1]?.end ?? t);
        return;
      }
      if (next - t > 15) v.currentTime = next / 1000;
      setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, keep]);

  const play = useCallback(async (rate = 1) => {
    const v = video.current;
    if (!v || !keep.length) return;
    const at = playableAt(playhead, keep) ?? keep[0].start;
    if (Math.abs(at - playhead) > 1 || v.ended) v.currentTime = at / 1000;
    v.playbackRate = rate;
    try { await v.play(); setPlaying(true); } catch { /* interrupted by a pause */ }
  }, [keep, playhead]);
  const pause = useCallback(() => { video.current?.pause(); setPlaying(false); }, []);
  const toggle = useCallback(() => (playing ? pause() : void play()), [playing, pause, play]);

  // ---- edits ----
  const split = useCallback(() => change((d) => ({ ...d, keep: splitAt(d.keep, playhead) })), [change, playhead]);
  const removeSelected = useCallback(() => {
    if (selection?.kind === "gap") {
      change((d) => ({ ...d, keep: restore(d.keep, selection.range, duration ?? 0) }));
      setSelection(null);
      return;
    }
    const i = selection?.kind === "keep" ? selection.index : indexAt(keep, playhead);
    if (i < 0 || keep.length <= 1) return;
    change((d) => ({ ...d, keep: removeAt(d.keep, i) }));
    setSelection(null);
  }, [change, selection, keep, playhead, duration]);
  const markIn = useCallback(() => change((d) => { const k = setIn(d.keep, playhead); return k.length ? { ...d, keep: k } : d; }), [change, playhead]);
  const markOut = useCallback(() => change((d) => { const k = setOut(d.keep, playhead); return k.length ? { ...d, keep: k } : d; }), [change, playhead]);
  const doUndo = useCallback(() => { setHist((h) => (h ? undo(h) : h)); setSelection(null); }, []);
  const doRedo = useCallback(() => { setHist((h) => (h ? redo(h) : h)); setSelection(null); }, []);

  // ---- keys ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useEditor.getState().exporting) return; // the export dialog is on top
      if (typing(e.target)) return;
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      let handled = true;
      if (ctrl && k === "z") (e.shiftKey ? doRedo : doUndo)();
      else if (ctrl && k === "y") doRedo();
      else if (ctrl) handled = false;
      else if (k === " ") toggle();
      else if (k === "k") pause();
      else if (k === "l") void play(playing && video.current ? Math.min(2, video.current.playbackRate + 0.5) : 1);
      else if (k === "j") { seek(Math.max(0, playhead - 2000)); }
      else if (k === "arrowleft") seek(playhead - (e.shiftKey ? 1000 : FRAME_MS));
      else if (k === "arrowright") seek(playhead + (e.shiftKey ? 1000 : FRAME_MS));
      else if (k === "home") seek(keep[0]?.start ?? 0);
      else if (k === "end") seek(keep[keep.length - 1]?.end ?? 0);
      else if (k === "i") markIn();
      else if (k === "o") markOut();
      else if (k === "s") split();
      else if (k === "delete" || k === "backspace") removeSelected();
      else if (k === "escape") { if (selection) setSelection(null); else onClose(); }
      else if (k === "+" || k === "=") setZoom((z) => Math.min(MAX_ZOOM, z * 1.5));
      else if (k === "-") setZoom((z) => Math.max(1, z / 1.5));
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [doUndo, doRedo, toggle, pause, play, playing, seek, playhead, keep, markIn, markOut, split, removeSelected, selection, onClose]);

  // ---- captions ----
  const makeCaptions = async () => {
    if (!doc) return;
    const ctl = new AbortController();
    abort.current = ctl;
    setCaptionError(null);
    try {
      const words = await transcribe(takeId, doc.lang, (stage, ratio) => setCaptionJob({ stage, ratio }), ctl.signal);
      const lines = groupWords(fromVosk(words, doc.lang), doc.lang);
      change((d) => ({ ...d, lines }));
    } catch (e) {
      if (!ctl.signal.aborted) setCaptionError(`Could not make captions: ${e instanceof Error ? e.message : e}`);
    } finally {
      setCaptionJob(null);
      abort.current = null;
    }
  };
  const saveFiles = async () => {
    setFilesNote(null);
    try {
      // the files are written from what is on disk: make sure the latest fixes are there first
      if (doc?.lines) { await editorApi.saveCaptions(takeId, { version: 1, lang: doc.lang, lines: doc.lines }); saved.current.lines = doc.lines; }
      if (doc && duration != null) { await editorApi.saveEdit(takeId, { version: 1, keep: doc.keep }, duration); saved.current.keep = doc.keep; }
      await editorApi.captionFiles(takeId);
      setFilesNote("Saved take.srt and take.vtt");
      void refreshTakes();
    } catch (e) {
      setFilesNote(e instanceof Error ? e.message : String(e));
    }
  };

  const close = async () => {
    pause();
    // nothing waits on the debounce: write the last change now
    try {
      if (doc && duration != null && doc.keep !== saved.current.keep) await editorApi.saveEdit(takeId, { version: 1, keep: doc.keep }, duration);
      if (doc?.lines && doc.lines !== saved.current.lines) await editorApi.saveCaptions(takeId, { version: 1, lang: doc.lang, lines: doc.lines });
    } catch { /* the error is on screen already */ }
    void refreshTakes();
    onClose();
  };
  const exportNow = async () => {
    pause();
    if (doc && duration != null && doc.keep !== saved.current.keep) { await editorApi.saveEdit(takeId, { version: 1, keep: doc.keep }, duration); saved.current.keep = doc.keep; }
    if (doc?.lines && doc.lines !== saved.current.lines) { await editorApi.saveCaptions(takeId, { version: 1, lang: doc.lang, lines: doc.lines }); saved.current.lines = doc.lines; }
    await refreshTakes();
    openExport(takeId);
  };

  const editedMs = keptDuration(keep);
  const editedAt = toEdited(playhead, keep);
  const lines = doc?.lines ?? null;
  const active = lines ? activeLine(lines, playhead) : -1;
  const running = progress && !progress.done;
  const cut = duration != null && !isWhole(keep, duration);
  const title = data ? new Date(data.take.createdAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

  return (
    <div className="ed-scrim" role="dialog" aria-label="Edit take">
      <header className="ed-head">
        <Button variant="ghost" onClick={close}><ArrowLeft />Takes</Button>
        <div className="ed-title">
          <b>{title}</b>
          {duration != null && <span className="tnum">{cut ? `${formatTime(editedMs, false)} of ${formatTime(duration, false)}` : formatTime(duration, false)}</span>}
        </div>
        <div className="ed-head-tools">
          {saveError && <span className="note note-danger">{saveError}</span>}
          {running && <span className="note tnum">{progress.stage}{progress.ratio != null ? ` ${Math.round(progress.ratio * 100)}%` : ""}</span>}
          {progress?.done && progress.output && !progress.error && <span className="note">Saved {progress.output.split(/[\\/]/).pop()}</span>}
          {progress?.error && <span className="note note-danger">{progress.error}</span>}
          <Button size="icon" variant="ghost" onClick={doUndo} disabled={!hist?.past.length} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 /></Button>
          <Button size="icon" variant="ghost" onClick={doRedo} disabled={!hist?.future.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Redo2 /></Button>
          <Button variant="ink" onClick={exportNow} disabled={!hist || running}><Upload />Export</Button>
        </div>
      </header>

      <div className="ed-body">
        <div className="ed-stage">
          {error && <p className="note note-danger">{error}</p>}
          {!data && !error && <p className="note">Opening the take</p>}
          {data && (
            <Player url={data.mediaUrl} videoRef={video} onReady={(ms) => begin(Number.isFinite(ms) && ms > 0 ? ms : data.durationMs ?? 0)}
              onTime={(ms) => { if (!playing) setPlayhead(ms); }} onClick={toggle}
              caption={active >= 0 && lines ? lines[active] : null} playhead={playhead} />
          )}
        </div>
        <aside className="ed-side">
          {doc && data && (
            <CaptionsPanel lines={lines} lang={doc.lang} active={active} busy={captionJob} error={captionError} hasAudio={data.hasAudio} canBurn={data.canBurn}
              onLang={(lang) => setHist((h) => (h ? { ...h, present: { ...h.present, lang } } : h))}
              onMake={makeCaptions} onStop={() => abort.current?.abort()}
              onChange={(next) => change((d) => ({ ...d, lines: next }))} onSeek={seek} onSaveFiles={saveFiles} filesNote={filesNote} />
          )}
          <KeysCard />
        </aside>
      </div>

      <footer className="ed-foot">
        <div className="ed-transport">
          <Button size="icon" variant="ink" onClick={toggle} disabled={!hist} title={playing ? "Pause (Space)" : "Play (Space)"} aria-label={playing ? "Pause" : "Play"}>{playing ? <Pause /> : <Play />}</Button>
          <span className="ed-clock tnum" title="Position in the edited video, and on the recording">
            {editedAt != null ? formatTime(editedAt) : "Cut"} <small>/ {formatTime(editedMs)}</small>
          </span>
          <div className="ed-tools">
            <Button size="sm" onClick={markIn} disabled={!hist} title="Cut everything before the playhead (I)">Set in</Button>
            <Button size="sm" onClick={markOut} disabled={!hist} title="Cut everything after the playhead (O)">Set out</Button>
            <Button size="sm" onClick={split} disabled={!hist} title="Split at the playhead (S)"><Scissors />Split</Button>
            {selection?.kind === "gap"
              ? <Button size="sm" onClick={removeSelected} title="Put this cut back (Delete)"><ArchiveRestore />Restore</Button>
              : <Button size="sm" onClick={removeSelected} disabled={!hist || keep.length <= 1} title="Delete the selected part, or the part under the playhead (Delete)"><Trash2 />Delete</Button>}
          </div>
          <div className="ed-zoom">
            <Button size="icon-sm" variant="ghost" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} disabled={zoom <= 1} title="Zoom out (-)" aria-label="Zoom out"><ZoomOut /></Button>
            <input className="range" type="range" min={0} max={Math.log(MAX_ZOOM)} step={0.01} value={Math.log(zoom)} aria-label="Zoom"
              style={{ "--lo": "0%", "--hi": `${(Math.log(zoom) / Math.log(MAX_ZOOM)) * 100}%` } as CSSProperties}
              onChange={(e) => setZoom(Math.exp(Number(e.target.value)))} />
            <Button size="icon-sm" variant="ghost" onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.5))} title="Zoom in (+)" aria-label="Zoom in"><ZoomIn /></Button>
          </div>
        </div>
        {duration != null && doc ? (
          <Timeline durationMs={duration} keep={keep} peaks={peaks} lines={lines} playhead={playhead} zoom={zoom} selection={selection}
            onSeek={seek} onSelect={setSelection} onZoom={setZoom} />
        ) : <div className="ed-timeline-wait note">Reading the take</div>}
      </footer>
    </div>
  );
}

function KeysCard() {
  return (
    <section className="card ed-keys">
      <div className="card-head"><h3 className="card-title">Keys<Hint text="Shortcuts work while the editor is open and you are not typing in a caption." /></h3></div>
      <dl>
        <dt><kbd>Space</kbd></dt><dd>Play or pause</dd>
        <dt><kbd>J</kbd> <kbd>K</kbd> <kbd>L</kbd></dt><dd>Back 2 s, pause, play (again: faster)</dd>
        <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>One frame, with Shift one second</dd>
        <dt><kbd>I</kbd> <kbd>O</kbd></dt><dd>Cut before or after the playhead</dd>
        <dt><kbd>S</kbd></dt><dd>Split at the playhead</dd>
        <dt><kbd>Delete</kbd></dt><dd>Delete the part, or restore a cut</dd>
        <dt><kbd>Ctrl</kbd> <kbd>Z</kbd></dt><dd>Undo, with Shift redo</dd>
        <dt><kbd>Ctrl</kbd> + wheel</dt><dd>Zoom the timeline</dd>
      </dl>
    </section>
  );
}

function Player({ url, videoRef, onReady, onTime, onClick, caption, playhead }: {
  url: string; videoRef: React.RefObject<HTMLVideoElement | null>; onReady: (ms: number) => void; onTime: (ms: number) => void; onClick: () => void;
  caption: CaptionLine | null; playhead: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const look = useEditor((s) => s.captionLook);
  const [failed, setFailed] = useState<string | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the picture's size inside the box, so the caption preview sits on the picture, not the letterbox
  const fit = size && natural ? (() => { const k = Math.min(size.w / natural.w, size.h / natural.h); return { w: natural.w * k, h: natural.h * k }; })() : null;
  const short = fit ? Math.min(fit.w, fit.h) : 0;

  let text: React.ReactNode = null;
  if (caption) {
    if (look.style === "social") {
      const chunk = socialChunks([caption]).find((c) => playhead >= c.start && playhead < c.end) ?? null;
      text = chunk && chunk.words.map((w, i) => {
        const next = chunk.words[i + 1]?.start ?? chunk.end;
        const on = playhead >= (i === 0 ? chunk.start : w.start) && playhead < next;
        return <span key={i} className={on ? "hl" : ""}>{w.text.toUpperCase()}{i < chunk.words.length - 1 ? " " : ""}</span>;
      });
    } else {
      text = balanceRows(lineText(caption), 42).map((r, i) => <span key={i} className="row-line">{r}</span>);
    }
  }
  return (
    <div className="ed-player" ref={box}>
      <div className="ed-frame" style={fit ? { width: fit.w, height: fit.h } : undefined}>
        <video ref={videoRef} src={url} preload="auto" playsInline onClick={onClick}
          onLoadedMetadata={(e) => { const v = e.currentTarget; setNatural({ w: v.videoWidth || 16, h: v.videoHeight || 9 }); onReady(v.duration * 1000); }}
          onTimeUpdate={(e) => onTime(e.currentTarget.currentTime * 1000)}
          onSeeked={(e) => onTime(e.currentTarget.currentTime * 1000)}
          onError={() => { setFailed("The take could not be played here. Cuts and export still work."); onReady(NaN); }} />
        {text && fit && (
          <div className={`ed-cap ${look.style} ${look.position}`}
            style={{ fontSize: short * (look.style === "social" ? 0.085 : 0.05), [look.position]: look.margin * fit.h } as CSSProperties}>
            <span className="ed-cap-text">{text}</span>
          </div>
        )}
      </div>
      {failed && <p className="note note-danger ed-player-error">{failed}</p>}
    </div>
  );
}
