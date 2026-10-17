// Everything the compositor draws over the picture. Inside the screen window: click rings, the
// spotlight and our own pointer. Over the whole frame: logo, name card, keystrokes, intro and outro.
// Text and the logo are painted once into their own canvases and reused until they change.
import { create } from "zustand";
import { api, hasBridge } from "./api";
import { keyFeedAlpha, pushKey, type KeyFeed } from "./keys-core";
import type { Rect } from "./layout-core";
import {
  KEY_SIZE, CARD_FADE_MS, anchorBox, approach, introAlpha, introSpanMs, logoRect, lowerThirdWanted, outroAlpha, outroSpanMs, rippleAt, viewToFrame,
  type CardLook, type LowerThirdLook,
} from "./overlays-core";
import { useRecord } from "./store";
import { Pending } from "./delay-core";
import { springStep, type Pt, type Spring } from "./zoom-core";

/** What the panel and the bar need to know about the overlays right now. */
export const useOverlays = create<{
  /** the screen capture leaves the system pointer out, so ours can be drawn */
  cursorHideable: boolean;
  keys: "off" | "on" | "unavailable";
  keysReason: string | null;
  /** the name card hotkey's choice for this take (null = follow the timing) */
  lowerThirdManual: boolean | null;
  /** Stop was pressed and the outro is playing until then */
  outroEndsAt: number | null;
  preview: { kind: "intro" | "outro"; at: number } | null;
}>(() => ({ cursorHideable: false, keys: "off", keysReason: null, lowerThirdManual: null, outroEndsAt: null, preview: null }));

const FONT = `"Geist", -apple-system, "Segoe UI", system-ui, sans-serif`;
export const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);

const RIPPLE_MS = 600;
const LOWER_THIRD_MS = 350;
type View = { sx: number; sy: number; sw: number; sh: number };
type Cached = { key: string; canvas: HTMLCanvasElement };

/** Words into lines no wider than maxW (at most `max` lines, the last one cut with an ellipsis). */
function wrap(g: CanvasRenderingContext2D, text: string, maxW: number, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width <= maxW || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > max) {
    lines.length = max;
    let last = lines[max - 1];
    while (last.length > 1 && g.measureText(last + "…").width > maxW) last = last.slice(0, -1);
    lines[max - 1] = last + "…";
  }
  return lines;
}

export class OverlayPainter {
  /** the picture runs this far behind real time (a delayed take): keys and the name card hotkey wait for it */
  delayMs = 0;
  private keyQueue = new Pending<Parameters<typeof pushKey>[1]>();
  private cardQueue = new Pending<boolean>();
  private ripples: { x: number; y: number; t: number }[] = [];
  private feed: KeyFeed | null = null;
  private target: Pt | null = null;
  private spring: { x: Spring; y: Spring } | null = null;
  private lastTick = 0;
  private takeStart: number | null = null;
  private outroStart: number | null = null;
  private ltValue = 0;
  private caches = new Map<string, Cached>();
  private logo: { src: string; img: HTMLImageElement; loaded: boolean } | null = null;

  constructor() {
    // the canvas cannot wait for a font: draw with the fallback, then repaint the text once Geist is in
    void document.fonts?.load(`600 40px "Geist"`).then(() => this.caches.clear(), () => {});
    if (!hasBridge()) return;
    api.onKeys((p) => {
      const k = useRecord.getState().keys;
      if (!k.enabled) return;
      this.keyQueue.push(Date.now(), p);
    });
    const sync = () => {
      const k = useRecord.getState().keys;
      if (!k.enabled) {
        this.feed = null;
        useOverlays.setState({ keys: "off", keysReason: null });
        void api.keysStop();
        return;
      }
      void api.keysStart(k.showAll).then((r) => useOverlays.setState({ keys: r.ok ? "on" : "unavailable", keysReason: r.reason ?? null }), () => {});
    };
    useRecord.subscribe((s, prev) => { if (s.keys.enabled !== prev.keys.enabled || s.keys.showAll !== prev.keys.showAll) sync(); });
    sync();
  }

  // ---- input ----

