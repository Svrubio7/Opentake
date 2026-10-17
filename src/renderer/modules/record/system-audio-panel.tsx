// The Computer sound controls in the Record panel's Recording card: the switch, its level and a meter.
import { useEffect, useRef, useState } from "react";
import type { SystemAudioSupport } from "@shared/types";
import { Slider, Switch } from "../../ui";
import { isBusy, useRecord } from "./store";
import { systemAudioSupport, systemSound, useSystemSound } from "./system-audio";
import { meterFill, systemAudioKey } from "./system-audio-core";
import "./system-audio.css";

const ECHO_HINT = "Records what your computer plays, like a video or an app. With the mic open, use headphones so it does not also pick up the speakers.";

/** A small live bar of the computer sound after the level, drawn without React state per frame. */
function MiniMeter() {
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let hold = -100;
    const tick = () => {
      hold = Math.max(systemSound().peakDb(), hold - 1.2);
      if (bar.current) {
        bar.current.style.transform = `scaleX(${meterFill(hold)})`;
        bar.current.classList.toggle("hot", hold > -3);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span className="sys-meter" aria-hidden="true"><span ref={bar} /></span>;
}

export function SystemSoundControls() {
  const mode = useRecord((s) => s.mode);
  const key = systemAudioKey(mode);
  const on = useRecord((s) => s[key]);
  const level = useRecord((s) => s.systemAudioLevel);
  const busy = isBusy(useRecord((s) => s.status));
  const set = useRecord((s) => s.set);
  const status = useSystemSound((s) => s.status);
  const reason = useSystemSound((s) => s.reason);
  const [support, setSupport] = useState<SystemAudioSupport | null>(null);

  useEffect(() => { void systemAudioSupport().then(setSupport); }, []);
  // the meter needs the capture open while the switch is on
  useEffect(() => {
    if (!on || !support?.supported) return;
    void systemSound().acquire();
    return () => systemSound().release();
  }, [on, support?.supported]);

  const unsupported = support != null && !support.supported;
  return (
    <>
      <Switch label="Computer sound" hint={ECHO_HINT} checked={on && !unsupported} disabled={busy || unsupported}
        onChange={(v) => set({ [key]: v })} />
      {unsupported && <p className="note">{support.reason}</p>}
      {on && !unsupported && (
        <>
          <Slider label="Computer sound level" value={level} min={0} max={2} step={0.05}
            format={(v) => `${Math.round(v * 100)}%`} onChange={(systemAudioLevel) => set({ systemAudioLevel })}
            onDoubleClick={() => set({ systemAudioLevel: 1 })} side={status === "on" ? <MiniMeter /> : null} />
          {status === "failed" && reason && <p className="note note-danger">{reason}</p>}
        </>
      )}
    </>
  );
}
