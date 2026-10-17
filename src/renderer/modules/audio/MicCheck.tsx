// The Mic check: 5 s of room, 10 s of reading, then the chain is set from what was measured.
import { useEffect, useRef, useState } from "react";
import { num, t } from "@shared/i18n";
import { micCheckSentence, analyseMicCheck, type MicCheckResult, type ChainSettings } from "./audio-core";
import { getEngine, type Preview } from "./engine";
import { MiniInput } from "./Meters";
import { useAudioStore } from "./store";
import { applySettings } from "./actions";
import { Wand2 } from "lucide-react";
import { Button, CardMark, Segmented } from "../../ui";

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
      <section className="card au-check">
        <div className="au-check-head">
          <div>
            <h3 className="card-title"><CardMark icon={Wand2} />{t("audio.check.title")}</h3>
            <p className="note">{t("audio.check.intro")}</p>
          </div>
          <Button variant="ink" disabled={!running} onClick={run}>{t("audio.check.start")}</Button>
        </div>
        {error && <p className="note note-warn">{error}</p>}
      </section>
    );
  }

  if (step === "silence" || step === "speech") {
    const secs = step === "silence" ? SILENCE_S : SPEECH_S;
    const left = Math.max(0, Math.ceil(secs * (1 - progress)));
    return (
      <section className="card au-check">
        <div className="au-check-step">
          <span className="au-step-dot" />
          <h3 className="card-title"><CardMark icon={Wand2} />{step === "silence" ? t("audio.check.quiet") : t("audio.check.read")}</h3>
          <span className="au-num au-left">{t("audio.check.secondsLeft", { seconds: left })}</span>
        </div>
        {step === "silence"
          ? <p className="note">{t("audio.check.listening")}</p>
          : <p className="au-sentence">{micCheckSentence()}</p>}
        <div className="progress"><div style={{ width: `${progress * 100}%` }} /></div>
        <MiniInput />
        <Button variant="ghost" size="sm" className="au-self-start" onClick={() => abort.current?.abort()}>{t("audio.check.cancel")}</Button>
      </section>
    );
  }

  if (step === "analysing" || !result) {
    return <section className="card au-check"><p className="note">{t("audio.check.analysing")}</p></section>;
  }

  const m = result.metrics;
  return (
    <section className="card au-check">
      <div className="card-head">
        <h3 className="card-title"><CardMark icon={Wand2} />{result.ok ? t("audio.check.tuned") : t("audio.check.again")}</h3>
        <Button variant="ghost" size="sm" onClick={run}>{t("audio.check.runAgain")}</Button>
      </div>
      <ul className="au-findings">
        {result.findings.map((f, i) => <li key={i} className={f.tone}><i />{f.text}</li>)}
      </ul>
      <div className="au-stats">
        <div><span>{t("audio.check.room")}</span><b>{num(m.noiseFloorDb, { maximumFractionDigits: 0 })} dB</b></div>
        <div><span>{t("audio.check.voice")}</span><b>{num(m.speechDb, { maximumFractionDigits: 0 })} dB</b></div>
        <div><span>{t("audio.check.clarity")}</span><b>{num(m.snrDb, { maximumFractionDigits: 0 })} dB</b></div>
        <div><span>{t("audio.check.peak")}</span><b>{num(m.peakDb, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} dB</b></div>
      </div>
      {result.ok && (
        <>
          <div className="au-ab">
            <Button className="au-play" onClick={togglePlay} aria-label={playing ? t("audio.check.stop") : t("audio.check.play")}
              title={t("audio.check.playHint")}>{playing ? t("audio.check.stop") : t("audio.check.play")}</Button>
            <Segmented<"before" | "after"> fill label={t("audio.check.compare")} value={after ? "after" : "before"} onChange={(v) => pick(v === "after")}
              options={[{ value: "before", label: t("audio.check.before") }, { value: "after", label: t("audio.check.after") }]} />
          </div>
          {undo && <Button variant="ghost" size="sm" className="au-self-start" onClick={revert}>{t("audio.check.undo")}</Button>}
        </>
      )}
    </section>
  );
}
