// The editor's timeline: ruler, waveform, kept and cut stretches, caption blocks and the playhead.
// The whole take is laid out in a scroller; the canvas draws only what is in view.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { CaptionLine, TakePeaks, TimeRange } from "@shared/types";
import { formatTime, gaps, rulerStep } from "./edit-core";

export type Selection = { kind: "keep"; index: number } | { kind: "gap"; range: TimeRange } | null;

export interface TimelineProps {
  durationMs: number;
  keep: TimeRange[];
  peaks: TakePeaks | null;
  lines: CaptionLine[] | null;
  playhead: number;
  /** 1 = the whole take fits the width */
  zoom: number;
  selection: Selection;
  onSeek: (ms: number) => void;
  onSelect: (s: Selection) => void;
  onZoom: (z: number) => void;
}

const RULER = 22, WAVE = 64, CAPS = 22, PAD = 6;
export const TIMELINE_HEIGHT = RULER + WAVE + CAPS + PAD * 3;
export const MAX_ZOOM = 200;

function colours(el: HTMLElement) {
  const s = getComputedStyle(el);
  const v = (n: string) => s.getPropertyValue(n).trim() || "#888";
  return { text: v("--text"), muted: v("--muted"), faint: v("--faint"), brand: v("--brand"), border: v("--card-border"), track: v("--track"), card: v("--card"), rec: v("--rec") };
}

