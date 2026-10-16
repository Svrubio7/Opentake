// Live meters drawn straight from engine messages (no React state per frame).
import { useEffect, useRef } from "react";
import { getEngine } from "./engine";
import { useAudioStore } from "./store";

const FLOOR = -60;
const pct = (db: number) => `${Math.max(0, Math.min(1, (db - FLOOR) / -FLOOR)) * 100}%`;
const fmt = (db: number, digits = 0) => (db <= -100 ? "-inf" : db.toFixed(digits));
const PEAK_FALL_DB = 1; // per message, about 20 dB a second

function useMeterRefs() {
  return { rms: useRef<HTMLDivElement>(null), peak: useRef<HTMLDivElement>(null), text: useRef<HTMLSpanElement>(null), hold: useRef(-200) };
}

function Bar({ label, refs }: { label: string; refs: ReturnType<typeof useMeterRefs> }) {
  return (
    <div className="au-meter">
      <div className="au-meter-head"><span>{label}</span><span ref={refs.text} className="au-num">-inf</span></div>
      <div className="au-meter-track">
        <div className="au-meter-rms" ref={refs.rms} />
        <div className="au-meter-peak" ref={refs.peak} />
        <div className="au-meter-ticks">{[-48, -36, -24, -12, -6].map((d) => <i key={d} style={{ left: pct(d) }} />)}</div>
      </div>
    </div>
  );
}

function draw(refs: ReturnType<typeof useMeterRefs>, peakDb: number, rmsDb: number) {
  refs.hold.current = Math.max(peakDb, refs.hold.current - PEAK_FALL_DB);
  if (refs.rms.current) refs.rms.current.style.width = pct(rmsDb);
  if (refs.peak.current) {
    refs.peak.current.style.left = pct(refs.hold.current);
    refs.peak.current.classList.toggle("hot", refs.hold.current > -3);
  }
  if (refs.text.current) refs.text.current.textContent = `${fmt(refs.hold.current)} dB`;
}

const GR = [
  { key: "gateDb", label: "Gate" },
  { key: "deessDb", label: "De-ess" },
  { key: "compDb", label: "Comp" },
  { key: "limDb", label: "Limit" },
] as const;

export function Meters() {
  const input = useMeterRefs(), output = useMeterRefs();
  const gr = useRef<Record<string, HTMLDivElement | null>>({});
  const lufs = useRef<HTMLSpanElement>(null), lufsBox = useRef<HTMLDivElement>(null), agc = useRef<HTMLSpanElement>(null);
  const clip = useRef<HTMLSpanElement>(null);
  const target = useAudioStore((s) => s.settings.agc.targetLufs);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const engine = getEngine();
    let clipUntil = 0;
    const offIn = engine.onInput((m) => {
      draw(input, m.peakDb, m.rmsDb);
      if (m.clips > 0 || m.peakDb > -0.1) clipUntil = performance.now() + 2500;
      clip.current?.classList.toggle("on", performance.now() < clipUntil);
    });
    const offOut = engine.onOutput((m) => {
      draw(output, m.peakDb, m.rmsDb);
      for (const { key } of GR) {
        const el = gr.current[key];
        if (el) el.style.width = `${Math.min(1, -m[key] / 20) * 100}%`;
      }
      if (lufs.current) lufs.current.textContent = m.lufsS < -70 ? "--" : m.lufsS.toFixed(1);
      lufsBox.current?.classList.toggle("near", Math.abs(m.lufsS - targetRef.current) <= 2);
      if (agc.current) agc.current.textContent = `${m.agcDb >= 0 ? "+" : ""}${m.agcDb.toFixed(1)} dB`;
    });
    return () => { offIn(); offOut(); };
  }, []);

  return (
    <section className="card au-meters">
      <div className="card-head"><h3 className="card-title">Levels</h3><span className="au-clip" ref={clip}>Clipping. Turn the mic gain down.</span></div>
      <Bar label="Input" refs={input} />
      <Bar label="Output" refs={output} />
      <div className="au-gr">
        {GR.map(({ key, label }) => (
          <div key={key} className="au-gr-item" title={`${label} gain reduction`}>
            <span>{label}</span>
            <div className="au-gr-track"><div ref={(el) => { gr.current[key] = el; }} /></div>
          </div>
        ))}
      </div>
      <div className="au-loud" ref={lufsBox}>
        <div title="Short-term loudness of what is being recorded"><span className="au-loud-num" ref={lufs}>--</span><span className="au-loud-unit">LUFS</span></div>
        <div className="au-loud-side">
          <span>Target <span className="au-num">{target}</span></span>
          <span>Auto level <span ref={agc} className="au-num">+0.0 dB</span></span>
        </div>
      </div>
    </section>
  );
}

/** Small live input bar used inside the Mic check while it records. */
export function MiniInput() {
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => getEngine().onInput((m) => { if (bar.current) bar.current.style.width = pct(m.rmsDb); }), []);
  return <div className="au-mini"><div ref={bar} /></div>;
}
