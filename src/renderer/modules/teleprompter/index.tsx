// OWNED BY: teleprompter agent. The sidebar panel that controls the prompter, plus the in-window overlay.
import { useEffect, useMemo, useRef, useState } from "react";
import { IPC } from "@shared/ipc";
import type { PrompterState } from "@shared/types";
import { onMicLevel, usePrompterController } from "./controller";
import { keyCommand, readingSeconds, sentenceAt, WPM_MAX, WPM_MIN } from "./prompter-core";
import { snapRect, type Snap } from "./overlay-core";
import { hidePrompter, parsedFor, prompterShown, showPrompter, usePrompter } from "./store";
import { ChevronLeft, ChevronRight, ExternalLink, FileText, Pause, Play, Plus, SkipBack, Trash } from "lucide-react";
import { Button, Card, Field, Hint, Segmented, Slider, Switch } from "../../ui";
import { num, t } from "@shared/i18n";
import { rich } from "../../i18n";
import "./teleprompter.css";

export { PrompterOverlay } from "./Overlay";
export { PrompterToggle, linkPrompterToRecorder } from "./record-link";

// keys, not words: the labels are read at render time so a language switch shows at once
const MODES = [
  { id: "manual", label: "prompter.mode.manual", hint: "prompter.mode.manual.hint" },
  { id: "voice-paced", label: "prompter.mode.voicePaced", hint: "prompter.mode.voicePaced.hint" },
  { id: "voice-tracked", label: "prompter.mode.voiceTracked", hint: "prompter.mode.voiceTracked.hint" },
] as const satisfies readonly { id: PrompterState["mode"]; label: string; hint: string }[];

const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

