// OWNED BY: teleprompter agent. The sidebar panel that controls the prompter, plus the in-window overlay.
import { useEffect, useMemo, useRef, useState } from "react";
import { IPC } from "@shared/ipc";
import type { PrompterState } from "@shared/types";
import { onMicLevel, usePrompterController } from "./controller";
import { keyCommand, readingSeconds, sentenceAt, WPM_MAX, WPM_MIN } from "./prompter-core";
import { snapRect, type Snap } from "./overlay-core";
import { hidePrompter, parsedFor, prompterShown, showPrompter, usePrompter } from "./store";
import "./teleprompter.css";

export { PrompterOverlay } from "./Overlay";

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
    <div className="tp-panel" ref={root}>
      <div className="tp-row tp-head">
        <button className={shown ? "tp-primary on" : "tp-primary"} onClick={() => (shown ? hidePrompter() : showPrompter())}>
          {shown ? "Hide prompter" : "Show prompter"}
        </button>
        <button onClick={() => showPrompter(popped ? "overlay" : "window")}
          title={popped ? "Show the prompter inside this window" : "Open the prompter in its own window, always on top of every app"}>
          {popped ? "Back in the app" : "Pop out"}
        </button>
      </div>
      <div className="tp-row tp-snaps">
        <span className="tp-hint">Place</span>
        {popped ? (
          <>
            <button onClick={() => snapWindow("top-center")} disabled={!windowOpen} title="Top centre of the screen, right under the webcam, so your eyes stay near the lens">Under webcam</button>
            <button onClick={() => snapWindow("center")} disabled={!windowOpen}>Centre</button>
          </>
        ) : (
          <>
            <button onClick={() => snapOverlay("top")} title="Top centre, under the webcam, so your eyes stay near the lens">Top</button>
            <button onClick={() => snapOverlay("center")}>Centre</button>
            <button onClick={() => snapOverlay("left")}>Left</button>
            <button onClick={() => snapOverlay("right")}>Right</button>
          </>
        )}
      </div>
      {!popped && shown && <p className="tp-hint">Drag the prompter by its top bar, resize it from a corner. It is never part of the recording.</p>}

      <div className="tp-transport">
        <button onClick={() => command({ type: "restart" })} title="Restart (Home)">⏮</button>
        <button onClick={() => command({ type: "prev-sentence" })} title="Previous sentence (Left)">◀</button>
        <button className="tp-play" onClick={() => command({ type: "toggle" })} title="Play or pause (Space)" disabled={!words}>
          {s.playing ? "Pause" : "Start"}
        </button>
        <button onClick={() => command({ type: "next-sentence" })} title="Next sentence (Right)">▶</button>
      </div>
      <div className="tp-progress">
        <div className="tp-bar"><div style={{ width: `${words ? (Math.min(s.position, words) / words) * 100 : 0}%` }} /></div>
        <span>{words ? `Sentence ${sentence} of ${parsed.sentences.length}` : "No script yet"}</span>
      </div>

      <section className="tp-card">
        <div className="tp-label">Scroll</div>
        <div className="tp-seg">
          {MODES.map((m) => (
            <button key={m.id} className={s.mode === m.id ? "on" : ""} onClick={() => patch({ mode: m.id })}>{m.label}</button>
          ))}
        </div>
        <p className="tp-hint">{MODES.find((m) => m.id === s.mode)?.hint}</p>
        {s.mode !== "voice-tracked" && (
          <Slider label="Speed" value={s.wpm} min={WPM_MIN} max={WPM_MAX} step={5} unit=" wpm" onChange={(wpm) => patch({ wpm })} />
        )}
        {s.mode !== "manual" && <VoiceStatusView />}
        {s.mode === "voice-paced" && (
          <Slider label="Voice sensitivity" value={24 - settings.vadMargin} min={6} max={18} step={1} format={(v) => (v < 10 ? "Low" : v > 14 ? "High" : "Medium")}
            onChange={(v) => setSettings({ vadMargin: 24 - v })} />
        )}
        {s.mode === "voice-tracked" && (
          <>
            <div className="tp-row">
              <label className="tp-field">Language
                <select value={settings.langChoice} onChange={(e) => setSettings({ langChoice: e.target.value as typeof settings.langChoice })}>
                  <option value="auto">Auto ({s.lang === "es" ? "Español" : "English"})</option>
                  <option value="en">English</option>
                  <option value="es">Español</option>
                </select>
              </label>
            </div>
            <Toggle label="Listen for script words only (more accurate)" checked={settings.scriptWordsOnly} onChange={(v) => setSettings({ scriptWordsOnly: v })} />
            <div className="tp-heard" title="What the recognizer heard last">{heard || "Waiting for your voice"}</div>
          </>
        )}
        <label className="tp-field">Countdown
          <select value={settings.countdownSec} onChange={(e) => setSettings({ countdownSec: Number(e.target.value) })}>
            <option value={0}>None</option>
            <option value={3}>3 seconds</option>
            <option value={5}>5 seconds</option>
          </select>
        </label>
      </section>

      <section className="tp-card">
        <div className="tp-row tp-between">
          <div className="tp-label">Script</div>
          <div className="tp-row">
            <button onClick={() => fileInput.current?.click()}>Open file</button>
            <button onClick={newScript}>New</button>
          </div>
        </div>
        <input ref={fileInput} type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void openFile(f); e.target.value = ""; }} />
        {scripts.length > 0 && (
          <div className="tp-row">
            <select className="tp-grow" value={currentId ?? ""} onChange={(e) => e.target.value && loadScript(e.target.value)}>
              {!currentId && <option value="">Unsaved script</option>}
              {scripts.map((x) => <option key={x.id} value={x.id}>{x.title}</option>)}
            </select>
            {currentId && <button onClick={() => deleteScript(currentId)} title="Delete this script">Delete</button>}
          </div>
        )}
        <textarea className="tp-script" value={s.script} spellCheck={false}
          placeholder={"Paste your script here, or open a .txt or .md file.\n\nVISUAL: lines and [bracketed] notes are directions, not words to read."}
          onChange={(e) => setScript(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { const f = e.dataTransfer.files?.[0]; if (f) { e.preventDefault(); void openFile(f); } }} />
        {fileError && <p className="tp-error">{fileError}</p>}
        <p className="tp-hint">
          {words} words{notes ? `, ${notes} notes` : ""}, about {fmt(readingSeconds(parsed, s.wpm))} at {s.wpm} wpm. Saved on this computer.
        </p>
        <Toggle label="Show direction notes" checked={s.showNotes} onChange={(v) => patch({ showNotes: v })} />
      </section>

      <section className="tp-card">
        <div className="tp-label">Look</div>
        <Slider label="Text size" value={s.fontSize} min={24} max={140} step={2} unit=" px" onChange={(fontSize) => patch({ fontSize })} />
        <Slider label="Line width" value={s.lineWidth} min={35} max={100} step={1} unit="%" onChange={(lineWidth) => patch({ lineWidth })} />
        <Slider label="Reading line" value={Math.round(s.guide * 100)} min={10} max={60} step={1} format={(v) => `${v}% down`} onChange={(v) => patch({ guide: v / 100 })} />
        <Toggle label="Mirror for a beam-splitter glass" checked={s.mirrored} onChange={(v) => patch({ mirrored: v })} />
      </section>

      <section className="tp-card">
        <div className="tp-label">{popped ? "Pop-out window" : "Overlay"}</div>
        <Slider label="Opacity" value={Math.round(settings.window.opacity * 100)} min={20} max={100} step={5} unit="%"
          onChange={(v) => setSettings({ window: { ...settings.window, opacity: v / 100 } })} />
        {popped ? (
          <>
            <Toggle label="Click-through (Ctrl+Alt+T)" checked={settings.window.clickThrough}
              onChange={(v) => setSettings({ window: { ...settings.window, clickThrough: v } })} />
            <Toggle label="Hide from screen recordings" checked={settings.window.hideFromCapture}
              onChange={(v) => setSettings({ window: { ...settings.window, hideFromCapture: v } })} />
          </>
        ) : (
          <p className="tp-hint">If you record the screen Take itself is on, the overlay shows like the rest of Take. Pop it out instead: the window hides itself from screen recordings.</p>
        )}
      </section>

      <section className="tp-card tp-keys">
        <div className="tp-label">Keys</div>
        <p className="tp-hint">In the prompter: Space play/pause, Up/Down speed, Left/Right sentence, Home restart, mouse wheel to scroll.</p>
        <p className="tp-hint">Anywhere, while the prompter is showing: Ctrl+Alt with the same keys{popped ? ", Ctrl+Alt+T for click-through" : ""}.</p>
        {shortcutsFailed.length > 0 && <p className="tp-error">Taken by another app: {shortcutsFailed.join(", ")}</p>}
      </section>
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
      <div className="tp-hint">{mic}{rec ? `. ${rec}` : ""}{voice.message ? `. ${voice.message}` : ""}</div>
    </div>
  );
}

function Slider(props: { label: string; value: number; min: number; max: number; step: number; unit?: string; format?: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="tp-slider">
      <span>{props.label}</span>
      <input type="range" min={props.min} max={props.max} step={props.step} value={props.value} onChange={(e) => props.onChange(Number(e.target.value))} />
      <output>{props.format ? props.format(props.value) : `${props.value}${props.unit ?? ""}`}</output>
    </label>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="tp-toggle">
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>{props.label}</span>
    </label>
  );
}
