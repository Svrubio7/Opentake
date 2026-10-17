// The export dialog: a frame preset, the format, quality or a file size, captions and sound.
import { Fragment, useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import type { ExportFormat, ExportPreset, TakeInfo } from "@shared/types";
import { t } from "@shared/i18n";
import { Button, Field, Hint, NumberField, Segmented, Switch } from "../../ui";
import { PRESETS, exportFileName, exportWarnings, resolveFrame } from "../../../main/record/export-core";
import { presetWords, renderName, shortPath } from "../../../main/settings-core";
import { dismiss, goTo, useShell } from "../shell/store";
import { exportSuggestion } from "../shell/suggestions-core";
import { exportTake } from "../record/recorder";
import { useRecord } from "../record/store";
import { outputFrom, useEditor } from "./store";

const PRESET_ORDER: ExportPreset[] = ["original", "youtube", "vertical", "square", "linkedin", "x", "custom"];
const quality = () => [
  { value: 18, label: t("editor.exp.best"), hint: t("editor.exp.bestHint") },
  { value: 23, label: t("editor.exp.good"), hint: t("editor.exp.goodHint") },
  { value: 28, label: t("editor.exp.small"), hint: t("editor.exp.smallHint") },
];

/** placeholders left in place for rich() to fill with markup */
const KEEP = { name: "{name}", place: "{place}" };

/** A translated sentence with parts of it in markup: {name} in the text becomes parts.name. */
function rich(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((bit, i) => {
    const k = /^\{(\w+)\}$/.exec(bit)?.[1];
    return <Fragment key={i}>{k && k in parts ? parts[k] : bit}</Fragment>;
  });
}

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
      <div className="modal ed-export" role="dialog" aria-label={t("editor.exp.title")}>
        <div className="row">
          <h2 className="modal-title">{t("editor.exp.title")}</h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t("editor.exp.close")}><X /></Button>
        </div>

        {take.files.screen && (
          <div className="row">
            <span className="row-label">{t("editor.exp.picture")} <Hint text={take.sceneChanges ? t("editor.exp.hiresScenes") : take.overlays ? t("editor.exp.hiresHintOverlays") : t("editor.exp.hiresHint")} /></span>
            <Segmented value={kind} onChange={(k) => prefs.set({ kind: k })}
              options={[{ value: "composite", label: t("editor.exp.asRecorded") }, { value: "hires", label: t("editor.exp.hiresScreen"), disabled: !hiresOk }]} />
          </div>
        )}

        <div className="stack">
          <span className="label">{t("editor.exp.frame")}</span>
          <div className="ed-presets">
            {PRESET_ORDER.map((id) => (
              <button key={id} type="button" className={o.preset === id ? "ed-preset on" : "ed-preset"} onClick={() => setOut({ preset: id })} title={PRESETS[id].hint}
                aria-label={PRESETS[id].label} aria-pressed={o.preset === id}>
                <b>{PRESETS[id].label}</b>
                <span>{PRESETS[id].size ? `${PRESETS[id].size!.width} × ${PRESETS[id].size!.height}` : id === "original" ? t("editor.exp.asRecorded") : t("editor.exp.yourSize")}</span>
              </button>
            ))}
          </div>
          {o.preset === "custom" && (
            <div className="ed-pair">
              <NumberField label={t("editor.exp.width")} value={o.width ?? 1920} min={16} max={4096} step={2} suffix="px" onCommit={(width) => setOut({ width })} />
              <NumberField label={t("editor.exp.height")} value={o.height ?? 1080} min={16} max={4096} step={2} suffix="px" onCommit={(height) => setOut({ height })} />
            </div>
          )}
          {tip && (
            <div className="tip">
              <span>{tip.text}</span>
              <div className="tip-actions">
                <Button size="sm" onClick={() => setOut({ preset: "vertical", fit: "fill" })}>{tip.action?.label}</Button>
                <Button size="icon-sm" variant="ghost" onClick={() => dismiss(tip.id)} title={t("editor.exp.dontSuggest")} aria-label={t("editor.exp.dismiss")}><X /></Button>
              </div>
            </div>
          )}
          {o.preset !== "original" && (
            <div className="row">
              <span className="row-label">{t("editor.exp.otherShapes")} <Hint text={t("editor.exp.otherShapesHint")} /></span>
              <Segmented value={o.fit} onChange={(fit) => setOut({ fit })} options={[{ value: "fit", label: t("editor.exp.fitBars") }, { value: "fill", label: t("editor.exp.fillCrop") }]} />
            </div>
          )}
        </div>

        <div className="ed-grid">
          <div className="row">
            <span className="row-label">{t("editor.exp.format")}</span>
            <Segmented<ExportFormat> value={o.format} onChange={(format) => setOut({ format })}
              options={[{ value: "mp4", label: "MP4", hint: t("editor.exp.mp4Hint") }, { value: "webm", label: "WebM", hint: t("editor.exp.webmHint") }, { value: "gif", label: "GIF", hint: t("editor.exp.gifHint") }]} />
          </div>
          {gif ? (
            <>
              <div className="row">
                <span className="row-label">{t("editor.exp.frameRate")}</span>
                <Segmented value={o.gif?.fps ?? 15} onChange={(fps) => setOut({ gif: { width: o.gif?.width ?? 480, fps } })}
                  options={[10, 15, 24].map((v) => ({ value: v, label: t("editor.exp.fps", { n: v }) }))} />
              </div>
              <div className="row">
                <span className="row-label">{t("editor.exp.width")}</span>
                <Segmented value={o.gif?.width ?? 480} onChange={(width) => setOut({ gif: { fps: o.gif?.fps ?? 15, width } })}
                  options={[320, 480, 640, 800].map((v) => ({ value: v, label: `${v}` }))} />
              </div>
            </>
          ) : (
            <>
              <div className="row">
                <span className="row-label">{t("editor.exp.sizeBy")} <Hint text={t("editor.exp.sizeByHint")} /></span>
                <Segmented value={o.quality.mode} onChange={(mode) => setOut({ quality: mode === "crf" ? { mode, crf: 18 } : { mode, mb: o.preset === "x" ? 500 : 50 } })}
                  options={[{ value: "crf", label: t("editor.exp.quality") }, { value: "size", label: t("editor.exp.fileSize") }]} />
              </div>
              {o.quality.mode === "crf" ? (
                <div className="row">
                  <span className="row-label">{t("editor.exp.quality")}</span>
                  <Segmented value={o.quality.crf} onChange={(crf) => setOut({ quality: { mode: "crf", crf } })} options={quality()} />
                </div>
              ) : (
                <NumberField label={t("editor.exp.targetSize")} value={o.quality.mb} min={1} max={4000} suffix="MB" onCommit={(mb) => setOut({ quality: { mode: "size", mb } })} />
              )}
            </>
          )}
        </div>

        <div className="ed-grid">
          <Switch label={t("editor.exp.burn")} checked={prefs.burnCaptions && hasCaptions} disabled={!hasCaptions}
            hint={hasCaptions ? t("editor.exp.burnHint") : t("editor.exp.burnNeeds")}
            onChange={(burnCaptions) => prefs.set({ burnCaptions })} />
          {prefs.burnCaptions && hasCaptions && (
            <div className="row">
              <span className="row-label">{t("editor.exp.style")}</span>
              <Segmented value={prefs.captionLook.style} onChange={(style) => prefs.set({ captionLook: { ...useEditor.getState().captionLook, style } })}
                options={[{ value: "clean", label: t("editor.captions.clean") }, { value: "boxed", label: t("editor.captions.boxed") }, { value: "social", label: t("editor.captions.social") }]} />
            </div>
          )}
          {!gif && (
            <Field label={t("editor.exp.loudness")} inline>
              <select className="select" value={loudness} onChange={(e) => setRecord({ loudness: e.target.value as typeof loudness })}>
                <option value="off">{t("editor.exp.loudOff")}</option>
                <option value="-14">{t("editor.exp.loud14")}</option>
                <option value="-16">{t("editor.exp.loud16")}</option>
              </select>
            </Field>
          )}
          <Switch label={t("editor.exp.trim")} checked={trimSilence} onChange={(v) => setRecord({ trimSilence: v })}
            hint={take.files.edit ? t("editor.exp.trimHint") : undefined} />
        </div>

        {warnings.map((w) => <p key={w} className="note note-warn">{w}</p>)}
        <div className="ed-export-foot">
          <span className="note ed-export-where">
            {rich(where === "ask" ? t("editor.exp.youChoose", KEEP) : where ? t("editor.exp.savesTo", KEEP) : t("editor.exp.saves", KEEP), {
              name: <b className="ed-file">{name}</b>,
              place: where && where !== "ask" ? <span title={where}>{where === take.dir ? t("editor.exp.takeFolder") : shortPath(where, 32)}</span> : null,
            })}
            {take.files.edit ? ` ${t("editor.exp.withCuts")}` : ""}{hasCaptions && !gif ? `, ${t("editor.exp.withSubs")}` : ""}.{" "}
            <button type="button" className="btn-link ed-where-link" onClick={() => { onClose(); goTo("settings"); }}>{t("editor.exp.change")}</button>
          </span>
          <Button onClick={onClose}>{t("editor.exp.cancel")}</Button>
          <Button variant="ink" onClick={start}>{t("editor.exp.start")}</Button>
        </div>
      </div>
    </div>
  );
}
