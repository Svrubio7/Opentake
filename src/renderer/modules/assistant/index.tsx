// The assistant in the window: the Settings card that connects Claude or Codex (with the activity list
// and Undo), the "Open in an editor" button, and the listener that refreshes takes the assistant changed.
import { useCallback, useEffect, useState } from "react";
import { Check, Clapperboard, Copy, PlugZap, RotateCcw, Undo2 } from "lucide-react";
import type { AssistantStatus } from "@shared/assistant";
import type { TakeInfo } from "@shared/types";
import { Button, Card, Segmented, Switch, Tag } from "../../ui";
import type { ActivityEntry } from "../../../main/mcp/activity";
import { refreshTakes } from "../record/recorder";
import { assistantApi, listenForAssistant, onTakeChanged } from "./api";
import "./assistant.css";

export { onTakeChanged };

/** Mounted once: takes the assistant changed are listed again. */
export function AssistantSync() {
  useEffect(() => listenForAssistant(() => { void refreshTakes(); }), []);
  return null;
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard refused */ }
  };
  return (
    <div className="as-copy">
      <pre className="as-code" aria-label={label}>{text}</pre>
      <Button size="sm" variant="ghost" onClick={copy} title="Copy">{done ? <Check /> : <Copy />}{done ? "Copied" : "Copy"}</Button>
    </div>
  );
}

const TOOL_NAMES: Record<string, string> = {
  list_takes: "Listed takes", get_take: "Read a take", get_transcript: "Transcript", get_frame: "Looked at a frame", find_moments: "Found moments",
  set_cuts: "Set cuts", cut_ranges: "Cut", keep_ranges: "Kept parts", remove_silences: "Removed silences", remove_filler_words: "Removed fillers",
  edit_captions: "Captions", set_caption_style: "Caption style", set_title: "Title", add_chapters: "Chapters", undo_change: "Undo",
  export_take: "Export", get_job: "Checked a job", export_timeline: "Timeline", import_video: "Import",
};

