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
import "./teleprompter.css";

export { PrompterOverlay } from "./Overlay";
export { PrompterToggle, linkPrompterToRecorder } from "./record-link";

const MODES: { id: PrompterState["mode"]; label: string; hint: string }[] = [
  { id: "manual", label: "Manual", hint: "Scrolls at a steady speed. Space plays and pauses." },
  { id: "voice-paced", label: "Voice pace", hint: "Scrolls while you talk and waits when you pause." },
  { id: "voice-tracked", label: "Voice track", hint: "Listens to your words and follows your place in the script, offline." },
];

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
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
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
    if (file.size > 2_000_000) { setFileError("That file is too big for a script."); return; }
    try {
      newScript();
      setScript(await file.text());
    } catch {
      setFileError("Could not read that file.");
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
            {shown ? "Hide prompter" : "Show prompter"}
          </Button>
          <Button onClick={() => showPrompter(popped ? "overlay" : "window")}
            title={popped ? "Show the prompter inside this window" : "Open the prompter in its own window, always on top of every app"}>
            {popped ? "Back in the app" : <><ExternalLink />Pop out</>}
          </Button>
        </div>
        <div className="row">
          <span className="row-label tp-place">Place{!popped && <Hint text="Drag the prompter by its top bar, resize it from a corner. It is never part of the recording." />}</span>
          <div className="tp-snaps">
            {popped ? (
              <>
                <Button size="sm" variant="ghost" onClick={() => snapWindow("top-center")} disabled={!windowOpen} title="Top centre of the screen, right under the webcam, so your eyes stay near the lens">Under webcam</Button>
                <Button size="sm" variant="ghost" onClick={() => snapWindow("center")} disabled={!windowOpen}>Centre</Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => snapOverlay("top")} title="Top centre, under the webcam, so your eyes stay near the lens">Top</Button>
                <Button size="sm" variant="ghost" onClick={() => snapOverlay("center")}>Centre</Button>
                <Button size="sm" variant="ghost" onClick={() => snapOverlay("left")}>Left</Button>
                <Button size="sm" variant="ghost" onClick={() => snapOverlay("right")}>Right</Button>
              </>
            )}
          </div>
        </div>
        <div className="tp-transport">
          <Button size="icon" variant="ghost" onClick={() => command({ type: "restart" })} title="Restart (Home)" aria-label="Restart"><SkipBack /></Button>
          <Button size="icon" variant="ghost" onClick={() => command({ type: "prev-sentence" })} title="Previous sentence (Left)" aria-label="Previous sentence"><ChevronLeft /></Button>
          <Button variant="ink" className="tp-play" onClick={() => command({ type: "toggle" })} title="Play or pause (Space)" disabled={!words}>
            {s.playing ? <><Pause />Pause</> : <><Play />Start</>}
          </Button>
          <Button size="icon" variant="ghost" onClick={() => command({ type: "next-sentence" })} title="Next sentence (Right)" aria-label="Next sentence"><ChevronRight /></Button>
        </div>
        <div className="tp-progress">
          <div className="progress"><div style={{ width: `${words ? (Math.min(s.position, words) / words) * 100 : 0}%` }} /></div>
          <span className="tnum">{words ? `Sentence ${sentence} of ${parsed.sentences.length}` : "No script yet"}</span>
        </div>
      </section>

      <Card title="Scroll">
        <Segmented fill label="Scroll mode" value={s.mode} onChange={(mode) => patch({ mode })}
          options={MODES.map((m) => ({ value: m.id, label: m.label, hint: m.hint }))} />
        <p className="note">{MODES.find((m) => m.id === s.mode)?.hint}</p>
        {s.mode !== "voice-tracked" && (
          <Slider label="Speed" value={s.wpm} min={WPM_MIN} max={WPM_MAX} step={5} format={(v) => `${v} wpm`} onChange={(wpm) => patch({ wpm })} />
        )}
        {s.mode !== "manual" && <VoiceStatusView />}
        {s.mode === "voice-paced" && (
          <Slider label="Voice sensitivity" value={24 - settings.vadMargin} min={6} max={18} step={1} format={(v) => (v < 10 ? "Low" : v > 14 ? "High" : "Medium")}
            onChange={(v) => setSettings({ vadMargin: 24 - v })} />
        )}
        {s.mode === "voice-tracked" && (
          <>
            <Field label="Language" inline>
              <select className="select" value={settings.langChoice} onChange={(e) => setSettings({ langChoice: e.target.value as typeof settings.langChoice })}>
                <option value="auto">Auto ({s.lang === "es" ? "Español" : "English"})</option>
                <option value="en">English</option>
                <option value="es">Español</option>
              </select>
            </Field>
            <Switch label="Script words only" hint="Listens only for the words in your script. More accurate." checked={settings.scriptWordsOnly} onChange={(v) => setSettings({ scriptWordsOnly: v })} />
            <div className="tp-heard" title="What the recognizer heard last">{heard || "Waiting for your voice"}</div>
          </>
        )}
        <Field label="Countdown" inline>
          <select className="select" value={settings.countdownSec} onChange={(e) => setSettings({ countdownSec: Number(e.target.value) })}>
            <option value={0}>None</option>
            <option value={3}>3 seconds</option>
            <option value={5}>5 seconds</option>
          </select>
        </Field>
      </Card>

      <Card title="Script" hint="Saved on this computer. VISUAL: lines and [bracketed] notes are directions, not words to read."
        action={<>
          <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()} title="Open a .txt or .md file"><FileText />Open</Button>
          <Button variant="ghost" size="sm" onClick={newScript}><Plus />New</Button>
        </>}>
        <input ref={fileInput} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = ""; }} />
        {scripts.length > 0 && (
          <div className="tp-head">
            <select className="select tp-grow" value={currentId ?? ""} onChange={(e) => e.target.value && loadScript(e.target.value)} aria-label="Saved scripts">
              {!currentId && <option value="">Unsaved script</option>}
              {scripts.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
            {currentId && <Button size="icon" variant="ghost" className="tp-del" onClick={() => deleteScript(currentId)} title="Delete this script" aria-label="Delete this script"><Trash /></Button>}
          </div>
        )}
        <textarea className="textarea tp-script" value={s.script} spellCheck={false}
          placeholder={"Paste your script here, or open a .txt or .md file.\n\nVISUAL: lines and [bracketed] notes are directions, not words to read."}
          onChange={(e) => setScript(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); void openFile(f); } }} />
        {fileError && <p className="note note-danger">{fileError}</p>}
        <p className="note tnum">
          {words} words{notes ? `, ${notes} notes` : ""}, about {fmt(readingSeconds(parsed, s.wpm))} at {s.wpm} wpm
        </p>
        <Switch label="Show direction notes" checked={s.showNotes} onChange={(v) => patch({ showNotes: v })} />
        <Switch label="Show when I record" hint="Opens the prompter by itself when a take starts, if there is a script." checked={settings.showOnRecord} onChange={(v) => setSettings({ showOnRecord: v })} />
      </Card>

      <Card title="Look">
        <Slider label="Text size" value={s.fontSize} min={24} max={140} step={2} format={(v) => `${v} px`} onChange={(fontSize) => patch({ fontSize })} />
        <Slider label="Line width" value={s.lineWidth} min={35} max={100} step={1} format={(v) => `${v}%`} onChange={(lineWidth) => patch({ lineWidth })} />
        <Slider label="Reading line" value={Math.round(s.guide * 100)} min={10} max={60} step={1} format={(v) => `${v}% down`} onChange={(v) => patch({ guide: v / 100 })} />
        <Switch label="Mirror" hint="Flips the text for a beam-splitter glass" checked={s.mirrored} onChange={(v) => patch({ mirrored: v })} />
      </Card>

      <Card title={popped ? "Pop-out window" : "Overlay"}
        hint={popped ? undefined : "If you record the screen OpenTake itself is on, the overlay shows like the rest of OpenTake. Pop it out instead: the window hides itself from screen recordings."}>
        <Slider label="Opacity" value={Math.round(settings.window.opacity * 100)} min={20} max={100} step={5} format={(v) => `${v}%`}
          onChange={(v) => setSettings({ window: { ...settings.window, opacity: v / 100 } })} />
        {popped && (
          <>
            <Switch label="Click-through" hint="Clicks pass through the prompter to the app under it (Ctrl+Alt+T)" checked={settings.window.clickThrough}
              onChange={(v) => setSettings({ window: { ...settings.window, clickThrough: v } })} />
            <Switch label="Hide from screen recordings" checked={settings.window.hideFromCapture}
              onChange={(v) => setSettings({ window: { ...settings.window, hideFromCapture: v } })} />
          </>
        )}
      </Card>

      <Card title="Keys" hint="The mouse wheel scrolls the prompter too">
        <ul className="tp-keys">
          <li><span><kbd>Space</kbd></span>Play or pause</li>
          <li><span><kbd>Up</kbd> <kbd>Down</kbd></span>Speed</li>
          <li><span><kbd>Left</kbd> <kbd>Right</kbd></span>Sentence</li>
          <li><span><kbd>Home</kbd></span>Restart</li>
        </ul>
        <p className="note">Anywhere while it shows: <kbd>Ctrl</kbd> <kbd>Alt</kbd> with the same keys{popped ? <>, <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>T</kbd> for click-through</> : ""}.</p>
        {shortcutsFailed.length > 0 && <p className="note note-danger">Taken by another app: {shortcutsFailed.join(", ")}</p>}
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
  const mic = { off: windowOpen || playing ? "Mic starting" : "Mic starts with the prompter", processed: "Mic: processed voice", own: "Mic: default microphone", error: "Mic unavailable" }[voice.mic];
  const rec = mode === "voice-tracked"
    ? { off: "", loading: "Loading speech model (first time takes a moment)", ready: "Listening, offline", error: "Speech model failed" }[voice.recognizer]
    : "";
  return (
    <div className="tp-voice">
      <div className="tp-meter" ref={meter}><div /></div>
      <div className="note">{mic}{rec ? `. ${rec}` : ""}{voice.message ? `. ${voice.message}` : ""}</div>
    </div>
  );
}