export function TeleprompterPanel() {
  usePrompterController();
  const root = useRef<HTMLDivElement>(null);
  const s = usePrompter((x) => x.state);
  const settings = usePrompter((x) => x.settings);
  const scripts = usePrompter((x) => x.scripts);
  const currentId = usePrompter((x) => x.currentId);
  const windowOpen = usePrompter((x) => x.windowOpen);
  const shown = usePrompter(prompterShown);
  const popped = settings.display === "window";
  const shortcutsFailed = usePrompter((x) => x.shortcutsFailed);
  const heard = usePrompter((x) => x.heard);
  const { patch, setSettings, command, setScript, newScript, loadScript, deleteScript } = usePrompter.getState();
  const parsed = parsedFor(s);
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState("");

  const words = parsed.words.length;
  const notes = useMemo(() => parsed.paragraphs.reduce((n, p) => n + p.items.filter((i) => i.type === "note").length, 0), [parsed]);
  const sentence = words ? sentenceAt(parsed, s.position) + 1 : 0;

  // keys while this panel is on screen and nothing is being typed
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!root.current || root.current.offsetParent === null) return;
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      const cmd = keyCommand(e);
      if (!cmd) return;
      e.preventDefault();
      command(cmd);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [command]);

  const openFile = async (file: File) => {
    setFileError("");
    if (file.size > 2_000_000) { setFileError(t("prompter.fileTooBig")); return; }
    try {
      newScript();
      setScript(await file.text());
    } catch {
      setFileError(t("prompter.fileUnreadable"));
    }
  };

  const snapWindow = (where: "top-center" | "center") => void window.take.invoke(IPC.prompterWindow, { ...settings.window, snap: where });
  const snapOverlay = (where: Snap) => {
    setSettings({ overlay: snapRect(where, { w: window.innerWidth, h: window.innerHeight }) });
    showPrompter("overlay");
  };


  return (
    <div className="cards tp-panel" ref={root}>
      <section className="card">
        <div className="tp-head">
          <Button variant={shown ? "outline" : "ink"} className="tp-grow" onClick={() => (shown ? hidePrompter() : showPrompter())}>
            {shown ? t("prompter.hide") : t("prompter.show")}
          </Button>
          <Button onClick={() => showPrompter(popped ? "overlay" : "window")}
            title={popped ? t("prompter.backInAppHint") : t("prompter.popOutHint")}>
            {popped ? t("prompter.backInApp") : <><ExternalLink />{t("prompter.popOut")}</>}
          </Button>
        </div>
        <div className="row">
          <span className="row-label tp-place">{t("prompter.place")}{!popped && <Hint text={t("prompter.placeHint")} />}</span>
          <div className="tp-snaps">
            {popped ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => snapWindow("top-center")} disabled={!windowOpen} title={t("prompter.underWebcamHint")}>{t("prompter.underWebcam")}</Button>
                <Button size="sm" variant="ghost" onClick={() => snapWindow("center")} disabled={!windowOpen}>{t("prompter.snap.center")}</Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => snapOverlay("top")} title={t("prompter.snap.topHint")}>{t("prompter.snap.top")}</Button>
                <Button size="sm" variant="ghost" onClick={() => snapOverlay("center")}>{t("prompter.snap.center")}</Button>
                <Button size="sm" variant="ghost" onClick={() => snapOverlay("left")}>{t("prompter.snap.left")}</Button>
                <Button size="sm" variant="ghost" onClick={() => snapOverlay("right")}>{t("prompter.snap.right")}</Button>
              </>
            )}
          </div>
        </div>
        <div className="tp-transport">
          <Button size="icon" variant="ghost" onClick={() => command({ type: "restart" })} title={t("prompter.restartHint")} aria-label={t("prompter.restart")}><SkipBack /></Button>
          <Button size="icon" variant="ghost" onClick={() => command({ type: "prev-sentence" })} title={t("prompter.prevSentenceHint")} aria-label={t("prompter.prevSentence")}><ChevronLeft /></Button>
          <Button variant="ink" className="tp-play" onClick={() => command({ type: "toggle" })} title={t("prompter.playPauseHint")} disabled={!words}>
            {s.playing ? <><Pause />{t("prompter.pause")}</> : <><Play />{t("prompter.start")}</>}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => command({ type: "next-sentence" })} title={t("prompter.nextSentenceHint")} aria-label={t("prompter.nextSentence")}><ChevronRight /></Button>
        </div>
        <div className="tp-progress">
          <div className="progress"><div style={{ width: `${words ? (Math.min(s.position, words) / words) * 100 : 0}%` }} /></div>
          <span className="tnum">{words ? t("prompter.sentenceOf", { n: num(sentence), total: num(parsed.sentences.length) }) : t("prompter.noScript")}</span>
        </div>
      </section>

      <Card title={t("card.scroll")}>
        <Segmented fill label={t("prompter.scrollMode")} value={s.mode} onChange={(mode) => patch({ mode })}
          options={MODES.map((m) => ({ value: m.id, label: t(m.label), hint: t(m.hint) }))} />
        <p className="note">{t(MODES.find((m) => m.id === s.mode)?.hint ?? MODES[0].hint)}</p>
        {s.mode !== "voice-tracked" && (
          <Slider label={t("prompter.speed")} value={s.wpm} min={WPM_MIN} max={WPM_MAX} step={5} format={(v) => t("prompter.wpm", { wpm: num(v) })} onChange={(wpm) => patch({ wpm })} />
        )}
        {s.mode !== "manual" && <VoiceStatusView />}
        {s.mode === "voice-paced" && (
          <Slider label={t("prompter.voiceSensitivity")} value={24 - settings.vadMargin} min={6} max={18} step={1} format={(v) => (v < 10 ? t("prompter.low") : v > 14 ? t("prompter.high") : t("prompter.medium"))}
            onChange={(v) => setSettings({ vadMargin: 24 - v })} />
        )}
        {s.mode === "voice-tracked" && (
          <>
            <Field label={t("prompter.language")} inline>
              <select className="select" value={settings.langChoice} onChange={(e) => setSettings({ langChoice: e.target.value as typeof settings.langChoice })}>
                <option value="auto">{t("prompter.lang.auto", { lang: s.lang === "es" ? t("prompter.lang.es") : t("prompter.lang.en") })}</option>
                <option value="en">{t("prompter.lang.en")}</option>
                <option value="es">{t("prompter.lang.es")}</option>
              </select>
            </Field>
            <Switch label={t("prompter.scriptWordsOnly")} hint={t("prompter.scriptWordsOnlyHint")} checked={settings.scriptWordsOnly} onChange={(v) => setSettings({ scriptWordsOnly: v })} />
            <div className="tp-heard" title={t("prompter.heardHint")}>{heard || t("prompter.waitingVoice")}</div>
          </>
        )}
        <Field label={t("prompter.countdown")} inline>
          <select className="select" value={settings.countdownSec} onChange={(e) => setSettings({ countdownSec: Number(e.target.value) })}>
            <option value={0}>{t("prompter.countdown.none")}</option>
            <option value={3}>{t("prompter.countdown.seconds", { count: 3 })}</option>
            <option value={5}>{t("prompter.countdown.seconds", { count: 5 })}</option>
          </select>
        </Field>
      </Card>

      <Card title={t("card.script")} hint={t("prompter.scriptHint")}
        action={<>
          <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()} title={t("prompter.openHint")}><FileText />{t("prompter.open")}</Button>
          <Button variant="ghost" size="sm" onClick={newScript}><Plus />{t("prompter.new")}</Button>
        </>}>
        <input ref={fileInput} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = ""; }} />
        {scripts.length > 0 && (
          <div className="tp-head">
            <select className="select tp-grow" value={currentId ?? ""} onChange={(e) => e.target.value && loadScript(e.target.value)} aria-label={t("prompter.savedScripts")}>
              {!currentId && <option value="">{t("prompter.unsaved")}</option>}
              {scripts.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
            {currentId && <Button size="icon" variant="ghost" className="tp-del" onClick={() => deleteScript(currentId)} title={t("prompter.delete")} aria-label={t("prompter.delete")}><Trash /></Button>}
          </div>
        )}
        <textarea className="textarea tp-script" value={s.script} spellCheck={false}
          placeholder={t("prompter.placeholder")}
          onChange={(e) => setScript(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); void openFile(f); } }} />
        {fileError && <p className="note note-danger">{fileError}</p>}
        <p className="note tnum">
          {t("prompter.words", { count: words })}{notes ? `, ${t("prompter.notes", { count: notes })}` : ""}, {t("prompter.about", { time: fmt(readingSeconds(parsed, s.wpm)), wpm: num(s.wpm) })}
        </p>
        <Switch label={t("prompter.showNotes")} checked={s.showNotes} onChange={(v) => patch({ showNotes: v })} />
        <Switch label={t("prompter.showOnRecord")} hint={t("prompter.showOnRecordHint")} checked={settings.showOnRecord} onChange={(v) => setSettings({ showOnRecord: v })} />
      </Card>

      <Card title={t("card.look")}>
        <Slider label={t("prompter.textSize")} value={s.fontSize} min={24} max={140} step={2} format={(v) => `${num(v)} px`} onChange={(fontSize) => patch({ fontSize })} />
        <Slider label={t("prompter.lineWidth")} value={s.lineWidth} min={35} max={100} step={1} format={(v) => num(v / 100, { style: "percent" })} onChange={(lineWidth) => patch({ lineWidth })} />
        <Slider label={t("prompter.readingLine")} value={Math.round(s.guide * 100)} min={10} max={60} step={1} format={(v) => t("prompter.readingLineValue", { value: num(v / 100, { style: "percent" }) })} onChange={(v) => patch({ guide: v / 100 })} />
        <Switch label={t("prompter.mirror")} hint={t("prompter.mirrorHint")} checked={s.mirrored} onChange={(v) => patch({ mirrored: v })} />
      </Card>

      <Card title={popped ? t("card.popOut") : t("card.overlay")}
        hint={popped ? undefined : t("prompter.overlayHint")}>
        <Slider label={t("prompter.opacity")} value={Math.round(settings.window.opacity * 100)} min={20} max={100} step={5} format={(v) => num(v / 100, { style: "percent" })}
          onChange={(v) => setSettings({ window: { ...settings.window, opacity: v / 100 } })} />
        {popped && (
          <>
            <Switch label={t("prompter.clickThrough")} hint={t("prompter.clickThroughHint")} checked={settings.window.clickThrough}
              onChange={(v) => setSettings({ window: { ...settings.window, clickThrough: v } })} />
            <Switch label={t("prompter.hideFromCapture")} checked={settings.window.hideFromCapture}
              onChange={(v) => setSettings({ window: { ...settings.window, hideFromCapture: v } })} />
          </>
        )}
      </Card>

      <Card title={t("card.keys")} hint={t("prompter.keysHint")}>
        <ul className="tp-keys">
          <li><span><kbd>{t("prompter.key.space")}</kbd></span>{t("prompter.keys.playPause")}</li>
          <li><span><kbd>{t("prompter.key.up")}</kbd> <kbd>{t("prompter.key.down")}</kbd></span>{t("prompter.keys.speed")}</li>
          <li><span><kbd>{t("prompter.key.left")}</kbd> <kbd>{t("prompter.key.right")}</kbd></span>{t("prompter.keys.sentence")}</li>
          <li><span><kbd>{t("prompter.key.home")}</kbd></span>{t("prompter.keys.restart")}</li>
        </ul>
        <p className="note">{rich(popped ? t("prompter.keys.anywhereClick", { keys: "{keys}", clickKeys: "{clickKeys}" }) : t("prompter.keys.anywhere", { keys: "{keys}" }), {
          keys: <><kbd>Ctrl</kbd> <kbd>Alt</kbd></>,
          clickKeys: <><kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>T</kbd></>,
        })}</p>
        {shortcutsFailed.length > 0 && <p className="note note-danger">{t("prompter.keys.taken", { keys: shortcutsFailed.join(", ") })}</p>}
      </Card>
    </div>
  );
}