  /** A click at a point of the screen picture (0..1). */
  click(p: Pt, t: number) { this.ripples.push({ x: p.x, y: p.y, t }); }
  cursorTo(p: Pt) { this.target = p; }

  // ---- the take ----

  takeStarted(at: number) {
    this.takeStart = at;
    this.outroStart = null;
    useOverlays.setState({ lowerThirdManual: null, outroEndsAt: null, preview: null });
  }

  /** Starts the outro; returns how long the take must keep recording for it (0 when it is off). */
  startOutro(now: number): number {
    const ms = outroSpanMs(useRecord.getState().outro);
    if (ms > 0) { this.outroStart = now; useOverlays.setState({ outroEndsAt: now + ms + this.delayMs }); }
    return ms;
  }

  takeEnded() {
    this.takeStart = null;
    this.outroStart = null;
    useOverlays.setState({ lowerThirdManual: null, outroEndsAt: null });
  }

  /** The name card hotkey: shows it if hidden, hides it if showing (between takes too, as a preview). */
  toggleLowerThird() {
    const s = useRecord.getState();
    if (!s.lowerThird.enabled) return false;
    // shown when the picture reaches the press (a delayed take draws it that much later)
    const last = this.cardShown ?? this.ltValue > 0.5;
    this.cardShown = !last;
    this.cardQueue.push(Date.now(), !last);
    return true;
  }

  preview(kind: "intro" | "outro") { useOverlays.setState({ preview: { kind, at: Date.now() } }); }

  /** The overlays a take starting now carries (saved in its timeline). */
  activeList(): string[] {
    const s = useRecord.getState();
    const out: string[] = [];
    if (useOverlays.getState().cursorHideable && s.pointer.show) out.push("pointer");
    if (s.pointer.spotlight) out.push("spotlight");
    if (s.keys.enabled) out.push("keys");
    if (s.logo.enabled && s.logoImage) out.push("logo");
    if (s.lowerThird.enabled && (s.lowerThird.name || s.lowerThird.title)) out.push("name card");
    if (s.intro.enabled) out.push("intro");
    if (s.outro.enabled) out.push("outro");
    return out;
  }

  /** Once per frame: moves the smoothed pointer. */
  tick(now: number) {
    const dt = this.lastTick ? Math.min(100, Math.max(0, now - this.lastTick)) : 0;
    this.lastTick = now;
    // keystrokes join the feed when the picture reaches them
    const k = useRecord.getState().keys;
    for (const e of this.keyQueue.due(now)) this.feed = pushKey(this.feed, e.v, { showAll: k.showAll, mac: IS_MAC }, e.t);
    if (!this.target) return;
    if (!this.spring) { this.spring = { x: { value: this.target.x, velocity: 0 }, y: { value: this.target.y, velocity: 0 } }; return; }
    this.spring = { x: springStep(this.spring.x, this.target.x, dt, 16), y: springStep(this.spring.y, this.target.y, dt, 16) };
  }

  private smoothed(): Pt | null { return this.spring ? { x: this.spring.x.value, y: this.spring.y.value } : this.target; }

  // ---- inside the screen window (the caller has clipped to it) ----

