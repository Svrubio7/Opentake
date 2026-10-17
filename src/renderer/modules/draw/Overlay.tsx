// OWNED BY: shell agent. The two drawing windows: the strokes (full screen, recorded) and the toolbar.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Highlighter, MoveUpRight, Pen, Square, Timer, TimerOff, Trash2, Undo2, X, type LucideIcon } from "lucide-react";
import { IPC } from "@shared/ipc";
import type { DrawCommand, DrawStatus, DrawTool } from "@shared/types";
import {
  COLORS, FADE_HOLD_MS, TOOL_STYLE, addPoint, fadeOpacity, isFreehand, liveStrokes, nextExpiry, strokeAt, strokePath, type Pt, type Stroke,
} from "./draw-core";
import { t } from "@shared/i18n";
import { keyLabel } from "../shell/shortcuts-core";
import "./draw.css";

const bridge = () => (typeof window !== "undefined" ? window.take : undefined);
const INITIAL: DrawStatus = { active: false, fade: true, tool: "pen", color: COLORS[0].value, shortcut: "Ctrl+Shift+D", shortcutOk: true };

function useDrawStatus() {
  const [s, setS] = useState<DrawStatus>(INITIAL);
  useEffect(() => {
    const b = bridge();
    if (!b) return;
    void b.invoke(IPC.drawStatus).then((v) => setS(v as DrawStatus));
    return b.on(IPC.drawStatus, (v) => setS(v as DrawStatus));
  }, []);
  return s;
}

const setPrefs = (p: Partial<DrawStatus>) => void bridge()?.invoke(IPC.drawPrefs, p);
const stop = () => void bridge()?.invoke(IPC.drawToggle, false);
const command = (c: DrawCommand) => bridge()?.send(IPC.drawCommand, c);

/** Keys shared by both windows (the strokes window has the focus; the toolbar answers too, just in case). */
function onKey(e: KeyboardEvent, apply: (c: DrawCommand) => void) {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.key === "Escape") stop();
  else if (mod && k === "z") apply("undo");
  else if (!mod && k === "c") apply("clear");
  else if (!mod && k in KEY_TOOL) setPrefs({ tool: KEY_TOOL[k] });
  else return;
  e.preventDefault();
}
const KEY_TOOL: Record<string, DrawTool> = { p: "pen", h: "highlighter", a: "arrow", r: "rect" };

let nextId = 1;

/** The full-screen window: draws while drawing mode is on, keeps fading strokes after it is off. */
export function DrawStrokes() {
  const status = useDrawStatus();
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const drawing = useRef<Stroke | null>(null);
  const [, redraw] = useState(0);

  const apply = (c: DrawCommand) => {
    if (c === "clear") setStrokes([]);
    else setStrokes((l) => l.slice(0, -1));
  };

  useEffect(() => bridge()?.on(IPC.drawCommand, (c) => apply(c as DrawCommand)), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (status.active) onKey(e, apply); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [status.active]);

  // fading: tick about 30 times a second while something fades, sleep until the next one starts otherwise.
  // Timers, not requestAnimationFrame: Chromium stops animation frames in a window it thinks is covered,
  // and a click-through overlay can look covered, which left strokes on screen for good.
  useEffect(() => {
    if (!status.fade) return;
    const t = Date.now();
    const fading = strokes.some((s) => s.doneAt !== undefined && t - s.doneAt >= FADE_HOLD_MS);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const n = Date.now();
      setNow(n);
      setStrokes((l) => { const live = liveStrokes(l, n, true); return live.length === l.length ? l : live; });
    };
    if (fading) timer = setTimeout(tick, 33);
    else {
      const left = nextExpiry(strokes, t, true);
      if (left !== null) timer = setTimeout(tick, Math.max(16, left - 600));
    }
    return () => { if (timer) clearTimeout(timer); };
  }, [strokes, now, status.fade]);

  // tell main when nothing is left, so a click-through window does not linger on the screen
  const isEmpty = strokes.length === 0 && !drawing.current;
  useEffect(() => { bridge()?.send(IPC.drawEmpty, isEmpty); }, [isEmpty]);

  const at = (e: { clientX: number; clientY: number }): Pt => ({ x: e.clientX, y: e.clientY });

  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!status.active) return;
    if (e.button === 2) {
      // right click rubs out the stroke under the pointer
      const i = strokeAt(strokes, at(e));
      if (i >= 0) setStrokes((l) => l.filter((_, j) => j !== i));
      return;
    }
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    drawing.current = { id: nextId++, tool: status.tool, color: status.color, points: isFreehand(status.tool) ? [p] : [p, p] };
    redraw((n) => n + 1);
  };
  const move = (e: ReactPointerEvent<SVGSVGElement>) => {
    const s = drawing.current;
    if (!s) return;
    if (isFreehand(s.tool)) {
      // coalesced events keep a fast stroke smooth (the browser batches them per frame)
      const evs = e.nativeEvent.getCoalescedEvents?.() ?? [];
      let pts = s.points;
      for (const ev of evs.length ? evs : [e.nativeEvent]) pts = addPoint(pts, at(ev));
      if (pts === s.points) return;
      s.points = pts;
    } else s.points = [s.points[0], at(e)];
    redraw((n) => n + 1);
  };
  const up = () => {
    const s = drawing.current;
    if (!s) return;
    drawing.current = null;
    const done = { ...s, doneAt: Date.now() };
    if (strokePath(done)) setStrokes((l) => [...l, done]);
    else redraw((n) => n + 1);
  };

  const all = drawing.current ? [...strokes, drawing.current] : strokes;
  return (
    <svg className={status.active ? "draw-canvas on" : "draw-canvas"} onPointerDown={down} onPointerMove={move} onPointerUp={up}
      onPointerCancel={up} onContextMenu={(e) => e.preventDefault()}>
      {all.map((s) => {
        const style = TOOL_STYLE[s.tool];
        const o = fadeOpacity(s, now, status.fade) * style.opacity;
        return <path key={s.id} d={strokePath(s)} stroke={s.color} strokeWidth={style.width} strokeOpacity={o}
          className={s.tool === "highlighter" ? "draw-stroke hl" : "draw-stroke"} />;
      })}
    </svg>
  );
}

