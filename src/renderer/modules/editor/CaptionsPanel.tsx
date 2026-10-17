// The editor's captions: make them from the take's sound, then fix words, split, merge and nudge lines.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Merge, Scissors, Trash2 } from "lucide-react";
import type { CaptionLang, CaptionLine } from "@shared/types";
import { t } from "@shared/i18n";
import { Button, Card, Hint, Segmented } from "../../ui";
import { lineText, mergeWithNext, retext, shiftLine, splitLine, wordIndexAtCaret } from "./captions-core";
import { formatTime } from "./edit-core";
import { useEditor } from "./store";

export interface CaptionsPanelProps {
  lines: CaptionLine[] | null;
  lang: CaptionLang;
  active: number;
  busy: { stage: string; ratio: number | null } | null;
  error: string | null;
  hasAudio: boolean;
  canBurn: boolean;
  onLang: (l: CaptionLang) => void;
  onMake: () => void;
  onStop: () => void;
  onChange: (lines: CaptionLine[]) => void;
  onSeek: (ms: number) => void;
  onSaveFiles: () => void;
  filesNote: string | null;
}

// the speech's language, named in its own language
const langs = () => [{ value: "en" as const, label: t("editor.captions.langEn") }, { value: "es" as const, label: t("editor.captions.langEs") }];

export function CaptionsPanel(p: CaptionsPanelProps) {
  const look = useEditor((s) => s.captionLook);
  const set = useEditor((s) => s.set);
  const list = useRef<HTMLDivElement>(null);
  const [redo, setRedo] = useState(false);

  // the line being spoken scrolls into view, unless you are typing in one
  useEffect(() => {
    const el = list.current?.querySelector<HTMLElement>(`[data-i="${p.active}"]`);
    if (!el || list.current?.contains(document.activeElement)) return;
    el.scrollIntoView({ block: "nearest" });
  }, [p.active]);

  const making = (
    <>
      <div className="row">
        <span className="row-label">{t("editor.captions.language")}</span>
        <Segmented value={p.lang} options={langs()} onChange={p.onLang} disabled={!!p.busy} />
      </div>
      {p.busy ? (
        <div className="rec-progress">
          <div className="progress"><i style={{ width: p.busy.ratio == null ? "100%" : `${Math.round(p.busy.ratio * 100)}%` }} className={p.busy.ratio == null ? "indet" : ""} /></div>
          <span className="tnum">{p.busy.stage}{p.busy.ratio != null ? ` ${Math.round(p.busy.ratio * 100)}%` : ""}</span>
          <Button variant="ghost" size="sm" onClick={p.onStop}>{t("editor.captions.stop")}</Button>
        </div>
      ) : (
        <Button variant="ink" block disabled={!p.hasAudio} onClick={() => { setRedo(false); p.onMake(); }}
          title={p.hasAudio ? undefined : t("editor.captions.noSound")}>{p.lines ? t("editor.captions.makeAgain") : t("editor.captions.make")}</Button>
      )}
    </>
  );

  return (
    <Card title={t("editor.captions.title")} hint={t("editor.captions.hint")}
      action={p.lines && !p.busy && (
        <Button variant="ghost" size="sm" onClick={() => setRedo((v) => !v)}>{redo ? t("editor.captions.cancel") : t("editor.captions.remake")}</Button>
      )}>
      {p.error && <p className="note note-danger">{p.error}</p>}
      {(!p.lines || redo || p.busy) && making}
      {redo && !p.busy && <p className="note">{t("editor.captions.replaceWarning")}</p>}

      {p.lines && !p.busy && (
        <>
          <div className="ed-lines" ref={list}>
            {p.lines.length === 0 && <p className="note">{t("editor.captions.noSpeech")}</p>}
            {p.lines.map((l, i) => <LineRow key={l.id} line={l} i={i} lines={p.lines!} active={i === p.active} onChange={p.onChange} onSeek={p.onSeek} />)}
          </div>
          <div className="stack ed-look">
            <div className="row">
              <span className="row-label">{t("editor.captions.style")} <Hint text={t("editor.captions.styleHint")} /></span>
              <Segmented value={look.style} onChange={(style) => set({ captionLook: { ...useEditor.getState().captionLook, style } })}
                options={[{ value: "clean", label: t("editor.captions.clean"), hint: t("editor.captions.cleanHint") }, { value: "boxed", label: t("editor.captions.boxed"), hint: t("editor.captions.boxedHint") }, { value: "social", label: t("editor.captions.social"), hint: t("editor.captions.socialHint") }]} />
            </div>
            <div className="row">
              <span className="row-label">{t("editor.captions.position")}</span>
              <Segmented value={look.position} onChange={(position) => set({ captionLook: { ...useEditor.getState().captionLook, position } })}
                options={[{ value: "bottom", label: t("editor.captions.bottom") }, { value: "top", label: t("editor.captions.top") }]} />
            </div>
            <div className="row">
              <span className="row-label">{t("editor.captions.margin")}</span>
              <Segmented value={look.margin} onChange={(margin) => set({ captionLook: { ...useEditor.getState().captionLook, margin } })}
                options={[{ value: 0.04, label: t("editor.captions.small") }, { value: 0.08, label: t("editor.captions.medium") }, { value: 0.16, label: t("editor.captions.large"), hint: t("editor.captions.largeHint") }]} />
            </div>
            {!p.canBurn && <p className="note note-warn">{t("editor.captions.cantBurn")}</p>}
          </div>
          <div className="row">
            <Button size="sm" onClick={p.onSaveFiles} disabled={!p.lines.length} title={t("editor.captions.saveFilesTitle")}><FileText />{t("editor.captions.saveFiles")}</Button>
            {p.filesNote && <span className="note">{p.filesNote}</span>}
          </div>
        </>
      )}
    </Card>
  );
}

