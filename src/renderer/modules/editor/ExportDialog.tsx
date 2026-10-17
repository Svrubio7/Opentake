// The export dialog: a frame preset, the format, quality or a file size, captions and sound.
import { useEffect } from "react";
import { X } from "lucide-react";
import type { ExportFormat, ExportPreset, TakeInfo } from "@shared/types";
import { Button, Field, Hint, NumberField, Segmented, Switch } from "../../ui";
import { PRESETS, exportFileName, exportWarnings, resolveFrame } from "../../../main/record/export-core";
import { presetWords, renderName, shortPath } from "../../../main/settings-core";
import { dismiss, goTo, useShell } from "../shell/store";
import { exportSuggestion } from "../shell/suggestions-core";
import { exportTake } from "../record/recorder";
import { useRecord } from "../record/store";
import { outputFrom, useEditor } from "./store";
import { OpenInEditor } from "../assistant";

const PRESET_ORDER: ExportPreset[] = ["original", "youtube", "vertical", "square", "linkedin", "x", "custom"];
const QUALITY = [
  { value: 18, label: "Best", hint: "Near the original (CRF 18)" },
  { value: 23, label: "Good", hint: "Smaller file, hard to tell apart (CRF 23)" },
  { value: 28, label: "Small", hint: "For sharing quickly (CRF 28)" },
];

