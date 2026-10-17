// OWNED BY: ux. The Settings tab: where takes are recorded, where exports go and what they are called,
// what happens after an export, and the way back to the first-run setup and the shortcuts.
import { useEffect, useState } from "react";
import { FolderOpen, FolderX, Keyboard, RotateCcw, Sparkles } from "lucide-react";
import type { AfterExport, ExportDestination, FolderStatus } from "@shared/types";
import { Button, Card, Hint, Segmented, Tag } from "../../ui";
import { DEFAULT_NAME_TEMPLATE, NAME_TOKENS, renderName, shortPath } from "../../../main/settings-core";
import { useRecord } from "../record/store";
import { applyChoice, freeLabel, refreshSettings, shellApi, useShell } from "./store";
import "./shell.css";

function FolderLine({ f }: { f: FolderStatus }) {
  return (
    <div className="set-well">
    <span className="set-folder-mark" aria-hidden>{f.state === "ok" ? <FolderOpen /> : <FolderX />}</span>
    <div className="set-folder">
      <span className="set-path" title={f.path}>{shortPath(f.path)}</span>
      <span className="set-meta tnum">
        {f.state === "missing" ? <Tag tone="danger">Not available</Tag> : f.state === "readonly" ? <Tag tone="danger">Cannot write here</Tag> : null}
        {f.state === "ok" && f.freeBytes != null && <span>{freeLabel(f.freeBytes)}</span>}
        {f.takes != null && f.state !== "missing" && <span>{f.takes === 1 ? "1 take" : `${f.takes} takes`}</span>}
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
    <Card title="Recordings folder" hint="Every take is saved in its own folder in here, with its tracks, cuts and captions.">
      <FolderLine f={r} />
      {r.state === "missing" && <p className="note note-danger">This folder is not available. Is its drive plugged in? Plug it in and press Check again, or record somewhere else.</p>}
      {r.state === "readonly" && <p className="note note-danger">OpenTake cannot save files in this folder. Choose another one.</p>}
      {folderError && <p className="note note-danger" role="alert">{folderError}</p>}
      {recording && <p className="note">The folder can change once this take is saved.</p>}
      <div className="wrap">
        <Button size="sm" onClick={change} disabled={recording}><FolderOpen />Change folder</Button>
        {r.state === "missing" ? <Button size="sm" variant="ghost" onClick={() => void refreshSettings()}>Check again</Button>
          : <Button size="sm" variant="ghost" onClick={open}>Open</Button>}
        {!r.isDefault && <Button size="sm" variant="ghost" disabled={recording} onClick={async () => applyChoice(await shellApi.useRecordings("default"))}>Use the standard folder</Button>}
      </div>
      {view.past.length > 0 && (
        <div className="set-past">
          <span className="label">Takes in folders you used before <Hint text="Takes stay in the folder they were recorded in. The Takes tab lists the current folder. Switch back to see the others there, or move their folders yourself." /></span>
          {view.past.map((p) => (
            <div key={p.path} className="set-past-row">
              <FolderLine f={p} />
              <div className="wrap">
                <Button size="sm" variant="ghost" disabled={p.state !== "ok"} onClick={() => void shellApi.openFolder(p.index ?? -1)}>Open</Button>
                <Button size="sm" variant="ghost" disabled={p.state !== "ok" || recording} onClick={async () => applyChoice(await shellApi.useRecordings(p.index ?? -1))}>Record here again</Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

const DESTINATIONS: { value: ExportDestination; label: string; hint: string }[] = [
  { value: "take", label: "Next to the take", hint: "In the take's own folder, with its tracks" },
  { value: "folder", label: "One folder", hint: "Every export in one folder you choose" },
  { value: "ask", label: "Ask each time", hint: "A Save dialog when you press Export. The export when you stop goes next to the take." },
];
const AFTER: { value: AfterExport; label: string; hint: string }[] = [
  { value: "reveal", label: "Show in folder", hint: "Opens the folder with the new file selected" },
  { value: "open", label: "Open the file", hint: "Plays it in your video player" },
  { value: "nothing", label: "Nothing", hint: "The takes list still shows where it went" },
];

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
  const example = renderName(template, { createdAt: Date.now(), title: "Product demo", preset: "reels" });
  const exampleBare = renderName(template, { createdAt: Date.now() });
  const setDestination = async (d: ExportDestination) => {
    if (d === "folder" && !s.exportDir) return applyChoice(await shellApi.chooseExportDir());
    await save({ exportDestination: d });
  };
  return (
    <Card title="Exports" hint="Where exported videos go and what they are called. A name that is taken gets a number, like (2): nothing is ever overwritten.">
      <div className="stack">
        <span className="label">Save exports</span>
        <Segmented fill value={s.exportDestination} options={DESTINATIONS} onChange={(d) => void setDestination(d)} label="Save exports" />
        {s.exportDestination === "folder" && view.exportFolder && (
          <>
            <FolderLine f={view.exportFolder} />
            {view.exportFolder.state === "missing" && <p className="note note-danger">This folder is not available. Exports will stop with a message until it is back or you choose another.</p>}
            <div className="wrap">
              <Button size="sm" onClick={async () => applyChoice(await shellApi.chooseExportDir())}><FolderOpen />Change folder</Button>
              <Button size="sm" variant="ghost" disabled={view.exportFolder.state !== "ok"} onClick={() => void shellApi.openFolder("export")}>Open</Button>
            </div>
          </>
        )}
        {folderError && s.exportDestination === "folder" && <p className="note note-danger">{folderError}</p>}
      </div>

      <label className="stack">
        <span className="label">File names <Hint text={NAME_TOKENS.map((t) => `${t.token} ${t.means}`).join(". ")} /></span>
        <input className="input" value={template} spellCheck={false} maxLength={120} aria-label="File name template"
          onChange={(e) => setDraft(e.target.value)} onBlur={() => void commitTemplate()}
          onKeyDown={(e) => { if (e.key === "Enter") void commitTemplate(); if (e.key === "Escape") setDraft(null); }} />
      </label>
      <div className="set-tokens">
        {NAME_TOKENS.map((t) => (
          <button key={t.token} type="button" className="set-token" title={`Adds ${t.means}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(t.token)}>{t.token}</button>
        ))}
        {template !== DEFAULT_NAME_TEMPLATE && <Button variant="link" className="set-reset" onClick={async () => { setDraft(null); await save({ nameTemplate: DEFAULT_NAME_TEMPLATE }); }}>Reset</Button>}
      </div>
      <p className="note set-example">For example <b>{example}.mp4</b>, or <b>{exampleBare}.mp4</b> for an untitled take</p>
      {draft != null && draft !== s.nameTemplate && <p className="note">Press Enter to keep it.</p>}

      <div className="stack">
        <span className="label">After an export</span>
        <Segmented fill value={s.afterExport} options={AFTER} onChange={(afterExport) => void save({ afterExport })} label="After an export" />
      </div>
    </Card>
  );
}

function HelpCard() {
  const dismissed = useShell((s) => s.dismissed);
  const set = useShell((s) => s.set);
  return (
    <Card title="Help">
      <div className="set-help">
        <Button size="sm" onClick={() => set({ setupOpen: true })}><Sparkles />Run the setup again</Button>
        <Button size="sm" onClick={() => set({ shortcutsOpen: true })}><Keyboard />Keyboard shortcuts</Button>
        {dismissed.length > 0 && <Button size="sm" variant="ghost" onClick={() => set({ dismissed: [] })}><RotateCcw />Show tips again</Button>}
      </div>
    </Card>
  );
}

export function SettingsPanel() {
  useEffect(() => { void refreshSettings(); }, []);
  const view = useShell((s) => s.view);
  if (!view) return <div className="cards"><Card><p className="note">Settings need the desktop app.</p></Card></div>;
  return (
    <div className="cards">
      <RecordingsCard />
      <ExportsCard />
      <HelpCard />
    </div>
  );
}
