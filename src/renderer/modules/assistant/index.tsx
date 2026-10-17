// The assistant in the window: the Settings card that connects Claude or Codex (with the activity list
// and Undo), the "Open in an editor" button, and the listener that refreshes takes the assistant changed.
import { useCallback, useEffect, useState } from "react";
import { Check, Clapperboard, Copy, PlugZap, RotateCcw, Undo2 } from "lucide-react";
import type { AssistantStatus } from "@shared/assistant";
import type { TakeInfo } from "@shared/types";
import { dateTime, t, type Key } from "@shared/i18n";
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
      <Button size="sm" variant="ghost" onClick={copy} title={t("as.copy")}>{done ? <Check /> : <Copy />}{done ? t("as.copied") : t("as.copy")}</Button>
    </div>
  );
}

const toolName = (tool: string) => { const k = `as.tool.${tool}` as Key; const s = t(k as "as.tool.cut_ranges"); return s === k ? tool : s; };
/** an Electron IPC error as the plain line under it */
const plain = (e: unknown) => (e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") : String(e));

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
        <span className="label">{t("as.activity")}</span>
        <Button size="sm" variant="ghost" onClick={load} title={t("as.refreshTitle")}><RotateCcw />{t("as.refresh")}</Button>
      </div>
      {note && <p className="note">{note}</p>}
      {!shown.length ? <p className="note">{t("as.empty")}</p> : (
        <ul className="as-list">
          {shown.map((e) => (
            <li key={e.id} className="as-item">
              <span className="as-time tnum">{dateTime(e.at)}</span>
              <span className="as-tool">{toolName(e.tool)}</span>
              <span className="as-summary" title={e.takeId ? t("as.takeTitle", { take: e.takeId }) : undefined}>{e.summary}</span>
              {!e.ok && <Tag tone="danger">{t("as.failed")}</Tag>}
              {e.undoneAt ? <Tag>{t("as.undone")}</Tag> : e.undoable ? <Button size="sm" variant="ghost" onClick={() => void undo(e)} title={t("as.undoTitle")}><Undo2 />{t("as.undo")}</Button> : null}
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
    <Card title={t("card.assistant")} hint={t("as.hint")}>
      <p className="note">{t("as.intro")}</p>
      {s.warning && <p className="note note-warn">{s.warning}</p>}

      <div className="as-block">
        <div className="as-row">
          <span className="label">{t("as.claudeDesktop")}</span>
          {configured && <Tag tone="good">{t("as.isSetUp")}</Tag>}
        </div>
        <div className="as-row">
          <Button size="sm" variant={configured ? "outline" : "ink"} disabled={busy} onClick={async () => {
            setBusy(true);
            const r = await assistantApi.setupClaude().catch((e) => ({ ok: false, message: plain(e), backup: undefined }));
            setSetup(r.ok && r.backup ? `${r.message} ${t("ma.setup.backup", { path: r.backup })}` : r.message);
            setBusy(false);
            load();
          }}><PlugZap />{configured ? t("as.setUpAgain") : t("as.setUp")}</Button>
          <span className="note as-path" title={s.claudeDesktop[0]?.path}>{t("as.setUpNote")}</span>
        </div>
        {setup && <p className="note">{setup}</p>}
      </div>

      <div className="as-block">
        <span className="label">{t("as.claudeCode")}</span>
        <CopyBlock label={t("as.claudeCodeAria")} text={s.claudeCode} />
      </div>

      <div className="as-block">
        <span className="label">{t("as.codex")}</span>
        <span className="note as-path">{t("as.codexAddTo", { path: s.codexPath })}</span>
        <CopyBlock label={t("as.codexAria")} text={s.codex} />
      </div>

      <div className="as-row">
        <Button size="sm" disabled={busy} onClick={async () => { setBusy(true); setTest(null); setTest(await assistantApi.test().catch((e) => ({ ok: false, message: plain(e) }))); setBusy(false); }}><Check />{t("as.test")}</Button>
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
      setMsg([t("oe.saved", { file: r.otio.split(/[\\/]/).pop() ?? "" }), ...r.notes].join(". "));
      void refreshTakes();
    } catch (e) {
      setMsg(plain(e));
    }
    setBusy(false);
  };
  if (compact) {
    return (
      <Button variant="ghost" size="icon-sm" disabled={busy || !take.files.composite} aria-label={t("oe.title")} title={msg ?? t("oe.iconTitle")}
        onClick={() => void run({ layout: "composite", compatibleMedia: false })}><Clapperboard /></Button>
    );
  }
  return (
    <div className="as-editor">
      <span className="label">{t("oe.title")}</span>
      <span className="note">{t("oe.text")}</span>
      {separate && <Segmented value={layout} onChange={setLayout} options={[{ value: "composite", label: t("oe.asRecorded") }, { value: "separate", label: t("oe.separate"), hint: t("oe.separateHint") }]} label={t("oe.tracksAria")} />}
      <Switch label={t("oe.mp4")} checked={compatible} onChange={setCompatible} hint={t("oe.mp4Hint")} />
      <div className="as-row">
        <Button size="sm" disabled={busy || !take.files.composite} onClick={() => void run({ layout, compatibleMedia: compatible })}><Clapperboard />{busy ? t("oe.writing") : t("oe.write")}</Button>
        {msg && <span className="note">{msg}</span>}
      </div>
    </div>
  );
}
