// OWNED BY: ux. The Settings tab: where takes are recorded, where exports go and what they are called,
// what happens after an export, and the way back to the first-run setup and the shortcuts.
import { useEffect, useState } from "react";
import { FolderOpen, FolderX, Keyboard, RotateCcw, Sparkles } from "lucide-react";
import type { AfterExport, AppSettings, ExportDestination, FolderStatus } from "@shared/types";
import { t, type PlainKey as Key } from "@shared/i18n";
import { rich } from "../../i18n";
import { Button, Card, Hint, Segmented, Tag } from "../../ui";
import { DEFAULT_NAME_TEMPLATE, NAME_TOKENS, renderName, shortPath } from "../../../main/settings-core";
import { useRecord } from "../record/store";
import { applyChoice, freeLabel, refreshSettings, setLanguage, shellApi, useShell } from "./store";
import "./shell.css";

function FolderLine({ f }: { f: FolderStatus }) {
  return (
    <div className="set-well">
    <span className="set-folder-mark" aria-hidden>{f.state === "ok" ? <FolderOpen /> : <FolderX />}</span>
    <div className="set-folder">
      <span className="set-path" title={f.path}>{shortPath(f.path)}</span>
      <span className="set-meta tnum">
        {f.state === "missing" ? <Tag tone="danger">{t("set.notAvailable")}</Tag> : f.state === "readonly" ? <Tag tone="danger">{t("set.readonly")}</Tag> : null}
        {f.state === "ok" && f.freeBytes != null && <span>{freeLabel(f.freeBytes)}</span>}
        {f.takes != null && f.state !== "missing" && <span>{t("set.takes", { count: f.takes })}</span>}
      </span>
    </div>
    </div>
  );
}