export function Timeline(p: TimelineProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(800);
  const [scroll, setScroll] = useState(0);
  const dragging = useRef(false);
  const durSec = Math.max(0.001, p.durationMs / 1000);
  const pps = (width / durSec) * p.zoom; // pixels per second
  const total = durSec * pps;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // keep the playhead in view while it moves
  useEffect(() => {
    const el = scroller.current;
    if (!el || dragging.current) return;
    const x = (p.playhead / 1000) * pps;
    if (x < el.scrollLeft || x > el.scrollLeft + width - 24) el.scrollLeft = Math.max(0, x - width * 0.2);
  }, [p.playhead, pps, width]);

  // zoom around the pointer with Ctrl + wheel; a plain wheel scrolls sideways
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const r = el.getBoundingClientRect();
        const at = (el.scrollLeft + e.clientX - r.left) / pps; // seconds under the pointer
        const z = Math.min(MAX_ZOOM, Math.max(1, p.zoom * Math.exp(-e.deltaY * 0.002)));
        p.onZoom(z);
        requestAnimationFrame(() => { el.scrollLeft = at * (width / durSec) * z - (e.clientX - r.left); });
      } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && p.zoom > 1) {
        e.preventDefault();
        el.scrollLeft += e.deltaY;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [p, pps, width, durSec]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(TIMELINE_HEIGHT * dpr);
    const g = c.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, TIMELINE_HEIGHT);
    const col = colours(c);
    const x = (ms: number) => (ms / 1000) * pps - scroll;
    const t0 = (scroll / pps) * 1000, t1 = ((scroll + width) / pps) * 1000;

    // ruler
    const step = rulerStep(pps);
    g.font = "12px Geist, system-ui, sans-serif";
    g.fillStyle = col.muted;
    g.strokeStyle = col.border;
    g.lineWidth = 1;
    for (let s = Math.floor(t0 / 1000 / step) * step; s * 1000 <= t1; s += step) {
      const px = Math.round(x(s * 1000)) + 0.5;
      g.beginPath(); g.moveTo(px, RULER - 6); g.lineTo(px, RULER); g.stroke();
      g.fillText(formatTime(s * 1000, step < 1), px + 4, 13);
    }

    const waveTop = RULER + PAD;
    const mid = waveTop + WAVE / 2;
    // cut stretches: dimmed, hatched
    for (const gap of gaps(p.keep, p.durationMs)) {
      const a = x(gap.start), b = x(gap.end);
      if (b < 0 || a > width) continue;
      g.fillStyle = col.track;
      g.fillRect(a, waveTop, b - a, WAVE);
      g.save();
      g.beginPath(); g.rect(a, waveTop, b - a, WAVE); g.clip();
      g.strokeStyle = col.border;
      for (let h = a - WAVE; h < b; h += 8) { g.beginPath(); g.moveTo(h, waveTop + WAVE); g.lineTo(h + WAVE, waveTop); g.stroke(); }
      g.restore();
      if (p.selection?.kind === "gap" && p.selection.range.start === gap.start) {
        g.strokeStyle = col.text; g.lineWidth = 2; g.strokeRect(a + 1, waveTop + 1, b - a - 2, WAVE - 2); g.lineWidth = 1;
      }
    }
    // kept stretches
    p.keep.forEach((r, i) => {
      const a = x(r.start), b = x(r.end);
      if (b < 0 || a > width) return;
      const sel = p.selection?.kind === "keep" && p.selection.index === i;
      g.fillStyle = col.brand;
      g.globalAlpha = sel ? 0.2 : 0.08;
      g.beginPath(); g.roundRect(a + 0.5, waveTop, Math.max(1, b - a - 1), WAVE, 6); g.fill();
      g.strokeStyle = col.brand;
      g.globalAlpha = sel ? 1 : 0.35;
      g.lineWidth = sel ? 2 : 1;
      g.beginPath(); g.roundRect(a + 0.5, waveTop + 0.5, Math.max(1, b - a - 1), WAVE - 1, 6); g.stroke();
      g.globalAlpha = 1;
      g.lineWidth = 1;
    });
    // waveform
    if (p.peaks) {
      const per = p.peaks.perSecond;
      g.fillStyle = col.faint;
      for (let px = 0; px < width; px++) {
        const a = ((scroll + px) / pps) * per, b = ((scroll + px + 1) / pps) * per;
        let m = 0;
        for (let i = Math.floor(a); i < Math.max(Math.floor(a) + 1, Math.ceil(b)); i++) m = Math.max(m, p.peaks.peaks[i] ?? 0);
        if (m <= 0) continue;
        const h = Math.max(1, Math.sqrt(m) * (WAVE / 2 - 4));
        // what was cut is drawn faint
        g.globalAlpha = p.keep.some((k) => { const t = ((scroll + px) / pps) * 1000; return t >= k.start && t < k.end; }) ? 1 : 0.3;
        g.fillRect(px, mid - h, 1, h * 2);
      }
      g.globalAlpha = 1;
    }
    // captions
    if (p.lines) {
      const top = waveTop + WAVE + PAD;
      g.font = "11px Geist, system-ui, sans-serif";
      for (const l of p.lines) {
        const a = x(l.start), b = x(l.end);
        if (b < 0 || a > width) continue;
        g.fillStyle = col.text;
        g.globalAlpha = 0.08;
        g.beginPath(); g.roundRect(a + 0.5, top, Math.max(2, b - a - 1), CAPS, 4); g.fill();
        g.globalAlpha = 1;
        if (b - a > 24) {
          g.save(); g.beginPath(); g.rect(a + 4, top, b - a - 8, CAPS); g.clip();
          g.fillStyle = col.muted;
          g.fillText(l.words.map((w) => w.text).join(" "), a + 5, top + 15);
          g.restore();
        }
      }
    }
    // playhead
    const ph = Math.round(x(p.playhead)) + 0.5;
    g.strokeStyle = col.text; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(ph, 2); g.lineTo(ph, TIMELINE_HEIGHT); g.stroke();
    g.fillStyle = col.text;
    g.beginPath(); g.moveTo(ph - 5, 0); g.lineTo(ph + 5, 0); g.lineTo(ph, 7); g.closePath(); g.fill();
  }, [p.keep, p.peaks, p.lines, p.playhead, p.selection, p.durationMs, pps, width, scroll]);

  const timeAt = (e: ReactPointerEvent) => {
    const r = scroller.current!.getBoundingClientRect();
    return Math.max(0, Math.min(p.durationMs, ((e.clientX - r.left + scroll) / pps) * 1000));
  };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const r = scroller.current!.getBoundingClientRect();
    if (e.clientY - r.top > TIMELINE_HEIGHT) return; // the scrollbar
    const t = timeAt(e);
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // a click on the waveform row picks the stretch under it; anywhere else only moves the playhead
    const y = e.clientY - r.top;
    if (y >= RULER + PAD && y <= RULER + PAD + WAVE) {
      const i = p.keep.findIndex((k) => t >= k.start && t < k.end);
      if (i >= 0) p.onSelect({ kind: "keep", index: i });
      else {
        const gap = gaps(p.keep, p.durationMs).find((g) => t >= g.start && t < g.end);
        p.onSelect(gap ? { kind: "gap", range: gap } : null);
      }
    }
    p.onSeek(t);
  };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => { if (dragging.current) p.onSeek(timeAt(e)); };
  const up = () => { dragging.current = false; };

  return (
    <div className="ed-timeline" ref={scroller} onScroll={(e) => setScroll(e.currentTarget.scrollLeft)}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <canvas ref={canvas} className="ed-canvas" style={{ width, height: TIMELINE_HEIGHT }} />
      <div style={{ width: total, height: 1 }} />
    </div>
  );
}
