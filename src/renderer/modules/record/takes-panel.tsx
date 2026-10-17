// The Takes tab: every take in the recordings folder, newest first, with its title, exports and the
// actions people reach for after recording (edit, export, show, rename, delete).
import { useEffect, useRef, useState } from "react";
import { CircleDot, FolderOpen, Monitor, Pencil, PictureInPicture2, Scissors, Search, Settings2, Trash, Video, X } from "lucide-react";
import { IPC } from "@shared/ipc";
import type { RecordMode, TakeInfo } from "@shared/types";
import { bytes, dateTime, t } from "@shared/i18n";
import { Button, Card, Tag } from "../../ui";
import { shortPath } from "../../../main/settings-core";
import { openEditor, openExport } from "../editor";
import { OpenInEditor } from "../assistant";
import { applyChoice, dismiss, freeLabel, goTo, refreshSettings, shellApi, useShell } from "../shell/store";
import { takeSuggestion } from "../shell/suggestions-core";
import { api, hasBridge } from "./api";
import { formatClock } from "./layout-core";
import { refreshTakes } from "./recorder";
import { useRecord } from "./store";

const fmtSize = (b: number) => bytes(Math.max(0.1 * 1024 ** 2, b));
const fmtDate = (ms: number) => dateTime(ms);
const modeLabel = (m: RecordMode) => (m === "camera" ? t("takes.mode.camera") : m === "screen-camera" ? t("takes.mode.screenCamera") : t("takes.mode.screen"));
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const isVideo = (p: string) => /\.(mp4|webm|gif)$/i.test(p);

