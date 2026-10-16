// The prompter window: big text, a reading line, smooth sub-pixel scrolling.
// It owns the scroll motion (requestAnimationFrame); the controller in the main window owns the
// settings, the transport and, in voice-tracked mode, the target word it eases toward.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { IPC } from "@shared/ipc";
import type { PrompterState } from "@shared/types";
import {
  easeToward, keyCommand, parseScript, positionToY, stepVelocity, wordAnchors, wordsPerSecond, yToPosition,
  type ParsedScript,
} from "./prompter-core";
import "./teleprompter.css";

const LINE_HEIGHT = 1.45;

export function PrompterApp() {
  const [state, setState] = useState<PrompterState | null>(null);
  const [clickThrough, setClickThrough] = useState(false);

  useEffect(() => {
    const off = window.take.on(IPC.prompterState, (s) => setState(s as PrompterState));
    void window.take.invoke(IPC.prompterState).then((s) => { if (s) setState((cur) => cur ?? (s as PrompterState)); });
    return off;
  }, []);
  useEffect(() => window.take.on(IPC.prompterWindowStatus, (m) => setClickThrough(!!(m as { clickThrough?: boolean }).clickThrough)), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmd = keyCommand(e);
      if (!cmd) return;
      e.preventDefault();
      window.take.send(IPC.prompterCommand, cmd);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!state) return <div className="pv-root"><div className="pv-empty">Connecting to Take</div></div>;
  return (
    <PrompterSurface state={state} clickThrough={clickThrough}
      onPosition={(word, manual) => window.take.send(IPC.prompterPosition, manual ? { word, manual } : { word })}
      onClose={() => void window.take.invoke(IPC.prompterClose)} />
  );
}

export interface SurfaceProps {
  state: PrompterState;
  /** where the reader is, about ten times a second; manual = the person scrolled or clicked a word */
  onPosition: (word: number, manual: boolean) => void;
  onClose?: () => void;
  clickThrough?: boolean;
  /** inside the main window: no frameless drag bar, the overlay brings its own header */
  embedded?: boolean;
}

