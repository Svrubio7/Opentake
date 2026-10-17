// Presets and the hand controls for every stage of the chain.
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { num, t } from "@shared/i18n";
import { PRESETS, presetHint, presetLabel, type NsMode, type PresetId } from "./audio-core";
import { choosePreset, patchStage, setInputGain } from "./actions";
import { useAudioStore } from "./store";
import { Segmented, Slider as UiSlider, SwitchControl } from "../../ui";

function Slider(props: { label: string; value: number; min: number; max: number; step?: number; unit?: string; digits?: number; onChange: (v: number) => void }) {
  const { label, value, min, max, step = 1, unit = "", digits = 0, onChange } = props;
  const format = (v: number) => `${v > 0 && unit === "dB" && min < 0 ? "+" : ""}${num(v, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit === "%" ? "%" : unit && ` ${unit}`}`;
  return <UiSlider label={label} value={value} min={min} max={max} step={step} onChange={onChange} format={format} />;
}

function Stage({ title, hint, on, onToggle, children }: { title: string; hint: string; on?: boolean; onToggle?: (v: boolean) => void; children: ReactNode }) {
  return (
    <details className={on === false ? "au-stage off" : "au-stage"}>
      <summary>
        <ChevronRight className="au-chev" />
        <span className="au-stage-title">{title}<small>{hint}</small></span>
        {onToggle && on !== undefined && <SwitchControl checked={on} onChange={onToggle} label={t("audio.stageOn", { stage: title })} />}
      </summary>
      <div className="au-stage-body">{children}</div>
    </details>
  );
}

const nsLabel = (m: NsMode) => t(`audio.ns.${m}`);

export function Presets() {
  const preset = useAudioStore((s) => s.settings.preset);
  return (
    <div className="seg au-presets" role="radiogroup" aria-label={t("audio.preset")}>
      {(Object.keys(PRESETS) as PresetId[]).map((id) => (
        <button key={id} type="button" role="radio" aria-checked={preset === id} className={preset === id ? "on" : ""} onClick={() => choosePreset(id)} title={presetHint(id)}>
          {presetLabel(id)}
        </button>
      ))}
    </div>
  );
}