function RecordingsCard() {
  const view = useShell((s) => s.view);
  const folderError = useShell((s) => s.folderError);
  const recording = useRecord((s) => s.status !== "idle");
  if (!view) return null;
  const r = view.recordings;
  const change = async () => applyChoice(await shellApi.chooseRecordings());
  const open = async () => { const err = await shellApi.openFolder("recordings"); if (err) useShell.getState().set({ folderError: err }); };
  return (
    <Card title={t("card.recordingsFolder")} hint={t("set.rec.hint")}>
      <FolderLine f={r} />
      {r.state === "missing" && <p className="note note-danger">{t("set.rec.missing")}</p>}
      {r.state === "readonly" && <p className="note note-danger">{t("set.rec.readonly")}</p>}
      {folderError && <p className="note note-danger" role="alert">{folderError}</p>}
      {recording && <p className="note">{t("set.rec.busy")}</p>}
      <div className="wrap">
        <Button size="sm" onClick={change} disabled={recording}><FolderOpen />{t("set.changeFolder")}</Button>
        {r.state === "missing" ? <Button size="sm" variant="ghost" onClick={() => void refreshSettings()}>{t("set.checkAgain")}</Button>
          : <Button size="sm" variant="ghost" onClick={open}>{t("set.open")}</Button>}
        {!r.isDefault && <Button size="sm" variant="ghost" disabled={recording} onClick={async () => applyChoice(await shellApi.useRecordings("default"))}>{t("set.useStandard")}</Button>}
      </div>
      {view.past.length > 0 && (
        <div className="set-past">
          <span className="label">{t("set.past")} <Hint text={t("set.past.hint")} /></span>
          {view.past.map((p) => (
            <div key={p.path} className="set-past-row">
              <FolderLine f={p} />
              <div className="wrap">
                <Button size="sm" variant="ghost" disabled={p.state !== "ok"} onClick={() => void shellApi.openFolder(p.index ?? -1)}>{t("set.open")}</Button>
                <Button size="sm" variant="ghost" disabled={p.state !== "ok" || recording} onClick={async () => applyChoice(await shellApi.useRecordings(p.index ?? -1))}>{t("set.recordHere")}</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const destinations = () => (["take", "folder", "ask"] as const).map((value: ExportDestination) => ({ value, label: t(`set.dest.${value}`), hint: t(`set.dest.${value}.hint`) }));
const afterOptions = () => (["reveal", "open", "nothing"] as const).map((value: AfterExport) => ({ value, label: t(`set.after.${value}`), hint: t(`set.after.${value}.hint`) }));
const TOKEN_MEANS: Record<string, Key> = { "{date}": "set.token.date", "{time}": "set.token.time", "{title}": "set.token.title", "{preset}": "set.token.preset" };
const means = (token: string) => (TOKEN_MEANS[token] ? t(TOKEN_MEANS[token]) : NAME_TOKENS.find((n) => n.token === token)?.means ?? "");

function ExportsCard() {
  const view = useShell((s) => s.view);
  const folderError = useShell((s) => s.folderError);
  const [draft, setDraft] = useState<string | null>(null);
  if (!view) return null;
  const s = view.settings;
  const template = draft ?? s.nameTemplate;
  const save = async (p: Parameters<typeof shellApi.set>[0]) => useShell.getState().set({ view: await shellApi.set(p) });
  const commitTemplate = async () => {
    if (draft == null) return;
    const v = draft.trim() || DEFAULT_NAME_TEMPLATE;
    setDraft(null);
    if (v !== s.nameTemplate) await save({ nameTemplate: v });
  };
  const insert = (token: string) => setDraft(`${template.trimEnd()} ${token}`.trimStart());
  const example = renderName(template, { createdAt: Date.now(), title: t("set.exampleTitle"), preset: "reels" });
  const exampleBare = renderName(template, { createdAt: Date.now() });
  const setDestination = async (d: ExportDestination) => {
    if (d === "folder" && !s.exportDir) return applyChoice(await shellApi.chooseExportDir());
    await save({ exportDestination: d });
  };
  return (
    <Card title={t("card.exports")} hint={t("set.exp.hint")}>
      <div className="stack">
        <span className="label">{t("set.exp.save")}</span>
        <Segmented fill value={s.exportDestination} options={destinations()} onChange={(d) => void setDestination(d)} label={t("set.exp.save")} />
        {s.exportDestination === "folder" && view.exportFolder && (
          <>
            <FolderLine f={view.exportFolder} />
            {view.exportFolder.state === "missing" && <p className="note note-danger">{t("set.exp.missing")}</p>}
            <div className="wrap">
              <Button size="sm" onClick={async () => applyChoice(await shellApi.chooseExportDir())}><FolderOpen />{t("set.changeFolder")}</Button>
              <Button size="sm" variant="ghost" disabled={view.exportFolder.state !== "ok"} onClick={() => void shellApi.openFolder("export")}>{t("set.open")}</Button>
            </div>
          </>
        )}
        {folderError && s.exportDestination === "folder" && <p className="note note-danger">{folderError}</p>}
      </div>

      <label className="stack">
        <span className="label">{t("set.names")} <Hint text={NAME_TOKENS.map((n) => `${n.token} ${means(n.token)}`).join(". ")} /></span>
        <input className="input" value={template} spellCheck={false} maxLength={120} aria-label={t("set.names.aria")}
          onChange={(e) => setDraft(e.target.value)} onBlur={() => void commitTemplate()}
          onKeyDown={(e) => { if (e.key === "Enter") void commitTemplate(); if (e.key === "Escape") setDraft(null); }} />
      </label>
      <div className="set-tokens">
        {NAME_TOKENS.map((n) => (
          <button key={n.token} type="button" className="set-token" title={t("set.token.adds", { means: means(n.token) })} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(n.token)}>{n.token}</button>
        ))}
        {template !== DEFAULT_NAME_TEMPLATE && <Button variant="link" className="set-reset" onClick={async () => { setDraft(null); await save({ nameTemplate: DEFAULT_NAME_TEMPLATE }); }}>{t("set.reset")}</Button>}
      </div>
      <p className="note set-example">{rich(t("set.example", { named: "{named}", bare: "{bare}" }), { named: <b>{example}.mp4</b>, bare: <b>{exampleBare}.mp4</b> })}</p>
      {draft != null && draft !== s.nameTemplate && <p className="note">{t("set.pressEnter")}</p>}

      <div className="stack">
        <span className="label">{t("set.after")}</span>
        <Segmented fill value={s.afterExport} options={afterOptions()} onChange={(afterExport) => void save({ afterExport })} label={t("set.after")} />
      </div>
    </Card>
  );
}

/** English, Español or the system's language; every window switches at once. */
export function LanguageSwitch({ label }: { label?: string }) {
  const view = useShell((s) => s.view);
  const value: AppSettings["language"] = view?.settings.language ?? "system";
  const options = (["system", "en", "es"] as const).map((v) => ({ value: v, label: t(`set.lang.${v}`) }));
  return <Segmented fill value={value} options={options} label={label ?? t("card.language")} onChange={(language) => void setLanguage(language)} />;
}

function LanguageCard() {
  return (
    <Card title={t("card.language")} hint={t("set.lang.hint")}>
      <LanguageSwitch />
    </Card>
  );
}

function HelpCard() {
  const dismissed = useShell((s) => s.dismissed);
  const set = useShell((s) => s.set);
  return (
    <Card title={t("card.help")}>
      <div className="set-help">
        <Button size="sm" onClick={() => set({ setupOpen: true })}><Sparkles />{t("set.help.setup")}</Button>
        <Button size="sm" onClick={() => set({ shortcutsOpen: true })}><Keyboard />{t("set.help.shortcuts")}</Button>
        {dismissed.length > 0 && <Button size="sm" variant="ghost" onClick={() => set({ dismissed: [] })}><RotateCcw />{t("set.help.tips")}</Button>}
      </div>
    </Card>
  );
}

export function SettingsPanel() {
  useEffect(() => { void refreshSettings(); }, []);
  const view = useShell((s) => s.view);
  if (!view) return <div className="cards"><Card><p className="note">{t("set.needsApp")}</p></Card></div>;
  return (
    <div className="cards">
      <RecordingsCard />
      <ExportsCard />
      <LanguageCard />
      <HelpCard />
    </div>
  );
}
