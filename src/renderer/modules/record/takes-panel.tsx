// The Takes tab: every take in the recordings folder, newest first, with its title, exports and the
// actions people reach for after recording (edit, export, show, rename, delete).
import { useEffect, useRef, useState } from "react";
import { CircleDot, FolderOpen, Monitor, Pencil, PictureInPicture2, Scissors, Search, Settings2, Trash, Video, X } from "lucide-react";
import { IPC } from "@shared/ipc";
import type { RecordMode, TakeInfo } from "@shared/types";
import { Button, Card, Tag } from "../../ui";
import { shortPath } from "../../../main/settings-core";
import { openEditor, openExport } from "../editor";
import { applyChoice, dismiss, freeLabel, goTo, refreshSettings, shellApi, useShell } from "../shell/store";
import { takeSuggestion } from "../shell/suggestions-core";
import { api, hasBridge } from "./api";
import { formatClock } from "./layout-core";
import { refreshTakes } from "./recorder";
import { useRecord } from "./store";

const fmtSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(0.1, b / 1e6).toFixed(1)} MB`);
const fmtDate = (t: number) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const MODE_LABEL: Record<RecordMode, string> = { camera: "Camera", "screen-camera": "Screen and camera", screen: "Screen" };
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const isVideo = (p: string) => /\.(mp4|webm|gif)$/i.test(p);

function TitleEditor({ take, onDone }: { take: TakeInfo; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const save = async () => {
    const v = ref.current?.value ?? "";
    onDone();
    if (v.trim() === (take.title ?? "")) return;
    try { await shellApi.rename(take.id, v); } catch (e) { useRecord.getState().set({ error: `Could not rename: ${e instanceof Error ? e.message : e}` }); }
    void refreshTakes();
  };
  return (
    <input ref={ref} className="input tk-title-input" defaultValue={take.title ?? ""} placeholder="Name this take" maxLength={80} aria-label="Take title"
      onBlur={() => void save()} onKeyDown={(e) => { if (e.key === "Enter") ref.current?.blur(); if (e.key === "Escape") { e.stopPropagation(); if (ref.current) ref.current.value = take.title ?? ""; onDone(); } }} />
  );
}

const MODE_ICON: Record<RecordMode, typeof Video> = { camera: Video, "screen-camera": PictureInPicture2, screen: Monitor };

/** The take's picture (made once by main as thumb.jpg) with its length on it; the scene's icon until it exists. */
function TakeThumb({ take, active }: { take: TakeInfo; active: boolean }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (active || take.status !== "done" || !take.files.composite) return;
    let live = true;
    void window.take.invoke(IPC.takeThumb, take.id).then((u) => { if (live) setSrc((u as string | null) ?? null); }, () => {});
    return () => { live = false; };
  }, [take.id, take.status, take.sizeBytes, active, take.files.composite]);
  const Icon = MODE_ICON[take.mode];
  return (
    <div className={active ? "tk-thumb live" : "tk-thumb"} aria-hidden>
      {src ? <img src={src} alt="" draggable={false} onError={() => setSrc(null)} /> : <Icon />}
      {active ? <span className="tk-thumb-badge rec"><i />REC</span>
        : take.durationMs != null ? <span className="tk-thumb-badge tnum">{formatClock(take.durationMs)}</span> : null}
    </div>
  );
}

function TakeRow({ take }: { take: TakeInfo }) {
  const progress = useRecord((s) => s.exports[take.id]);
  const recordingId = useRecord((s) => (s.status !== "idle" ? s.takeId : null));
  const dismissed = useShell((s) => s.dismissed);
  const [confirm, setConfirm] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const running = !!progress && !progress.done;
  const active = recordingId === take.id;
  const lastVideo = take.files.outputs?.find(isVideo);
  const exportsCount = take.files.outputs?.filter(isVideo).length ?? 0;
  const tip = takeSuggestion({ durationMs: take.durationMs, hasCaptions: !!take.files.captions }, new Set(dismissed));
  const del = async () => {
    try { await api.deleteTake(take.id); } catch (e) { useRecord.getState().set({ error: `Could not delete: ${e instanceof Error ? e.message : e}` }); }
    setConfirm(false);
    void refreshTakes();
  };
  return (
    <li className={active ? "rec-take live" : "rec-take"}>
      <div className="tk-row">
        <TakeThumb take={take} active={active} />
        <div className="tk-main">
          {renaming ? <TitleEditor take={take} onDone={() => setRenaming(false)} /> : (
            <button type="button" className="tk-title" onClick={() => setRenaming(true)} title="Rename this take" disabled={active}>
              <b>{take.title || fmtDate(take.createdAt)}</b>{!active && <Pencil aria-hidden />}
            </button>
          )}
          <span className="tk-meta tnum">
            {take.title ? `${fmtDate(take.createdAt)} · ` : ""}{active ? "Recording now · " : take.durationMs == null ? "Length unknown · " : ""}{MODE_LABEL[take.mode]} · {fmtSize(take.sizeBytes)}
          </span>
          <div className="rec-take-tags">
          {active && <Tag tone="rec">Recording</Tag>}
          {!active && (take.recovered || take.status === "recording") && <Tag tone="warn" title="OpenTake closed while this take was recording. What reached the disk was kept.">Recovered</Tag>}
          {take.files.edit && <Tag title="This take has cuts">Edited</Tag>}
          {take.files.captions && <Tag title="This take has captions">Captions</Tag>}
          {exportsCount > 0 && <Tag tone="good" title={`${exportsCount} exported ${exportsCount === 1 ? "file" : "files"}`}>Exported</Tag>}
          </div>
        </div>
      </div>
      {running && (
        <div className="rec-progress" aria-live="polite">
          <div className="progress"><i style={{ width: progress.ratio == null ? "100%" : `${Math.round(progress.ratio * 100)}%` }} className={progress.ratio == null ? "indet" : ""} /></div>
          <span className="tnum">{progress.stage}{progress.ratio != null ? ` ${Math.round(progress.ratio * 100)}%` : ""}</span>
          <Button variant="ghost" size="sm" onClick={() => api.cancelExport(take.id)}>Cancel</Button>
        </div>
      )}
      {progress?.error && (
        <div className="tk-msg danger" role="alert">
          <span>{progress.error}</span>
          {/Settings/.test(progress.error) && <Button size="sm" variant="ghost" onClick={() => goTo("settings")}>Open Settings</Button>}
        </div>
      )}
      {progress?.done && !progress.error && progress.output && (
        <p className="note tk-msg" title={progress.output}>Saved <b>{fileName(progress.output)}</b></p>
      )}
      {!progress?.output && lastVideo && !running && (
        <p className="note tk-last" title={lastVideo}>Last export: {fileName(lastVideo)}</p>
      )}
      {tip && !active && (
        <div className="tip">
          <span>{tip.text}</span>
          <div className="tip-actions">
            <Button size="sm" onClick={() => openEditor(take.id)}>{tip.action?.label}</Button>
            <Button size="icon-sm" variant="ghost" onClick={() => dismiss(tip.id)} title="Do not suggest this again" aria-label="Dismiss"><X /></Button>
          </div>
        </div>
      )}
      {confirm ? (
        <div className="rec-take-actions">
          <span className="note">Move this take to the {navigator.userAgent.includes("Mac") ? "Trash" : "Recycle Bin"}?</span>
          <Button variant="danger" size="sm" onClick={del}>Delete</Button>
          <Button size="sm" onClick={() => setConfirm(false)} autoFocus>Keep</Button>
        </div>
      ) : (
        <div className="rec-take-actions">
          <Button size="sm" disabled={running || active || !take.files.composite} title="Cut, trim and caption this take" onClick={() => openEditor(take.id)}><Scissors />Edit</Button>
          <Button size="sm" disabled={running || active || !take.files.composite} title="Choose a frame, a format and the quality" onClick={() => openExport(take.id)}>Export</Button>
          <Button variant="ghost" size="sm" title={lastVideo ? "Show the newest export in its folder" : "Open the take's folder"} onClick={() => api.revealTake(take.id, lastVideo ?? take.files.outputs?.[0])}>Show</Button>
          <Button variant="ghost" size="icon-sm" className="rec-del" disabled={running || active} onClick={() => setConfirm(true)} title="Delete this take" aria-label="Delete"><Trash /></Button>
        </div>
      )}
    </li>
  );
}

function FolderBar() {
  const view = useShell((s) => s.view);
  const recording = useRecord((s) => s.status !== "idle");
  if (!view) return null;
  const r = view.recordings;
  if (r.state !== "ok") {
    return (
      <Card className="card-danger">
        <p className="note note-danger">{r.state === "missing" ? `Your recordings folder ${shortPath(r.path)} is not available. Is its drive plugged in?` : `OpenTake cannot save in ${shortPath(r.path)}.`}</p>
        <p className="note">Recording stays off until the folder is back or you choose another one.</p>
        <div className="wrap">
          <Button size="sm" onClick={async () => { applyChoice(await shellApi.chooseRecordings()); void refreshTakes(); }} disabled={recording}>Choose another folder</Button>
          {!r.isDefault && <Button size="sm" variant="ghost" disabled={recording} onClick={async () => { applyChoice(await shellApi.useRecordings("default")); void refreshTakes(); }}>Use the standard folder</Button>}
          <Button size="sm" variant="ghost" onClick={async () => { await refreshSettings(); void refreshTakes(); }}>Check again</Button>
        </div>
      </Card>
    );
  }
  return (
    <div className="tk-folder">
      <span className="tk-folder-mark" aria-hidden><FolderOpen /></span>
      <div className="tk-folder-text">
        <span className="label">Saved in{r.freeBytes != null && <span className="tnum"> · {freeLabel(r.freeBytes)}</span>}</span>
        <span className="set-path" title={r.path}>{shortPath(r.path, 46)}</span>
      </div>
      <div className="tk-folder-actions">
        <Button variant="ghost" size="icon-sm" onClick={() => void shellApi.openFolder("recordings")} title="Open the recordings folder" aria-label="Open the recordings folder"><FolderOpen /></Button>
        <Button variant="ghost" size="icon-sm" onClick={() => goTo("settings")} title="Change where takes and exports are saved" aria-label="Folder settings"><Settings2 /></Button>
      </div>
    </div>
  );
}

export function TakesPanel() {
  const takes = useRecord((s) => s.takes);
  const recording = useRecord((s) => s.status !== "idle");
  const view = useShell((s) => s.view);
  const [query, setQuery] = useState("");
  // the folder may have changed, or files moved while the app was away
  useEffect(() => { void refreshTakes(); void refreshSettings(); }, [view?.settings.recordingsDir]);
  if (!hasBridge()) return <div className="cards"><Card><p className="note">Takes need the desktop app.</p></Card></div>;
  const q = query.trim().toLowerCase();
  const shown = q ? takes.filter((t) => `${t.title ?? ""} ${fmtDate(t.createdAt)} ${MODE_LABEL[t.mode]}`.toLowerCase().includes(q)) : takes;
  return (
    <div className="cards">
      <FolderBar />
      {takes.length > 5 && (
        <label className="tk-search">
          <Search aria-hidden />
          <input className="input" type="search" placeholder="Find a take by title or date" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find a take" />
        </label>
      )}
      {takes.length === 0 ? (
        <div className="empty">
          <CircleDot aria-hidden />
          <b>No takes yet</b>
          <p className="note">Press Record, or {navigator.userAgent.includes("Mac") ? "Cmd" : "Ctrl"}+Shift+R from any app. Each take lands here, ready to edit and export.</p>
          {!recording && <Button size="sm" onClick={() => goTo("record")}>Go to Record</Button>}
        </div>
      ) : (
        <Card>
          {shown.length === 0 ? <p className="note">No take matches "{query}".</p> : (
            <ul className="rec-takes">{shown.map((t) => <TakeRow key={t.id} take={t} />)}</ul>
          )}
        </Card>
      )}
    </div>
  );
}