/** The reading surface, shared by the pop-out window and the in-window overlay. */
export function PrompterSurface({ state, clickThrough = false, onPosition, onClose, embedded = false }: SurfaceProps) {
  const report = useRef(onPosition);
  report.current = onPosition;
  const parsed = useMemo(() => parseScript(state.script, state.lang), [state.script, state.lang]);
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const live = useRef({
    state,
    parsed,
    p: state.position,
    v: 0,
    nonce: state.seek.nonce,
    anchors: [] as { y: number; h: number }[],
    spans: [] as HTMLElement[],
    sentence: -1,
    reported: -1,
    reportAt: 0,
  });
  live.current.state = state;
  live.current.parsed = parsed;

  // a jump from the controller
  if (state.seek.nonce !== live.current.nonce) {
    live.current.nonce = state.seek.nonce;
    live.current.p = Math.max(0, Math.min(parsed.words.length, state.seek.word));
    live.current.v = 0;
  }

  // measure every word's line after layout changes
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    const measure = () => {
      const spans = Array.from(el.querySelectorAll<HTMLElement>(".pv-w"));
      live.current.spans = spans;
      live.current.anchors = wordAnchors(spans.map((s) => ({ top: s.offsetTop, height: s.offsetHeight })));
      live.current.sentence = -1; // repaint sentence classes
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [parsed, state.fontSize, state.lineWidth, state.showNotes]);

  // the motion loop
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const L = live.current;
      const s = L.state;
      const n = L.parsed.words.length;
      const counting = s.countdownUntil > Date.now();
      const running = s.playing && !counting;

      if (s.mode === "voice-tracked") {
        L.v = 0;
        if (running) L.p = easeToward(L.p, Math.min(n, s.target), dt);
      } else {
        const go = running && (s.mode === "manual" || s.speaking) && L.p < n;
        L.v = stepVelocity(L.v, go ? wordsPerSecond(s.wpm) : 0, dt, s.mode === "voice-paced" ? 0.35 : 0.25);
        if (L.v < 0.001 && !go) L.v = 0;
        L.p = Math.min(n, L.p + L.v * dt);
      }

      paint(L, s, viewport.current, content.current);

      // tell the controller where the reader is, about ten times a second
      const word = Math.min(n, Math.round(L.p));
      if (word !== L.reported && now - L.reportAt > 100) {
        L.reported = word;
        L.reportAt = now;
        report.current(word, false);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  const jumpTo = (p: number) => {
    const L = live.current;
    L.p = Math.max(0, Math.min(L.parsed.words.length, p));
    L.v = 0;
    L.reported = Math.round(L.p);
    report.current(Math.round(L.p), true);
  };

  const onWheel = (e: React.WheelEvent) => {
    const L = live.current;
    if (!L.anchors.length) return;
    const dy = e.deltaY * (e.deltaMode === 1 ? 40 : 1);
    jumpTo(yToPosition(positionToY(L.p, L.anchors) + dy, L.anchors));
  };

  const onClick = (e: React.MouseEvent) => {
    const w = (e.target as HTMLElement).closest<HTMLElement>(".pv-w");
    if (w) jumpTo(Number(w.dataset.i));
  };

  const lh = state.fontSize * LINE_HEIGHT;
  return (
    <div className={`pv-root${clickThrough ? " pv-through" : ""}${embedded ? " pv-embedded" : ""}`}>
      {!embedded && (
        <div className="pv-drag">
          <span className="pv-drag-title">Take prompter</span>
          {onClose && <button type="button" className="pv-close" title="Close" aria-label="Close" onClick={onClose}><X /></button>}
        </div>
      )}
      <div className="pv-viewport" ref={viewport} onWheel={onWheel} onClick={onClick}
        style={{ transform: state.mirrored ? "scaleX(-1)" : undefined }}>
        <div className="pv-guide" style={{ top: `calc(${state.guide * 100}% - ${lh / 2}px)`, height: lh }}>
          <span className={`pv-marker${state.mode === "voice-paced" && state.speaking ? " on" : ""}`} />
        </div>
        <div className="pv-content" ref={content}
          style={{ fontSize: state.fontSize, lineHeight: LINE_HEIGHT, width: `${state.lineWidth}%` }}>
          <ScriptBody parsed={parsed} showNotes={state.showNotes} />
        </div>
      </div>
      {!parsed.words.length && <div className="pv-empty">Paste a script in the Teleprompter tab of Take.</div>}
      <Countdown until={state.countdownUntil} playing={state.playing} />
    </div>
  );
}

type Live = { p: number; anchors: { y: number; h: number }[]; spans: HTMLElement[]; sentence: number; parsed: ParsedScript };

/** Place the text and mark the sentence being read. Direct DOM writes: this runs every frame. */
function paint(L: Live, s: PrompterState, viewport: HTMLDivElement | null, content: HTMLDivElement | null) {
  if (!viewport || !content) return;
  const lh = s.fontSize * LINE_HEIGHT;
  const guideY = viewport.clientHeight * s.guide;
  const y = L.anchors.length ? positionToY(L.p, L.anchors) : 0;
  content.style.transform = `translate3d(-50%, ${(guideY - lh / 2 - y).toFixed(2)}px, 0)`;

  const n = L.parsed.words.length;
  if (!n) return;
  const w = Math.min(n - 1, Math.floor(L.p + 0.15));
  const sentence = L.p >= n ? L.parsed.sentences.length : L.parsed.words[w].sentence;
  if (sentence === L.sentence) return;
  L.sentence = sentence;
  for (const span of L.spans) {
    const sIdx = Number(span.dataset.s);
    span.className = sIdx < sentence ? "pv-w read" : sIdx === sentence ? "pv-w cur" : "pv-w";
  }
}

function ScriptBody({ parsed, showNotes }: { parsed: ParsedScript; showNotes: boolean }) {
  return (
    <>
      {parsed.paragraphs.map((p, pi) => {
        if (p.note) return showNotes ? <p key={pi} className="pv-p pv-note-p">{(p.items[0] as { text: string }).text}</p> : null;
        return (
          <p key={pi} className="pv-p">
            {p.items.map((item, ii) => item.type === "word"
              ? <span key={ii}><span className="pv-w" data-i={item.i} data-s={parsed.words[item.i].sentence}>{parsed.words[item.i].text}</span>{" "}</span>
              : showNotes ? <span key={ii} className="pv-note">{item.text} </span> : null)}
          </p>
        );
      })}
      {parsed.words.length > 0 && <p className="pv-p pv-end">End</p>}
    </>
  );
}

function Countdown({ until, playing }: { until: number; playing: boolean }) {
  const [, tick] = useState(0);
  const left = Math.ceil((until - Date.now()) / 1000);
  useEffect(() => {
    if (!playing || until <= Date.now()) return;
    const t = setInterval(() => { tick((x) => x + 1); if (Date.now() > until) clearInterval(t); }, 100);
    return () => clearInterval(t);
  }, [until, playing]);
  if (!playing || left <= 0) return null;
  return <div className="pv-countdown"><span key={left}>{left}</span></div>;
}
