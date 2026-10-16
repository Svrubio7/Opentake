// Presets and the hand controls for every stage of the chain.
import type { ReactNode } from "react";
import { PRESETS, type NsMode, type PresetId } from "./audio-core";
import { choosePreset, patchStage, setInputGain } from "./actions";
import { useAudioStore } from "./store";

function Slider(props: { label: string; value: number; min: number; max: number; step?: number; unit?: string; digits?: number; onChange: (v: number) => void }) {
  const { label, value, min, max, step = 1, unit = "", digits = 0, onChange } = props;
  return (
    <label className="au-slider">
      <span className="au-slider-head"><span>{label}</span><span className="au-num">{value > 0 && unit === "dB" && min < 0 ? "+" : ""}{value.toFixed(digits)}{unit && ` ${unit}`}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button" role="switch" aria-checked={on} aria-label={label}
      className={on ? "au-switch on" : "au-switch"}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(!on); }}
    ><i /></button>
  );
}

function Stage({ title, hint, on, onToggle, children }: { title: string; hint: string; on?: boolean; onToggle?: (v: boolean) => void; children: ReactNode }) {
  return (
    <details className={on === false ? "au-stage off" : "au-stage"}>
      <summary>
        <span className="au-stage-title">{title}<small>{hint}</small></span>
        {onToggle && on !== undefined && <Switch on={on} onChange={onToggle} label={`${title} on`} />}
      </summary>
      <div className="au-stage-body">{children}</div>
    </details>
  );
}

const NS_LABEL: Record<NsMode, string> = { rnnoise: "AI", speex: "Classic", off: "Off" };