function ActivityList() {
  const [list, setList] = useState<ActivityEntry[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const load = useCallback(() => { void assistantApi.activity().then(setList, () => setList([])); }, []);
  useEffect(() => { load(); return onTakeChanged(null, load); }, [load]);
  const undo = async (e: ActivityEntry) => {
    const r = await assistantApi.undo(e.id);
    setNote(r.message);
    load();
  };
  if (!list) return null;
  const shown = list.filter((e) => e.tool !== "get_job").slice(0, 20);
  return (
    <div className="as-activity">
      <div className="as-activity-head">
        <span className="label">Assistant activity</span>
        <Button size="sm" variant="ghost" onClick={load} title="Look again"><RotateCcw />Refresh</Button>
      </div>
      {note && <p className="note">{note}</p>}
      {!shown.length ? <p className="note">Nothing yet. What Claude or Codex does with your takes shows here, and edits can be undone.</p> : (
        <ul className="as-list">
          {shown.map((e) => (
            <li key={e.id} className="as-item">
              <span className="as-time tnum">{new Date(e.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span className="as-tool">{TOOL_NAMES[e.tool] ?? e.tool}</span>
              <span className="as-summary" title={e.takeId ? `Take ${e.takeId}` : undefined}>{e.summary}</span>
              {!e.ok && <Tag tone="danger">Failed</Tag>}
              {e.undoneAt ? <Tag>Undone</Tag> : e.undoable ? <Button size="sm" variant="ghost" onClick={() => void undo(e)} title="Put the take back as it was before this"><Undo2 />Undo</Button> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Settings: Use with Claude or Codex. */
export function AssistantCard() {
  const [s, setS] = useState<AssistantStatus | null>(null);
  const [setup, setSetup] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { void assistantApi.status().then(setS, () => setS(null)); }, []);
  useEffect(load, [load]);
  if (!s) return null;
  const configured = s.claudeDesktop.some((c) => c.configured);
  return (
    <Card title="Use with Claude or Codex" hint="OpenTake's assistant tools run on this computer. Claude or Codex reads your takes, cuts them, fixes captions and exports, and every change can be undone.">
      <p className="note">Ask in plain words: "cut the pauses from my last take", "fix the captions", "make a 60 second vertical cut with captions". The tools run on this computer. What the assistant reads, like a transcript or a frame, goes to it as part of your chat.</p>
      {s.warning && <p className="note note-warn">{s.warning}</p>}

      <div className="as-block">
        <div className="as-row">
          <span className="label">Claude Desktop</span>
          {configured && <Tag tone="good">Set up</Tag>}
        </div>
        <div className="as-row">
          <Button size="sm" variant={configured ? "outline" : "ink"} disabled={busy} onClick={async () => {
            setBusy(true);
            const r = await assistantApi.setupClaude();
            setSetup(r.ok ? `${r.message}${r.backup ? ` Your old config is saved as ${r.backup}.` : ""}` : r.message);
            setBusy(false);
            load();
          }}><PlugZap />{configured ? "Set up again" : "Set up Claude Desktop"}</Button>
          <span className="note as-path" title={s.claudeDesktop[0]?.path}>Adds OpenTake to claude_desktop_config.json and keeps everything else in it.</span>
        </div>
        {setup && <p className="note">{setup}</p>}
      </div>

      <div className="as-block">
        <span className="label">Claude Code</span>
        <CopyBlock label="Claude Code command" text={s.claudeCode} />
      </div>

      <div className="as-block">
        <span className="label">Codex</span>
        <span className="note">Add this to <span title={s.codexPath}>{s.codexPath}</span>:</span>
        <CopyBlock label="Codex config" text={s.codex} />
      </div>

      <div className="as-row">
        <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); setTest(null); setTest(await assistantApi.test()); setBusy(false); }}><Check />Test connection</Button>
        {test && <span className={test.ok ? "note" : "note note-warn"}>{test.message}</span>}
      </div>

      <ActivityList />
    </Card>
  );
}

/** "Open in an editor": writes the take's timeline (.otio, .fcpxml, .srt) and shows it in its folder. */
export function OpenInEditor({ take, compact }: { take: TakeInfo; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [layout, setLayout] = useState<"composite" | "separate">("composite");
  const [compatible, setCompatible] = useState(false);
  const separate = !!(take.files.screen || take.files.camera);
  const run = async (o: { layout: "composite" | "separate"; compatibleMedia: boolean }) => {
    setBusy(true); setMsg(null);
    try {
      const r = await assistantApi.timeline(take.id, { ...o, fcpxml: true });
      setMsg(`Saved ${r.otio.split(/[\\/]/).pop()}${r.notes.length ? `. ${r.notes.join(" ")}` : ""}`);
      void refreshTakes();
    } catch (e) {
      setMsg(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));
    }
    setBusy(false);
  };
  if (compact) {
    return (
      <Button variant="ghost" size="sm" disabled={busy || !take.files.composite} title="Write a timeline for FilmCraft, DaVinci Resolve, Premiere or Final Cut (.otio and .fcpxml), with your cuts and markers"
        onClick={() => void run({ layout: "composite", compatibleMedia: false })}><Clapperboard />{busy ? "Writing..." : "Open in an editor"}</Button>
    );
  }
  return (
    <div className="as-editor">
      <span className="label">Open in an editor</span>
      <span className="note">A timeline file with your cuts, clicks, scenes and captions as markers, for FilmCraft, DaVinci Resolve, Premiere or Final Cut. The media stay where they are.</span>
      {separate && <Segmented value={layout} onChange={setLayout} options={[{ value: "composite", label: "As recorded" }, { value: "separate", label: "Separate tracks", hint: "Screen, camera and computer sound on their own tracks" }]} label="Timeline tracks" />}
      <Switch label="MP4 copies for Premiere and Final Cut" checked={compatible} onChange={setCompatible} hint="They cannot read WebM. Making the copies takes a while." />
      <div className="as-row">
        <Button size="sm" disabled={busy || !take.files.composite} onClick={() => void run({ layout, compatibleMedia: compatible })}><Clapperboard />{busy ? "Writing the timeline..." : "Write the timeline"}</Button>
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}