export function ExportDialog({ take, onClose }: { take: TakeInfo; onClose: () => void }) {
  const prefs = useEditor();
  const loudness = useRecord((s) => s.loudness);
  const trimSilence = useRecord((s) => s.trimSilence);
  const setRecord = useRecord((s) => s.set);
  const o = prefs.output;
  // from the store, not this render: two quick clicks must not undo each other
  const setOut = (p: Partial<typeof o>) => prefs.set({ output: { ...useEditor.getState().output, ...p } });
  const hasCaptions = !!take.files.captions;
  // a take that switches scenes has no single layout to re-render at hi-res
  const hiresOk = !!take.files.screen && !take.sceneChanges;
  const kind = prefs.kind === "hires" && hiresOk ? "hires" : "composite";
  const output = outputFrom(prefs, hasCaptions);
  const frame = resolveFrame(output, { width: 1920, height: 1080 });
  // the name and place main will use (it adds a number if the name is taken)
  const settings = useShell((s) => s.view?.settings ?? null);
  const dismissed = useShell((s) => s.dismissed);
  const stem = settings ? renderName(settings.nameTemplate, { createdAt: take.createdAt, title: take.title, preset: presetWords(exportFileName(kind, output, frame)) }) : null;
  const name = stem ? `${stem}.${o.format}` : exportFileName(kind, output, frame);
  const where = !settings ? null : settings.exportDestination === "ask" ? "ask" : settings.exportDestination === "folder" && settings.exportDir ? settings.exportDir : take.dir;
  const tip = exportSuggestion(take.frame, o.preset, new Set(dismissed));
  const warnings = exportWarnings(output, take.durationMs != null ? take.durationMs / 1000 : null);
  const gif = o.format === "gif";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const start = () => {
    onClose();
    void exportTake(take.id, kind, output, true);
  };

  return (
    <div className="modal-scrim ed-modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal ed-export" role="dialog" aria-label="Export">
        <div className="row">
          <h2 className="modal-title">Export</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close"><X /></Button>
        </div>

        {take.files.screen && (
          <div className="row">
            <span className="row-label">Picture <Hint text={take.sceneChanges ? "This take switches scenes. Hi-res follows one layout, so it exports as recorded." : `Hi-res re-renders the screen at its native resolution with the zoom redone from your clicks.${take.overlays ? " The logo, name card, keys and cards are not redrawn in it." : ""}`} /></span>
            <Segmented value={kind} onChange={(k) => prefs.set({ kind: k })}
              options={[{ value: "composite", label: "As recorded" }, { value: "hires", label: "Hi-res screen", disabled: !hiresOk }]} />
          </div>
        )}

        <div className="stack">
          <span className="label">Frame</span>
          <div className="ed-presets">
            {PRESET_ORDER.map((id) => (
              <button key={id} type="button" className={o.preset === id ? "ed-preset on" : "ed-preset"} onClick={() => setOut({ preset: id })} title={PRESETS[id].hint}
                aria-label={PRESETS[id].label} aria-pressed={o.preset === id}>
                <b>{PRESETS[id].label}</b>
                <span>{PRESETS[id].size ? `${PRESETS[id].size!.width} × ${PRESETS[id].size!.height}` : id === "original" ? "As recorded" : "Your size"}</span>
              </button>
            ))}
          </div>
          {o.preset === "custom" && (
            <div className="ed-pair">
              <NumberField label="Width" value={o.width ?? 1920} min={16} max={4096} step={2} suffix="px" onCommit={(width) => setOut({ width })} />
              <NumberField label="Height" value={o.height ?? 1080} min={16} max={4096} step={2} suffix="px" onCommit={(height) => setOut({ height })} />
            </div>
          )}
          {tip && (
            <div className="tip">
              <span>{tip.text}</span>
              <div className="tip-actions">
                <Button size="sm" onClick={() => setOut({ preset: "vertical", fit: "fill" })}>{tip.action?.label}</Button>
                <Button size="icon-sm" variant="ghost" onClick={() => dismiss(tip.id)} title="Do not suggest this again" aria-label="Dismiss"><X /></Button>
              </div>
            </div>
          )}
          {o.preset !== "original" && (
            <div className="row">
              <span className="row-label">Other shapes <Hint text="When the take's shape differs from the frame: fit it whole with bars, or fill the frame and crop the edges." /></span>
              <Segmented value={o.fit} onChange={(fit) => setOut({ fit })} options={[{ value: "fit", label: "Fit with bars" }, { value: "fill", label: "Fill and crop" }]} />
            </div>
          )}
        </div>

        <div className="ed-grid">
          <div className="row">
            <span className="row-label">Format</span>
            <Segmented<ExportFormat> value={o.format} onChange={(format) => setOut({ format })}
              options={[{ value: "mp4", label: "MP4", hint: "Plays everywhere (H.264 and AAC)" }, { value: "webm", label: "WebM", hint: "Smaller for the web (VP9 and Opus)" }, { value: "gif", label: "GIF", hint: "A silent loop" }]} />
          </div>
          {gif ? (
            <>
              <div className="row">
                <span className="row-label">Frame rate</span>
                <Segmented value={o.gif?.fps ?? 15} onChange={(fps) => setOut({ gif: { width: o.gif?.width ?? 480, fps } })}
                  options={[10, 15, 24].map((v) => ({ value: v, label: `${v} fps` }))} />
              </div>
              <div className="row">
                <span className="row-label">Width</span>
                <Segmented value={o.gif?.width ?? 480} onChange={(width) => setOut({ gif: { fps: o.gif?.fps ?? 15, width } })}
                  options={[320, 480, 640, 800].map((v) => ({ value: v, label: `${v}` }))} />
              </div>
            </>
          ) : (
            <>
              <div className="row">
                <span className="row-label">Size by <Hint text="Quality keeps the look and lets the size follow. A file size runs two passes to land on it." /></span>
                <Segmented value={o.quality.mode} onChange={(mode) => setOut({ quality: mode === "crf" ? { mode, crf: 18 } : { mode, mb: o.preset === "x" ? 500 : 50 } })}
                  options={[{ value: "crf", label: "Quality" }, { value: "size", label: "File size" }]} />
              </div>
              {o.quality.mode === "crf" ? (
                <div className="row">
                  <span className="row-label">Quality</span>
                  <Segmented value={o.quality.crf} onChange={(crf) => setOut({ quality: { mode: "crf", crf } })} options={QUALITY} />
                </div>
              ) : (
                <NumberField label="Target size" value={o.quality.mb} min={1} max={4000} suffix="MB" onCommit={(mb) => setOut({ quality: { mode: "size", mb } })} />
              )}
            </>
          )}
        </div>

        <div className="ed-grid">
          <Switch label="Burn in captions" checked={prefs.burnCaptions && hasCaptions} disabled={!hasCaptions}
            hint={hasCaptions ? "Draws the captions into the picture with the style set in the editor" : "Make captions in the editor first"}
            onChange={(burnCaptions) => prefs.set({ burnCaptions })} />
          {prefs.burnCaptions && hasCaptions && (
            <div className="row">
              <span className="row-label">Style</span>
              <Segmented value={prefs.captionLook.style} onChange={(style) => prefs.set({ captionLook: { ...useEditor.getState().captionLook, style } })}
                options={[{ value: "clean", label: "Clean" }, { value: "boxed", label: "Boxed" }, { value: "social", label: "Social" }]} />
            </div>
          )}
          {!gif && (
            <Field label="Loudness" inline>
              <select className="select" value={loudness} onChange={(e) => setRecord({ loudness: e.target.value as typeof loudness })}>
                <option value="off">As recorded</option>
                <option value="-14">-14 LUFS (social)</option>
                <option value="-16">-16 LUFS (podcast, YouTube)</option>
              </select>
            </Field>
          )}
          <Switch label="Trim silence at start and end" checked={trimSilence} onChange={(v) => setRecord({ trimSilence: v })}
            hint={take.files.edit ? "With cuts, the silence is trimmed from the start and end of the edited result" : undefined} />
        </div>

        <OpenInEditor take={take} />
        {warnings.map((w) => <p key={w} className="note note-warn">{w}</p>)}
        <div className="ed-export-foot">
          <span className="note ed-export-where">
            {where === "ask" ? <>You choose where to save <b className="ed-file">{name}</b></> : <>Saves <b className="ed-file">{name}</b>{where ? <> to <span title={where}>{where === take.dir ? "the take's folder" : shortPath(where, 32)}</span></> : null}</>}
            {take.files.edit ? " with your cuts" : ""}{hasCaptions && !gif ? ", plus matching .srt and .vtt" : ""}.{" "}
            <button type="button" className="btn-link ed-where-link" onClick={() => { onClose(); goTo("settings"); }}>Change</button>
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="ink" onClick={start}>Export</Button>
        </div>
      </div>
    </div>
  );
}