export function Presets() {
  const preset = useAudioStore((s) => s.settings.preset);
  return (
    <div className="au-presets">
      {(Object.keys(PRESETS) as PresetId[]).map((id) => (
        <button key={id} className={preset === id ? "on" : ""} onClick={() => choosePreset(id)} title={PRESETS[id].hint}>
          {PRESETS[id].label}
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
      <Stage title="Input gain" hint="Digital boost before everything">
        <Slider label="Gain" value={s.inputGainDb} min={-24} max={30} step={0.5} digits={1} unit="dB" onChange={setInputGain} />
      </Stage>

      <Stage title="Low cut" hint="Removes rumble and handling noise" on={s.highpass.on} onToggle={(on) => patchStage("highpass", { on })}>
        <Slider label="Frequency" value={s.highpass.freq} min={40} max={200} unit="Hz" onChange={(freq) => patchStage("highpass", { freq })} />
      </Stage>

      <Stage title="Noise suppression" hint={`${NS_LABEL[nsRunning]}${nsRunning !== "off" ? `, ${Math.round(s.ns.mix * 100)}%` : ""}`} on={s.ns.mode !== "off"} onToggle={(on) => patchStage("ns", { mode: on ? "rnnoise" : "off" })}>
        <div className="au-seg au-seg-full">
          {(["rnnoise", "speex", "off"] as NsMode[]).map((m) => (
            <button key={m} className={s.ns.mode === m ? "on" : ""} disabled={m === "rnnoise" ? !nsAvailable.rnnoise : m === "speex" ? !nsAvailable.speex : false}
              onClick={() => patchStage("ns", { mode: m })}>{NS_LABEL[m]}</button>
          ))}
        </div>
        {fellBack && <p className="au-warn-text au-small">{NS_LABEL[s.ns.mode]} suppression could not load. Using {NS_LABEL[nsRunning]}.</p>}
        <Slider label="Strength" value={Math.round(s.ns.mix * 100)} min={0} max={100} unit="%" onChange={(v) => patchStage("ns", { mix: v / 100 })} />
      </Stage>

      <Stage title="Gate" hint="Quiets the room between words" on={s.gate.on} onToggle={(on) => patchStage("gate", { on })}>
        <Slider label="Threshold" value={s.gate.thresholdDb} min={-80} max={-20} digits={0} unit="dB" onChange={(thresholdDb) => patchStage("gate", { thresholdDb })} />
        <Slider label="Depth" value={s.gate.rangeDb} min={0} max={40} unit="dB" onChange={(rangeDb) => patchStage("gate", { rangeDb })} />
        <Slider label="Release" value={s.gate.releaseMs} min={20} max={500} step={10} unit="ms" onChange={(releaseMs) => patchStage("gate", { releaseMs })} />
      </Stage>

      <Stage title="De-esser" hint="Tames sharp S sounds" on={s.deesser.on} onToggle={(on) => patchStage("deesser", { on })}>
        <Slider label="Frequency" value={s.deesser.freq} min={4000} max={10000} step={100} unit="Hz" onChange={(freq) => patchStage("deesser", { freq })} />
        <Slider label="Threshold" value={s.deesser.thresholdDb} min={-60} max={-10} digits={0} unit="dB" onChange={(thresholdDb) => patchStage("deesser", { thresholdDb })} />
        <Slider label="Max reduction" value={s.deesser.maxReductionDb} min={0} max={20} unit="dB" onChange={(maxReductionDb) => patchStage("deesser", { maxReductionDb })} />
      </Stage>

      <Stage title="EQ" hint="Warmth, clarity and air" on={s.eq.on} onToggle={(on) => patchStage("eq", { on })}>
        <Slider label={`Low at ${s.eq.lowFreq} Hz`} value={s.eq.lowGainDb} min={-12} max={12} step={0.5} digits={1} unit="dB" onChange={(lowGainDb) => patchStage("eq", { lowGainDb })} />
        <Slider label="Presence" value={s.eq.presenceGainDb} min={-12} max={12} step={0.5} digits={1} unit="dB" onChange={(presenceGainDb) => patchStage("eq", { presenceGainDb })} />
        <Slider label="Presence frequency" value={s.eq.presenceFreq} min={1500} max={6000} step={100} unit="Hz" onChange={(presenceFreq) => patchStage("eq", { presenceFreq })} />
        <Slider label={`Air above ${s.eq.airFreq / 1000} kHz`} value={s.eq.airGainDb} min={-12} max={12} step={0.5} digits={1} unit="dB" onChange={(airGainDb) => patchStage("eq", { airGainDb })} />
      </Stage>

      <Stage title="Compressor" hint="Evens out loud and soft words" on={s.comp.on} onToggle={(on) => patchStage("comp", { on })}>
        <Slider label="Threshold" value={s.comp.thresholdDb} min={-40} max={0} unit="dB" onChange={(thresholdDb) => patchStage("comp", { thresholdDb })} />
        <Slider label="Ratio" value={s.comp.ratio} min={1} max={10} step={0.5} digits={1} unit=": 1" onChange={(ratio) => patchStage("comp", { ratio })} />
        <Slider label="Attack" value={s.comp.attackMs} min={1} max={50} unit="ms" onChange={(attackMs) => patchStage("comp", { attackMs })} />
        <Slider label="Release" value={s.comp.releaseMs} min={20} max={500} step={10} unit="ms" onChange={(releaseMs) => patchStage("comp", { releaseMs })} />
        <Slider label="Makeup" value={s.comp.makeupDb} min={0} max={18} step={0.5} digits={1} unit="dB" onChange={(makeupDb) => patchStage("comp", { makeupDb })} />
      </Stage>

      <Stage title="Auto level" hint={`Keeps you at ${s.agc.targetLufs} LUFS`} on={s.agc.on} onToggle={(on) => patchStage("agc", { on })}>
        <Slider label="Target" value={s.agc.targetLufs} min={-24} max={-10} unit="LUFS" onChange={(targetLufs) => patchStage("agc", { targetLufs })} />
        <Slider label="Speed" value={s.agc.speedDbPerSec} min={0.5} max={6} step={0.5} digits={1} unit="dB/s" onChange={(speedDbPerSec) => patchStage("agc", { speedDbPerSec })} />
        <Slider label="Max boost" value={s.agc.maxGainDb} min={0} max={30} unit="dB" onChange={(maxGainDb) => patchStage("agc", { maxGainDb })} />
      </Stage>

      <Stage title="Limiter" hint={`Nothing passes ${s.limiter.ceilingDb} dB`} on={s.limiter.on} onToggle={(on) => patchStage("limiter", { on })}>
        <Slider label="Ceiling" value={s.limiter.ceilingDb} min={-6} max={-0.1} step={0.1} digits={1} unit="dB" onChange={(ceilingDb) => patchStage("limiter", { ceilingDb })} />
      </Stage>
    </div>
  );
}
