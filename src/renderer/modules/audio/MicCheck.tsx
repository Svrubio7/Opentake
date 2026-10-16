// The Mic check: 5 s of room, 10 s of reading, then the chain is set from what was measured.
import { useEffect, useRef, useState } from "react";
import { MIC_CHECK_SENTENCE, analyseMicCheck, type MicCheckResult, type ChainSettings } from "./audio-core";
import { getEngine, type Preview } from "./engine";
import { MiniInput } from "./Meters";
import { useAudioStore } from "./store";
import { applySettings } from "./actions";

const SILENCE_S = 5;
const SPEECH_S = 10;

type Step = "intro" | "silence" | "speech" | "analysing" | "result" | "failed";

export function MicCheck() {
  const running = useAudioStore((s) => s.status === "running");
  const [step, setStep] = useState<Step>("intro");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<MicCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [after, setAfter] = useState(true);
  const [undo, setUndo] = useState<{ settings: ChainSettings; agc: number } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const preview = useRef<Preview | null>(null);

  const dropPreview = () => { preview.current?.dispose(); preview.current = null; setPlaying(false); };
  useEffect(() => () => { abort.current?.abort(); dropPreview(); }, []);

  async function run() {
    dropPreview();
    setResult(null); setError(null); setUndo(null);
    const engine = getEngine();
    const ac = new AbortController();
    abort.current = ac;
    try {
      setStep("silence"); setProgress(0);
      const silence = await engine.captureRaw(SILENCE_S, (f) => setProgress(f), ac.signal);
      setStep("speech"); setProgress(0);
      const speech = await engine.captureRaw(SPEECH_S, (f) => setProgress(f), ac.signal);
      setStep("analysing");
      await new Promise((r) => setTimeout(r, 30)); // let the spinner paint before the math
      const st = useAudioStore.getState();
      const res = analyseMicCheck(silence, speech, engine.ctx!.sampleRate, st.settings);
      setResult(res);
      if (res.ok) {
        setUndo({ settings: st.settings, agc: st.agcStartGainDb });
        applySettings(res.settings);
        useAudioStore.getState().set({ agcStartGainDb: res.agcStartGainDb });
        engine.resetAgc(res.agcStartGainDb);
        preview.current = engine.createPreview(speech, res.settings, res.agcStartGainDb);
        preview.current.setAfter(true);
        setAfter(true);
      }
      setStep("result");
    } catch (e) {
      if ((e as Error).message === "cancelled") { setStep("intro"); return; }
      setError((e as Error).message);
      setStep("failed");
    } finally {
      abort.current = null;
    }
  }

  function togglePlay() {
    const p = preview.current;
    if (!p) return;
    if (playing) { p.stop(); setPlaying(false); return; }
    p.play(() => setPlaying(false));
    setPlaying(true);
  }

  function pick(on: boolean) { setAfter(on); preview.current?.setAfter(on); }

  function revert() {
    if (!undo) return;
    applySettings(undo.settings);
    useAudioStore.getState().set({ agcStartGainDb: undo.agc });
    getEngine().resetAgc(undo.agc);
    setUndo(null);
    dropPreview();
    setStep("intro");
    setResult(null);
  }

  if (step === "intro" || step === "failed") {
    return (
      <div className="au-card au-check">
        <div className="au-check-head">
          <div>
            <h3>Mic check</h3>
            <p className="au-muted">15 seconds. We listen to your room and your voice, then tune everything for you.</p>
          </div>
          <button className="au-primary" disabled={!running} onClick={run}>Start</button>
        </div>
        {error && <p className="au-warn-text">{error}</p>}
      </div>
    );
  }

  if (step === "silence" || step === "speech") {
    const secs = step === "silence" ? SILENCE_S : SPEECH_S;
    const left = Math.max(0, Math.ceil(secs * (1 - progress)));
    return (
      <div className="au-card au-check">
        <div className="au-check-step">
          <span className="au-step-dot rec" />
          <h3>{step === "silence" ? "Stay quiet" : "Read this out loud"}</h3>
          <span className="au-num au-muted">{left}s</span>
        </div>
        {step === "silence"
          ? <p className="au-muted">Listening to your room. Don't type or move the mic.</p>
          : <p className="au-sentence">{MIC_CHECK_SENTENCE}</p>}
        <div className="au-progress"><div style={{ width: `${progress * 100}%` }} /></div>
        <MiniInput />
        <button className="au-ghost" onClick={() => abort.current?.abort()}>Cancel</button>
      </div>
    );
  }

  if (step === "analysing" || !result) {
    return <div className="au-card au-check"><p className="au-muted">Listening back...</p></div>;
  }

  const m = result.metrics;
  return (
    <div className="au-card au-check">
      <div className="au-check-head">
        <h3>{result.ok ? "Tuned for you" : "Let's try that again"}</h3>
        <button className="au-ghost" onClick={run}>Run again</button>
      </div>
      <ul className="au-findings">
        {result.findings.map((f, i) => <li key={i} className={f.tone}><i />{f.text}</li>)}
      </ul>
      <div className="au-stats">
        <div><span>Room</span><b>{m.noiseFloorDb.toFixed(0)} dB</b></div>
        <div><span>Voice</span><b>{m.speechDb.toFixed(0)} dB</b></div>
        <div><span>Clarity</span><b>{m.snrDb.toFixed(0)} dB</b></div>
        <div><span>Peak</span><b>{m.peakDb.toFixed(1)} dB</b></div>
      </div>
      {result.ok && (
        <>
          <div className="au-ab">
            <button className="au-play" onClick={togglePlay} aria-label={playing ? "Stop" : "Play"}>{playing ? "Stop" : "Play"}</button>
            <div className="au-seg">
              <button className={!after ? "on" : ""} onClick={() => pick(false)}>Before</button>
              <button className={after ? "on" : ""} onClick={() => pick(true)}>After</button>
            </div>
          </div>
          <p className="au-muted au-small">Same take, switch while it plays. Use headphones so the mic doesn't hear the speakers.</p>
          {undo && <button className="au-ghost" onClick={revert}>Undo these changes</button>}
        </>
      )}
    </div>
  );
}