export function Controls() {
  const s = useAudioStore((st) => st.settings);
  const nsRunning = useAudioStore((st) => st.nsRunning);
  const nsAvailable = useAudioStore((st) => st.nsAvailable);
  const fellBack = s.ns.mode !== "off" && nsRunning !== s.ns.mode;

  return (
    <div className="au-stages">
      <Stage title={t("audio.stage.inputGain")} hint={t("audio.stage.inputGain.hint")}>
        <Slider label={t("audio.knob.gain")} value={s.inputGainDb} min={-24} max={30} step={0.5} digits={1} unit="dB" onChange={setInputGain} />
      </Stage>

      <Stage title={t("audio.stage.lowCut")} hint={t("audio.stage.lowCut.hint")} on={s.highpass.on} onToggle={(on) => patchStage("highpass", { on })}>
        <Slider label={t("audio.knob.frequency")} value={s.highpass.freq} min={40} max={200} unit="Hz" onChange={(freq) => patchStage("highpass", { freq })} />
      </Stage>

      <Stage title={t("audio.stage.ns")} hint={`${nsLabel(nsRunning)}${nsRunning !== "off" ? `, ${num(s.ns.mix, { style: "percent" })}` : ""}`} on={s.ns.mode !== "off"} onToggle={(on) => patchStage("ns", { mode: on ? "rnnoise" : "off" })}>
        <Segmented<NsMode> fill label={t("audio.stage.ns")} value={s.ns.mode} onChange={(m) => patchStage("ns", { mode: m })}
          options={(["rnnoise", "speex", "off"] as NsMode[]).map((m) => ({
            value: m, label: nsLabel(m),
            disabled: m === "rnnoise" ? !nsAvailable.rnnoise : m === "speex" ? !nsAvailable.speex : false,
          }))} />
        {fellBack && <p className="note note-warn">{t("audio.ns.fellBack", { wanted: nsLabel(s.ns.mode), running: nsLabel(nsRunning) })}</p>}
        <Slider label={t("audio.knob.strength")} value={Math.round(s.ns.mix * 100)} min={0} max={100} unit="%" onChange={(v) => patchStage("ns", { mix: v / 100 })} />
      </Stage>

      <Stage title={t("audio.stage.gate")} hint={t("audio.stage.gate.hint")} on={s.gate.on} onToggle={(on) => patchStage("gate", { on })}>
        <Slider label={t("audio.knob.threshold")} value={s.gate.thresholdDb} min={-80} max={-20} digits={0} unit="dB" onChange={(thresholdDb) => patchStage("gate", { thresholdDb })} />
        <Slider label={t("audio.knob.depth")} value={s.gate.rangeDb} min={0} max={40} unit="dB" onChange={(rangeDb) => patchStage("gate", { rangeDb })} />
        <Slider label={t("audio.knob.release")} value={s.gate.releaseMs} min={20} max={500} step={10} unit="ms" onChange={(releaseMs) => patchStage("gate", { releaseMs })} />
      </Stage>

      <Stage title={t("audio.stage.deesser")} hint={t("audio.stage.deesser.hint")} on={s.deesser.on} onToggle={(on) => patchStage("deesser", { on })}>
        <Slider label={t("audio.knob.frequency")} value={s.deesser.freq} min={4000} max={10000} step={100} unit="Hz" onChange={(freq) => patchStage("deesser", { freq })} />
        <Slider label={t("audio.knob.threshold")} value={s.deesser.thresholdDb} min={-60} max={-10} digits={0} unit="dB" onChange={(thresholdDb) => patchStage("deesser", { thresholdDb })} />
        <Slider label={t("audio.knob.maxReduction")} value={s.deesser.maxReductionDb} min={0} max={20} unit="dB" onChange={(maxReductionDb) => patchStage("deesser", { maxReductionDb })} />
      </Stage>

      <Stage title={t("audio.stage.eq")} hint={t("audio.stage.eq.hint")} on={s.eq.on} onToggle={(on) => patchStage("eq", { on })}>
        <Slider label={t("audio.knob.lowAt", { freq: s.eq.lowFreq })} value={s.eq.lowGainDb} min={-12} max={12} step={0.5} digits={1} unit="dB" onChange={(lowGainDb) => patchStage("eq", { lowGainDb })} />
        <Slider label={t("audio.knob.presence")} value={s.eq.presenceGainDb} min={-12} max={12} step={0.5} digits={1} unit="dB" onChange={(presenceGainDb) => patchStage("eq", { presenceGainDb })} />
        <Slider label={t("audio.knob.presenceFreq")} value={s.eq.presenceFreq} min={1500} max={6000} step={100} unit="Hz" onChange={(presenceFreq) => patchStage("eq", { presenceFreq })} />
        <Slider label={t("audio.knob.airAbove", { freq: num(s.eq.airFreq / 1000) })} value={s.eq.airGainDb} min={-12} max={12} step={0.5} digits={1} unit="dB" onChange={(airGainDb) => patchStage("eq", { airGainDb })} />
      </Stage>

      <Stage title={t("audio.stage.comp")} hint={t("audio.stage.comp.hint")} on={s.comp.on} onToggle={(on) => patchStage("comp", { on })}>
        <Slider label={t("audio.knob.threshold")} value={s.comp.thresholdDb} min={-40} max={0} unit="dB" onChange={(thresholdDb) => patchStage("comp", { thresholdDb })} />
        <Slider label={t("audio.knob.ratio")} value={s.comp.ratio} min={1} max={10} step={0.5} digits={1} unit=": 1" onChange={(ratio) => patchStage("comp", { ratio })} />
        <Slider label={t("audio.knob.attack")} value={s.comp.attackMs} min={1} max={50} unit="ms" onChange={(attackMs) => patchStage("comp", { attackMs })} />
        <Slider label={t("audio.knob.release")} value={s.comp.releaseMs} min={20} max={500} step={10} unit="ms" onChange={(releaseMs) => patchStage("comp", { releaseMs })} />
        <Slider label={t("audio.knob.makeup")} value={s.comp.makeupDb} min={0} max={18} step={0.5} digits={1} unit="dB" onChange={(makeupDb) => patchStage("comp", { makeupDb })} />
      </Stage>

      <Stage title={t("audio.stage.agc")} hint={t("audio.stage.agc.hint", { target: num(s.agc.targetLufs) })} on={s.agc.on} onToggle={(on) => patchStage("agc", { on })}>
        <Slider label={t("audio.knob.target")} value={s.agc.targetLufs} min={-24} max={-10} unit="LUFS" onChange={(targetLufs) => patchStage("agc", { targetLufs })} />
        <Slider label={t("audio.knob.speed")} value={s.agc.speedDbPerSec} min={0.5} max={6} step={0.5} digits={1} unit="dB/s" onChange={(speedDbPerSec) => patchStage("agc", { speedDbPerSec })} />
        <Slider label={t("audio.knob.maxBoost")} value={s.agc.maxGainDb} min={0} max={30} unit="dB" onChange={(maxGainDb) => patchStage("agc", { maxGainDb })} />
      </Stage>

      <Stage title={t("audio.stage.limiter")} hint={t("audio.stage.limiter.hint", { ceiling: num(s.limiter.ceilingDb) })} on={s.limiter.on} onToggle={(on) => patchStage("limiter", { on })}>
        <Slider label={t("audio.knob.ceiling")} value={s.limiter.ceilingDb} min={-6} max={-0.1} step={0.1} digits={1} unit="dB" onChange={(ceilingDb) => patchStage("limiter", { ceilingDb })} />
      </Stage>
    </div>
  );
}