  drawScreen(ctx: CanvasRenderingContext2D, r: Rect, view: View, k: number, now: number, zoom: number, alpha: number) {
    const p = useRecord.getState().pointer;
    this.ripples = this.ripples.filter((c) => now - c.t < RIPPLE_MS);
    const shownRipples = this.ripples.filter((c) => now >= c.t);
    const glide = this.smoothed();

    if (p.spotlight && glide) {
      const c = viewToFrame(glide, r, view);
      const rad = Math.max(8, p.spotlightSize * 1080 * k);
      const dim = Math.min(0.9, Math.max(0, p.spotlightDim));
      const g = ctx.createRadialGradient(c.x, c.y, rad * 0.82, c.x, c.y, rad * 1.12);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${dim.toFixed(3)})`);
      ctx.fillStyle = g;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }

    if (p.highlight) {
      for (const c of shownRipples) {
        const ring = rippleAt(now - c.t, RIPPLE_MS, Math.max(0.3, p.highlightSize));
        if (!ring) continue;
        const at = viewToFrame(c, r, view);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.arc(at.x, at.y, ring.radius * k, 0, Math.PI * 2);
        ctx.strokeStyle = p.highlightColor;
        ctx.globalAlpha = alpha * 0.75 * ring.alpha;
        ctx.lineWidth = 4 * k * Math.max(0.6, p.highlightSize);
        ctx.stroke();
        ctx.fillStyle = p.highlightColor;
        ctx.globalAlpha = alpha * 0.18 * ring.alpha;
        ctx.fill();
        ctx.restore();
      }
    }

    // our own pointer only where the capture left the system one out (otherwise there would be two)
    const at = p.smooth ? glide : this.target;
    if (p.show && useOverlays.getState().cursorHideable && at) this.drawPointer(ctx, viewToFrame(at, r, view), 1.25 * k * Math.max(1, Math.min(3, p.size)) * zoom, alpha);
  }

  /** A classic arrow, tip on the point, white with a dark edge. */
  private drawPointer(ctx: CanvasRenderingContext2D, at: Pt, s: number, alpha: number) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(at.x, at.y);
    ctx.scale(s, s);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, 17); ctx.lineTo(4.2, 13); ctx.lineTo(7, 19.4); ctx.lineTo(9.7, 18.3); ctx.lineTo(7, 12); ctx.lineTo(12.3, 12);
    ctx.closePath();
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = 3;
    ctx.shadowOffsetY = 1;
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineJoin = "round";
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "#111114";
    ctx.stroke();
    ctx.restore();
  }

  // ---- over the whole frame ----

  drawFrame(ctx: CanvasRenderingContext2D, W: number, H: number, k: number, now: number, bg: () => Cached) {
    const s = useRecord.getState();
    const o = useOverlays.getState();
    const dt = Math.min(100, Math.max(0, now - (this.frameT || now)));
    this.frameT = now;

    if (s.logo.enabled && s.logoImage) this.drawLogo(ctx, W, H);

    for (const e of this.cardQueue.due(now)) { useOverlays.setState({ lowerThirdManual: e.v }); if (this.cardShown === e.v) this.cardShown = null; }
    // before the take starts (the first moments of a delayed take) there is no take time yet
    const ms = this.takeStart != null && now >= this.takeStart ? now - this.takeStart : null;
    const introMs = ms != null ? introSpanMs(s.intro) : 0;
    this.ltValue = approach(this.ltValue, lowerThirdWanted(s.lowerThird, ms, introMs, o.lowerThirdManual), dt, LOWER_THIRD_MS);
    if (this.ltValue > 0) this.drawLowerThird(ctx, s.lowerThird, W, H, k, this.ltValue);

    if (s.keys.enabled) {
      const a = keyFeedAlpha(this.feed, now);
      if (a > 0 && this.feed) this.drawKeys(ctx, this.feed.text, s.keys.position, KEY_SIZE[s.keys.size] ?? 1, W, H, k, a);
    }

    // the cards go over everything
    let intro = ms != null ? introAlpha(s.intro, ms) : 0;
    let outro = this.outroStart != null ? outroAlpha(now - this.outroStart) : 0;
    if (o.preview) {
      const t = now - o.preview.at;
      if (o.preview.kind === "intro") {
        intro = Math.max(intro, introAlpha({ ...s.intro, enabled: true }, t));
        if (t > introSpanMs({ ...s.intro, enabled: true })) useOverlays.setState({ preview: null });
      } else {
        const span = outroSpanMs({ ...s.outro, enabled: true });
        outro = Math.max(outro, t < span ? outroAlpha(t) : Math.max(0, 1 - (t - span) / CARD_FADE_MS));
        if (t > span + CARD_FADE_MS) useOverlays.setState({ preview: null });
      }
    }
    if (intro > 0) this.drawCard(ctx, "intro", s.intro, W, H, k, intro, bg);
    if (outro > 0) this.drawCard(ctx, "outro", s.outro, W, H, k, outro, bg);
  }
  private frameT = 0;
  /** the name card state the last hotkey press asked for, until the picture reaches it */
  private cardShown: boolean | null = null;

  private cached(id: string, key: string, paint: (c: HTMLCanvasElement) => void): HTMLCanvasElement {
    const hit = this.caches.get(id);
    if (hit?.key === key) return hit.canvas;
    const c = hit?.canvas ?? document.createElement("canvas");
    paint(c);
    this.caches.set(id, { key, canvas: c });
    return c;
  }

  private drawLogo(ctx: CanvasRenderingContext2D, W: number, H: number) {
    const s = useRecord.getState();
    const src = s.logoImage!;
    if (this.logo?.src !== src) {
      const img = new Image();
      const entry = { src, img, loaded: false };
      img.onload = () => { entry.loaded = true; };
      img.src = src;
      this.logo = entry;
    }
    if (!this.logo.loaded) return;
    const img = this.logo.img;
    const r = logoRect(s.logo, img.naturalWidth, img.naturalHeight, W, H);
    ctx.save();
    ctx.globalAlpha = Math.min(1, Math.max(0.05, s.logo.opacity));
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, r.x, r.y, r.w, r.h);
    ctx.restore();
  }

  private drawKeys(ctx: CanvasRenderingContext2D, text: string, position: Parameters<typeof anchorBox>[0], size: number, W: number, H: number, k: number, alpha: number) {
    const fs = Math.round(34 * k * size);
    const pill = this.cached("keys", `${text}|${fs}`, (c) => {
      const g = c.getContext("2d")!;
      g.font = `600 ${fs}px ${FONT}`;
      const padX = fs * 0.75, padY = fs * 0.5;
      c.width = Math.ceil(g.measureText(text).width + padX * 2);
      c.height = Math.ceil(fs + padY * 2);
      g.fillStyle = "rgba(18,18,20,0.84)";
      g.beginPath();
      g.roundRect(0, 0, c.width, c.height, c.height / 2);
      g.fill();
      g.strokeStyle = "rgba(255,255,255,0.14)";
      g.lineWidth = Math.max(1, fs / 24);
      g.stroke();
      g.font = `600 ${fs}px ${FONT}`;
      g.fillStyle = "#ffffff";
      g.textBaseline = "middle";
      g.textAlign = "center";
      g.fillText(text, c.width / 2, c.height / 2 + fs * 0.04);
    });
    const m = Math.min(W, H) * 0.06;
    const r = anchorBox(position, pill.width, pill.height, W, H, m, m);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(pill, r.x, r.y + (1 - alpha) * 8 * k);
    ctx.restore();
  }

  private drawLowerThird(ctx: CanvasRenderingContext2D, lt: LowerThirdLook, W: number, H: number, k: number, v: number) {
    if (!lt.name.trim() && !lt.title.trim()) return;
    const nameFs = Math.round(46 * k), titleFs = Math.round(30 * k);
    const card = this.cached("lower-third", `${lt.name}|${lt.title}|${lt.style}|${lt.accent}|${nameFs}|${W}`, (c) => {
      const g = c.getContext("2d")!;
      const name = lt.name.trim(), title = lt.title.trim();
      const maxW = W * 0.6;
      g.font = `650 ${nameFs}px ${FONT}`;
      const nameW = name ? Math.min(maxW, g.measureText(name).width) : 0;
      g.font = `500 ${titleFs}px ${FONT}`;
      const titleW = title ? Math.min(maxW, g.measureText(title).width) : 0;
      const gap = name && title ? titleFs * 0.35 : 0;
      const textH = (name ? nameFs : 0) + gap + (title ? titleFs * 1.1 : 0);
      const padX = 28 * k, padY = 22 * k, bar = lt.style === "bar" ? 8 * k : 0, line = lt.style === "minimal" ? 6 * k : 0;
      const shadow = 24 * k;
      c.width = Math.ceil(Math.max(nameW, titleW) + padX * 2 + bar + shadow * 2);
      c.height = Math.ceil(textH + padY * 2 + line * 2 + shadow * 2);
      g.translate(shadow, shadow);
      const bw = c.width - shadow * 2, bh = c.height - shadow * 2;
      if (lt.style === "bar" || lt.style === "card") {
        g.save();
        g.shadowColor = "rgba(0,0,0,0.3)";
        g.shadowBlur = 20 * k;
        g.shadowOffsetY = 6 * k;
        g.fillStyle = lt.style === "bar" ? "rgba(14,14,16,0.82)" : "#ffffff";
        g.beginPath();
        g.roundRect(0, 0, bw, bh, (lt.style === "bar" ? 12 : 18) * k);
        g.fill();
        g.restore();
        if (bar) {
          // the accent runs down the panel's left edge, inside its rounded corners
          g.save();
          g.beginPath();
          g.roundRect(0, 0, bw, bh, 12 * k);
          g.clip();
          g.fillStyle = lt.accent;
          g.fillRect(0, 0, bar, bh);
          g.restore();
        }
      }
      const x = padX + bar;
      let y = padY;
      const textShadow = lt.style === "minimal";
      if (textShadow) { g.shadowColor = "rgba(0,0,0,0.55)"; g.shadowBlur = 12 * k; g.shadowOffsetY = 2 * k; }
      g.textBaseline = "top";
      if (name) {
        g.font = `650 ${nameFs}px ${FONT}`;
        g.fillStyle = lt.style === "card" ? "#111114" : "#ffffff";
        g.fillText(name, x, y, maxW);
        y += nameFs + gap;
      }
      if (line) {
        g.fillStyle = lt.accent;
        g.fillRect(x, y + line * 0.2, Math.min(nameW || titleW, 120 * k), line * 0.8);
        y += line * 1.6;
      }
      if (title) {
        g.font = `500 ${titleFs}px ${FONT}`;
        g.fillStyle = lt.style === "card" ? lt.accent : "rgba(255,255,255,0.78)";
        g.fillText(title, x, y, maxW);
      }
    });
    const pad = 24 * k;
    const m = Math.min(W, H) * 0.06;
    const r = anchorBox(lt.position, card.width - pad * 2, card.height - pad * 2, W, H, m, m * 1.2);
    const e = v * v * (3 - 2 * v);
    const slide = (1 - e) * 48 * k * (lt.position.endsWith("right") ? 1 : -1);
    ctx.save();
    ctx.globalAlpha = e;
    ctx.drawImage(card, r.x - pad + slide, r.y - pad);
    ctx.restore();
  }

  private drawCard(ctx: CanvasRenderingContext2D, id: string, card: CardLook, W: number, H: number, k: number, alpha: number, look: () => Cached) {
    const bg = card.background === "look" ? look() : null;
    const c = this.cached(id, `${card.title}|${card.subtitle}|${card.background}|${card.color}|${card.textColor}|${W}x${H}|${bg ? bg.key : ""}`, (c) => {
      c.width = W; c.height = H;
      const g = c.getContext("2d")!;
      if (bg) g.drawImage(bg.canvas, 0, 0, W, H);
      else { g.fillStyle = card.color; g.fillRect(0, 0, W, H); }
      const titleFs = Math.round(88 * k), subFs = Math.round(40 * k);
      g.font = `700 ${titleFs}px ${FONT}`;
      const title = wrap(g, card.title.trim(), W * 0.8, 3);
      g.font = `500 ${subFs}px ${FONT}`;
      const sub = wrap(g, card.subtitle.trim(), W * 0.75, 3);
      const titleLh = titleFs * 1.12, subLh = subFs * 1.35, gap = title.length && sub.length ? subFs * 0.8 : 0;
      let y = (H - (title.length * titleLh + gap + sub.length * subLh)) / 2;
      g.textAlign = "center";
      g.textBaseline = "top";
      g.fillStyle = card.textColor;
      g.font = `700 ${titleFs}px ${FONT}`;
      for (const l of title) { g.fillText(l, W / 2, y); y += titleLh; }
      y += gap;
      g.globalAlpha = 0.72;
      g.font = `500 ${subFs}px ${FONT}`;
      for (const l of sub) { g.fillText(l, W / 2, y); y += subLh; }
    });
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(c, 0, 0);
    ctx.restore();
  }
}