const TOOL_BUTTONS = [
  { id: "pen", label: "draw.tool.pen", key: "P", icon: Pen },
  { id: "highlighter", label: "draw.tool.highlighter", key: "H", icon: Highlighter },
  { id: "arrow", label: "draw.tool.arrow", key: "A", icon: MoveUpRight },
  { id: "rect", label: "draw.tool.rect", key: "R", icon: Square },
] as const satisfies readonly { id: DrawTool; label: string; key: string; icon: LucideIcon }[];

/** The small bar at the top centre. Its window is hidden from the recording. */
export function DrawToolbar() {
  const s = useDrawStatus();
  useEffect(() => {
    const k = (e: KeyboardEvent) => onKey(e, command);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  const mod = s.shortcut.startsWith("Cmd") ? "Cmd" : "Ctrl";
  return (
    <div className="draw-dock">
      <div className="draw-bar" role="toolbar" aria-label={t("draw.tools")}>
        {TOOL_BUTTONS.map(({ id, label, key, icon: Icon }) => (
          <button key={id} type="button" className={s.tool === id ? "draw-btn on" : "draw-btn"} title={t("draw.withKey", { label: t(label), key })} aria-label={t(label)}
            aria-pressed={s.tool === id} onClick={() => setPrefs({ tool: id })}><Icon /></button>
        ))}
        <i className="draw-sep" />
        {COLORS.map((c) => (
          <button key={c.id} type="button" className={s.color === c.value ? "draw-swatch on" : "draw-swatch"} title={t(c.label)} aria-label={t(c.label)}
            aria-pressed={s.color === c.value} style={{ background: c.value }} onClick={() => setPrefs({ color: c.value })} />
        ))}
        <i className="draw-sep" />
        <button type="button" className={s.fade ? "draw-btn on" : "draw-btn"} aria-pressed={s.fade} onClick={() => setPrefs({ fade: !s.fade })}
          title={s.fade ? t("draw.fadeOnHint") : t("draw.fadeOffHint")}
          aria-label={t("draw.fadeStrokes")}>{s.fade ? <Timer /> : <TimerOff />}</button>
        <button type="button" className="draw-btn" title={t("draw.undoHint", { keys: `${mod}+Z` })} aria-label={t("draw.undo")} onClick={() => command("undo")}><Undo2 /></button>
        <button type="button" className="draw-btn" title={t("draw.clearAllHint")} aria-label={t("draw.clearAll")} onClick={() => command("clear")}><Trash2 /></button>
        <button type="button" className="draw-btn draw-exit" title={t("draw.stopHint", { shortcut: s.shortcut.split("+").map((k) => keyLabel(k, false)).join("+") })} aria-label={t("draw.stop")} onClick={stop}><X /></button>
      </div>
      <p className="draw-hint"><kbd>Esc</kbd> {t("draw.hint.stop")} <kbd>{mod}</kbd><kbd>Z</kbd> {t("draw.hint.undo")} <kbd>C</kbd> {t("draw.hint.clear")} <span>{t("draw.hint.rubOut")}</span></p>
    </div>
  );
}