function TitleEditor({ take, onDone }: { take: TakeInfo; onDone: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const save = async () => {
    const v = ref.current?.value ?? "";
    onDone();
    if (v.trim() === (take.title ?? "")) return;
    try { await shellApi.rename(take.id, v); } catch (e) { useRecord.getState().set({ error: t("takes.renameFailed", { reason: e instanceof Error ? e.message : String(e) }) }); }
    void refreshTakes();
  };
  return (
    <input ref={ref} className="input tk-title-input" defaultValue={take.title ?? ""} placeholder={t("takes.namePlaceholder")} maxLength={80} aria-label={t("takes.titleLabel")}
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
    try { await api.deleteTake(take.id); } catch (e) { useRecord.getState().set({ error: t("takes.deleteFailed", { reason: e instanceof Error ? e.message : String(e) }) }); }
    setConfirm(false);
    void refreshTakes();
  };
  return (
    <li className={active ? "rec-take live" : "rec-take"}>
      <div className="tk-row">
        <TakeThumb take={take} active={active} />
        <div className="tk-main">
          {renaming ? <TitleEditor take={take} onDone={() => setRenaming(false)} /> : (
            <button type="button" className="tk-title" onClick={() => setRenaming(true)} title={t("takes.renameTitle")} disabled={active}>
              <b>{take.title || fmtDate(take.createdAt)}</b>{!active && <Pencil aria-hidden />}
            </button>
          )}
          <span className="tk-meta tnum">
            {take.title ? `${fmtDate(take.createdAt)} · ` : ""}{active ? `${t("takes.recordingNow")} · ` : take.durationMs == null ? `${t("takes.lengthUnknown")} · ` : ""}{modeLabel(take.mode)} · {fmtSize(take.sizeBytes)}
          </span>
          <div className="rec-take-tags">
          {active && <Tag tone="rec">{t("takes.tag.recording")}</Tag>}
          {!active && (take.recovered || take.status === "recording") && <Tag tone="warn" title={t("takes.tag.recoveredTitle")}>{t("takes.tag.recovered")}</Tag>}
          {take.files.edit && <Tag title={t("takes.tag.editedTitle")}>{t("takes.tag.edited")}</Tag>}
          {take.files.captions && <Tag title={t("takes.tag.captionsTitle")}>{t("takes.tag.captions")}</Tag>}
          {exportsCount > 0 && <Tag tone="good" title={t("takes.tag.exportedTitle", { count: exportsCount })}>{t("takes.tag.exported")}</Tag>}
          </div>
        </div>
      </div>
      {running && (
        <div className="rec-progress" aria-live="polite">
          <div className="progress"><i style={{ width: progress.ratio == null ? "100%" : `${Math.round(progress.ratio * 100)}%` }} className={progress.ratio == null ? "indet" : ""} /></div>
          <span className="tnum">{progress.stage}{progress.ratio != null ? ` ${Math.round(progress.ratio * 100)}%` : ""}</span>
          <Button variant="ghost" size="sm" onClick={() => api.cancelExport(take.id)}>{t("record.cancel")}</Button>
        </div>
      )}
      {progress?.error && (
        <div className="tk-msg danger" role="alert">
          <span>{progress.error}</span>
          {/Settings|Ajustes/.test(progress.error) && <Button size="sm" variant="ghost" onClick={() => goTo("settings")}>{t("record.msg.openSettings")}</Button>}
        </div>
      )}
      {progress?.done && !progress.error && progress.output && (
        <p className="note tk-msg" title={progress.output}>{t("takes.saved")} <b>{fileName(progress.output)}</b></p>
      )}
      {!progress?.output && lastVideo && !running && (
        <p className="note tk-last" title={lastVideo}>{t("takes.lastExport", { file: fileName(lastVideo) })}</p>
      )}
      {tip && !active && (
        <div className="tip">
          <span>{tip.text}</span>
          <div className="tip-actions">
            <Button size="sm" onClick={() => openEditor(take.id)}>{tip.action?.label}</Button>
            <Button size="icon-sm" variant="ghost" onClick={() => dismiss(tip.id)} title={t("record.dontSuggest")} aria-label={t("record.dismiss")}><X /></Button>
          </div>
        </div>
      )}
      {confirm ? (
        <div className="rec-take-actions">
          <span className="note">{navigator.userAgent.includes("Mac") ? t("takes.confirmTrash") : t("takes.confirmBin")}</span>
          <Button variant="danger" size="sm" onClick={del}>{t("takes.delete")}</Button>
          <Button size="sm" onClick={() => setConfirm(false)} autoFocus>{t("takes.keep")}</Button>
        </div>
      ) : (
        <div className="rec-take-actions">
          <Button size="sm" disabled={running || active || !take.files.composite} title={t("takes.editTitle")} onClick={() => openEditor(take.id)}><Scissors />{t("takes.edit")}</Button>
          <Button size="sm" disabled={running || active || !take.files.composite} title={t("takes.exportTitle")} onClick={() => openExport(take.id)}>{t("takes.export")}</Button>
          <OpenInEditor take={take} compact />
          <Button variant="ghost" size="sm" title={lastVideo ? t("takes.showExportTitle") : t("takes.showFolderTitle")} onClick={() => api.revealTake(take.id, lastVideo ?? take.files.outputs?.[0])}>{t("takes.show")}</Button>
          <Button variant="ghost" size="icon-sm" className="rec-del" disabled={running || active} onClick={() => setConfirm(true)} title={t("takes.deleteTitle")} aria-label={t("takes.delete")}><Trash /></Button>
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
        <p className="note note-danger">{r.state === "missing" ? t("takes.folder.missing", { path: shortPath(r.path) }) : t("takes.folder.readonly", { path: shortPath(r.path) })}</p>
        <p className="note">{t("takes.folder.off")}</p>
        <div className="wrap">
          <Button size="sm" onClick={async () => { applyChoice(await shellApi.chooseRecordings()); void refreshTakes(); }} disabled={recording}>{t("takes.folder.chooseAnother")}</Button>
          {!r.isDefault && <Button size="sm" variant="ghost" disabled={recording} onClick={async () => { applyChoice(await shellApi.useRecordings("default")); void refreshTakes(); }}>{t("takes.folder.standard")}</Button>}
          <Button size="sm" variant="ghost" onClick={async () => { await refreshSettings(); void refreshTakes(); }}>{t("takes.folder.checkAgain")}</Button>
        </div>
      </Card>
    );
  }
  return (
    <div className="tk-folder">
      <span className="tk-folder-mark" aria-hidden><FolderOpen /></span>
      <div className="tk-folder-text">
        <span className="label">{t("takes.folder.savedIn")}{r.freeBytes != null && <span className="tnum"> · {freeLabel(r.freeBytes)}</span>}</span>
        <span className="set-path" title={r.path}>{shortPath(r.path, 46)}</span>
      </div>
      <div className="tk-folder-actions">
        <Button variant="ghost" size="icon-sm" onClick={() => void shellApi.openFolder("recordings")} title={t("takes.folder.open")} aria-label={t("takes.folder.open")}><FolderOpen /></Button>
        <Button variant="ghost" size="icon-sm" onClick={() => goTo("settings")} title={t("takes.folder.changeTitle")} aria-label={t("takes.folder.settings")}><Settings2 /></Button>
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
  if (!hasBridge()) return <div className="cards"><Card><p className="note">{t("takes.needsApp")}</p></Card></div>;
  const q = query.trim().toLowerCase();
  const shown = q ? takes.filter((k) => `${k.title ?? ""} ${fmtDate(k.createdAt)} ${modeLabel(k.mode)}`.toLowerCase().includes(q)) : takes;
  return (
    <div className="cards">
      <FolderBar />
      {takes.length > 5 && (
        <label className="tk-search">
          <Search aria-hidden />
          <input className="input" type="search" placeholder={t("takes.findPlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("takes.find")} />
        </label>
      )}
      {takes.length === 0 ? (
        <div className="empty">
          <CircleDot aria-hidden />
          <b>{t("takes.empty")}</b>
          <p className="note">{t("takes.emptyNote", { mod: navigator.userAgent.includes("Mac") ? "Cmd" : "Ctrl" })}</p>
          {!recording && <Button size="sm" onClick={() => goTo("record")}>{t("takes.goRecord")}</Button>}
        </div>
      ) : (
        <Card>
          {shown.length === 0 ? <p className="note">{t("takes.noMatch", { query })}</p> : (
            <ul className="rec-takes">{shown.map((k) => <TakeRow key={k.id} take={k} />)}</ul>
          )}
        </Card>
      )}
    </div>
  );
}
