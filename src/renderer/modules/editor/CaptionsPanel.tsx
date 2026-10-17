// The editor's captions: make them from the take's sound, then fix words, split, merge and nudge lines.
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Merge, Scissors, Trash2 } from "lucide-react";
import type { CaptionLang, CaptionLine } from "@shared/types";
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

const LANGS = [{ value: "en" as const, label: "English" }, { value: "es" as const, label: "Español" }];

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
        <span className="row-label">Language</span>
        <Segmented value={p.lang} options={LANGS} onChange={p.onLang} disabled={!!p.busy} />
      </div>
      {p.busy ? (
        <div className="rec-progress">
          <div className="progress"><i style={{ width: p.busy.ratio == null ? "100%" : `${Math.round(p.busy.ratio * 100)}%` }} className={p.busy.ratio == null ? "indet" : ""} /></div>
          <span className="tnum">{p.busy.stage}{p.busy.ratio != null ? ` ${Math.round(p.busy.ratio * 100)}%` : ""}</span>
          <Button variant="ghost" size="sm" onClick={p.onStop}>Stop</Button>
        </div>
      ) : (
        <Button variant="ink" block disabled={!p.hasAudio} onClick={() => { setRedo(false); p.onMake(); }}
          title={p.hasAudio ? undefined : "This take has no sound"}>{p.lines ? "Make them again" : "Make captions"}</Button>
      )}
    </>
  );

  return (
    <Card title="Captions" hint="Speech recognition runs on your computer with the teleprompter's speech models. Nothing leaves your machine."
      action={p.lines && !p.busy && (
        <Button variant="ghost" size="sm" onClick={() => setRedo((v) => !v)}>{redo ? "Cancel" : "Remake"}</Button>
      )}>
      {p.error && <p className="note note-danger">{p.error}</p>}
      {(!p.lines || redo || p.busy) && making}
      {redo && !p.busy && <p className="note">Making them again replaces every fix you made.</p>}

      {p.lines && !p.busy && (
        <>
          <div className="ed-lines" ref={list}>
            {p.lines.length === 0 && <p className="note">No speech was found in this take.</p>}
            {p.lines.map((l, i) => <LineRow key={l.id} line={l} i={i} lines={p.lines!} active={i === p.active} onChange={p.onChange} onSeek={p.onSeek} />)}
          </div>
          <div className="stack ed-look">
            <div className="row">
              <span className="row-label">Style <Hint text="How burned-in captions look. The preview over the video shows the same." /></span>
              <Segmented value={look.style} onChange={(style) => set({ captionLook: { ...useEditor.getState().captionLook, style } })}
                options={[{ value: "clean", label: "Clean", hint: "White with a soft shadow" }, { value: "boxed", label: "Boxed", hint: "White on a dark box" }, { value: "social", label: "Social", hint: "Big bold words, the spoken one highlighted" }]} />
            </div>
            <div className="row">
              <span className="row-label">Position</span>
              <Segmented value={look.position} onChange={(position) => set({ captionLook: { ...useEditor.getState().captionLook, position } })}
                options={[{ value: "bottom", label: "Bottom" }, { value: "top", label: "Top" }]} />
            </div>
            <div className="row">
              <span className="row-label">Margin</span>
              <Segmented value={look.margin} onChange={(margin) => set({ captionLook: { ...useEditor.getState().captionLook, margin } })}
                options={[{ value: 0.04, label: "Small" }, { value: 0.08, label: "Medium" }, { value: 0.16, label: "Large", hint: "Clear of the buttons on Reels and TikTok" }]} />
            </div>
            {!p.canBurn && <p className="note note-warn">This copy of ffmpeg cannot burn captions into the video. The .srt and .vtt files still work.</p>}
          </div>
          <div className="row">
            <Button size="sm" onClick={p.onSaveFiles} disabled={!p.lines.length} title="Saves take.srt and take.vtt in the take folder, timed to your cuts"><FileText />Save .srt and .vtt</Button>
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
      <button type="button" className="ed-line-time tnum" onClick={() => onSeek(line.start)} title="Play from here">{formatTime(line.start)}</button>
      <textarea ref={box} key={text} className="ed-line-text" defaultValue={text} rows={1} spellCheck
        onFocus={() => onSeek(line.start)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") { e.preventDefault(); commit(); box.current?.blur(); }
          if (e.key === "Escape") { e.currentTarget.value = text; box.current?.blur(); }
        }} />
      <div className="ed-line-tools">
        <Button variant="ghost" size="icon-sm" title="Split at the cursor" aria-label="Split at the cursor"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const at = wordIndexAtCaret(box.current?.value ?? text, box.current?.selectionStart ?? 0);
            onChange(splitLine(lines, i, at));
          }}><Scissors /></Button>
        <Button variant="ghost" size="icon-sm" title="Join with the next line" aria-label="Join with the next line" disabled={i === lines.length - 1}
          onClick={() => onChange(mergeWithNext(lines, i))}><Merge /></Button>
        <Button variant="ghost" size="icon-sm" title="0.1 s earlier" aria-label="Earlier" onClick={() => replace(shiftLine(line, -100))}><ChevronLeft /></Button>
        <Button variant="ghost" size="icon-sm" title="0.1 s later" aria-label="Later" onClick={() => replace(shiftLine(line, 100))}><ChevronRight /></Button>
        <Button variant="ghost" size="icon-sm" className="rec-del" title="Remove this line" aria-label="Remove this line" onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 /></Button>
      </div>
    </div>
  );
}