function VoiceStatusView() {
  const voice = usePrompter((x) => x.voice);
  const mode = usePrompter((x) => x.state.mode);
  const windowOpen = usePrompter((x) => x.windowOpen);
  const playing = usePrompter((x) => x.state.playing);
  const meter = useRef<HTMLDivElement>(null);
  useEffect(() => onMicLevel((db, speaking) => {
    const el = meter.current;
    if (!el) return;
    el.style.setProperty("--level", String(Math.max(0, Math.min(1, (db + 70) / 60))));
    el.classList.toggle("speaking", speaking);
  }), []);
  const mic = t(({ off: windowOpen || playing ? "prompter.mic.starting" : "prompter.mic.startsWith", processed: "prompter.mic.processed", own: "prompter.mic.own", error: "prompter.mic.error" } as const)[voice.mic]);
  const rec = mode === "voice-tracked"
    ? { off: "", loading: t("prompter.rec.loading"), ready: t("prompter.rec.ready"), error: t("prompter.rec.error") }[voice.recognizer]
    : "";
  return (
    <div className="tp-voice">
      <div className="tp-meter" ref={meter}><div /></div>
      <div className="note">{mic}{rec ? `. ${rec}` : ""}{voice.message ? `. ${voice.message}` : ""}</div>
    </div>
  );
}