function LineRow({ line, i, lines, active, onChange, onSeek }: { line: CaptionLine; i: number; lines: CaptionLine[]; active: boolean; onChange: (l: CaptionLine[]) => void; onSeek: (ms: number) => void }) {
  const text = lineText(line);
  const box = useRef<HTMLTextAreaElement>(null);
  const replace = (l: CaptionLine) => onChange(lines.map((x, j) => (j === i ? l : x)));
  const commit = () => {
    const v = box.current?.value.replace(/\s+/g, " ").trim() ?? text;
    if (v === text) return;
    if (!v) onChange(lines.filter((_, j) => j !== i));
    else replace(retext(line, v));
  };
  return (
    <div className={active ? "ed-line on" : "ed-line"} data-i={i}>
      <button type="button" className="ed-line-time tnum" onClick={() => onSeek(line.start)} title={t("editor.captions.playFromHere")}>{formatTime(line.start)}</button>
      <textarea ref={box} key={text} className="ed-line-text" defaultValue={text} rows={1} spellCheck
        onFocus={() => onSeek(line.start)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); commit(); box.current?.blur(); }
          if (e.key === "Escape") { e.currentTarget.value = text; box.current?.blur(); }
        }} />
      <div className="ed-line-tools">
        <Button variant="ghost" size="icon-sm" title={t("editor.captions.splitAtCursor")} aria-label={t("editor.captions.splitAtCursor")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const at = wordIndexAtCaret(box.current?.value ?? text, box.current?.selectionStart ?? 0);
            onChange(splitLine(lines, i, at));
          }}><Scissors /></Button>
        <Button variant="ghost" size="icon-sm" title={t("editor.captions.join")} aria-label={t("editor.captions.join")} disabled={i === lines.length - 1}
          onClick={() => onChange(mergeWithNext(lines, i))}><Merge /></Button>
        <Button variant="ghost" size="icon-sm" title={t("editor.captions.earlierTitle")} aria-label={t("editor.captions.earlier")} onClick={() => replace(shiftLine(line, -100))}><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" title={t("editor.captions.laterTitle")} aria-label={t("editor.captions.later")} onClick={() => replace(shiftLine(line, 100))}><ChevronRight /></Button>
        <Button variant="ghost" size="icon-sm" className="rec-del" title={t("editor.captions.remove")} aria-label={t("editor.captions.remove")} onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
      </div>
    </div>
  );
}
