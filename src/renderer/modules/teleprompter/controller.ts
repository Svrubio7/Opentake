// Wires the controller store to the prompter window (IPC) and to the voice engine.
import { useEffect, useMemo, useRef, useState } from "react";
import { IPC } from "@shared/ipc";
import { newTracker, newVad, scriptVocabulary, tokenToWord, trackHeard, vadStep, wordToToken, type PrompterCommand, type TrackerState } from "./prompter-core";
import { parsedFor, usePrompter } from "./store";
import { preloadModel, VoiceEngine } from "./voice";

/** Mic level listeners for the meter (kept out of React state: it changes 15 times a second). */
const levelListeners = new Set<(db: number, speaking: boolean) => void>();
export function onMicLevel(l: (db: number, speaking: boolean) => void) {
  levelListeners.add(l);
  return () => { levelListeners.delete(l); };
}

let resetTracker: ((word: number) => void) | null = null;

/** The reading surface (pop-out window or in-window overlay) says where the reader is. */
export function reportPosition(word: number, manual: boolean) {
  const { state, patch } = usePrompter.getState();
  if (word === state.position && !manual) return;
  patch(manual ? { position: word, target: word } : { position: word });
  if (manual) resetTracker?.(word);
}

export function usePrompterController() {
  const engine = useRef<VoiceEngine | null>(null);
  const tracker = useRef<TrackerState>(newTracker());
  const vad = useRef(newVad());
  const trackerReset = useRef<((word: number) => void) | null>(null);

  trackerReset.current = (word: number) => {
    const parsed = parsedFor(usePrompter.getState().state);
    tracker.current = newTracker(wordToToken(parsed, word));
  };
  resetTracker = trackerReset.current;

  // state -> prompter window
  useEffect(() => {
    window.take.send(IPC.prompterState, usePrompter.getState().state);
    return usePrompter.subscribe((s, prev) => { if (s.state !== prev.state) window.take.send(IPC.prompterState, s.state); });
  }, []);

  // prompter window and global shortcuts -> controller
  useEffect(() => {
    const offCmd = window.take.on(IPC.prompterCommand, (cmd) => usePrompter.getState().command(cmd as PrompterCommand));
    const offPos = window.take.on(IPC.prompterPosition, (msg) => {
      const { word, manual } = msg as { word: number; manual?: boolean };
      reportPosition(word, !!manual);
    });
    const offStatus = window.take.on(IPC.prompterWindowStatus, (msg) => {
      const m = msg as { open: boolean; shortcutsFailed?: string[] };
      usePrompter.setState((s) => ({ windowOpen: m.open, shortcutsFailed: m.shortcutsFailed ?? s.shortcutsFailed }));
    });
    return () => { offCmd(); offPos(); offStatus(); };
  }, []);

  // window options -> main
  const windowOpts = usePrompter((s) => s.settings.window);
  const windowOpen = usePrompter((s) => s.windowOpen);
  useEffect(() => { if (windowOpen) void window.take.invoke(IPC.prompterWindow, windowOpts); }, [windowOpts, windowOpen]);

  // the overlay lives in this window: ask main to keep the global shortcuts on while it shows
  const overlayShowing = usePrompter((s) => s.overlayOpen);
  useEffect(() => {
    void window.take.invoke(IPC.prompterShortcuts, overlayShowing).then((r) => {
      const failed = (r as { shortcutsFailed?: string[] } | undefined)?.shortcutsFailed;
      if (overlayShowing && failed) usePrompter.setState({ shortcutsFailed: failed });
    });
  }, [overlayShowing]);

  // ---- voice ----
  const mode = usePrompter((s) => s.state.mode);
  const playing = usePrompter((s) => s.state.playing);
  const lang = usePrompter((s) => s.state.lang);
  const script = usePrompter((s) => s.state.script);
  const scriptWordsOnly = usePrompter((s) => s.settings.scriptWordsOnly);
  const active = mode !== "manual" && (windowOpen || overlayShowing || playing);
  const recognize = mode === "voice-tracked";

  // vocabulary follows the script, but not on every keystroke
  const [debouncedScript, setDebouncedScript] = useState(script);
  useEffect(() => { const t = setTimeout(() => setDebouncedScript(script), 800); return () => clearTimeout(t); }, [script]);
  const vocabulary = useMemo(
    () => (scriptWordsOnly ? scriptVocabulary(parsedFor({ script: debouncedScript, lang })) : []),
    [debouncedScript, lang, scriptWordsOnly],
  );

  // a jump (sentence keys, restart) or a new script moves the tracker with it
  const seekNonce = usePrompter((s) => s.state.seek.nonce);
  useEffect(() => { trackerReset.current?.(usePrompter.getState().state.seek.word); }, [seekNonce]);
  useEffect(() => { trackerReset.current?.(usePrompter.getState().state.position); }, [script, lang]);

  useEffect(() => { if (recognize) preloadModel(lang); }, [recognize, lang]);

  useEffect(() => {
    if (!active) {
      engine.current?.stop();
      engine.current = null;
      if (usePrompter.getState().state.speaking) usePrompter.getState().patch({ speaking: false });
      return;
    }
    const config = { recognize, lang, vocabulary };
    if (engine.current) { void engine.current.update(config); return; }
    const e = new VoiceEngine();
    engine.current = e;
    e.onStatus = (voice) => usePrompter.setState({ voice: { ...voice } });
    e.onLevel = (db, dt) => {
      const { settings, state, patch } = usePrompter.getState();
      vad.current = vadStep(vad.current, db, dt, { margin: settings.vadMargin, attack: 90, release: 550 });
      const speaking = vad.current.speaking;
      levelListeners.forEach((l) => l(db, speaking));
      if (speaking !== state.speaking) patch({ speaking });
    };
    e.onHeard = (ev) => {
      const { state, patch } = usePrompter.getState();
      const heardWords = (ev.final ?? ev.partial ?? "").split(/\s+/).filter((w) => w && w !== "[unk]");
      if (heardWords.length) usePrompter.setState({ heard: heardWords.slice(-10).join(" ") });
      if (state.mode !== "voice-tracked" || !state.playing || Date.now() < state.countdownUntil) return;
      const parsed = parsedFor(state);
      tracker.current = trackHeard(parsed, tracker.current, ev);
      const word = tokenToWord(parsed, tracker.current.cursor);
      if (word !== state.target) patch({ target: word });
    };
    void e.start(config);
  }, [active, recognize, lang, vocabulary]);

  useEffect(() => () => { engine.current?.stop(); engine.current = null; }, []);
}
