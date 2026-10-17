// The live compositor: screen, camera bubble, frame and auto zoom drawn into one canvas.
// The canvas IS the recording (recorder.ts captures it), so the stage shows exactly what is recorded.
import { getStream, publishStream, subscribeStreams } from "@core/streams";
import type { BubbleLayout, CursorSample } from "@shared/types";
import { api, hasBridge } from "./api";
import {
  bubbleRadius, bubbleRect, cameraWindowRect, coverCrop, cropSource, gradientLine, needsCamera, needsScreen, pxScale,
  resolveBackground, screenRect, toCropSpace, type Rect,
} from "./layout-core";
import { currentLayout, useRecord } from "./store";
import { DEFAULT_ZOOM, DwellDetector, LiveZoom, type Pt } from "./zoom-core";

type PointerListener = { click?: (p: Pt & { t: number; button: number }) => void; cursor?: (s: CursorSample[]) => void };

function hiddenVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  return v;
}

const ready = (v: HTMLVideoElement) => v.srcObject != null && v.readyState >= 2 && v.videoWidth > 0;

class Compositor {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })!;
  private screenVideo = hiddenVideo();
  private cameraVideo = hiddenVideo();
  private zoom = new LiveZoom({ ...DEFAULT_ZOOM });
  private dwell = new DwellDetector();
  private cursor: Pt | null = null;
  private ripples: { x: number; y: number; t: number }[] = [];
  private listeners = new Set<PointerListener>();
  private fallbackCamera: MediaStream | null = null;
  private fallbackPending = false;
  private screenStream: MediaStream | null = null;
  private ticker: Worker | null = null;
  private tickFps = 0;
  /** hover feedback from the stage (bubble outline while dragging) */
  bubbleHover: "move" | "resize" | null = null;

  start() {
    if (this.ticker) return;
    // A worker clock instead of requestAnimationFrame: rAF stops when the window is minimized,
    // and the recording must not freeze while you work in another app.
    const src = "let id=null;onmessage=(e)=>{clearInterval(id);id=setInterval(()=>postMessage(0),e.data)}";
    this.ticker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    this.ticker.onmessage = () => this.draw();
    this.syncTicker();
    subscribeStreams(() => this.syncCamera());
    useRecord.subscribe((s, prev) => {
      if (s.fps !== prev.fps) this.syncTicker();
      if (s.mode !== prev.mode) this.syncCamera();
      if (s.zoomScale !== prev.zoomScale) this.zoom.opts = { ...this.zoom.opts, scale: s.zoomScale };
    });
    this.zoom.opts = { ...this.zoom.opts, scale: useRecord.getState().zoomScale };
    if (hasBridge()) {
      // the zoom and the ripples live in the cropped picture's space; listeners (the timeline) get
      // the raw display position, and the hi-res export applies the crop itself
      api.onClick((e) => {
        const p = toCropSpace(e, useRecord.getState().crop);
        this.zoom.click(p, e.t);
        this.ripples.push({ x: p.x, y: p.y, t: e.t });
        this.listeners.forEach((l) => l.click?.(e));
      });
      api.onCursor((samples) => {
        const crop = useRecord.getState().crop;
        const last = samples[samples.length - 1];
        if (last) { this.cursor = toCropSpace(last, crop); this.zoom.move(last.t); }
        if (!useRecord.getState().tracking?.hooks) {
          for (const s of samples) {
            const c = this.dwell.push(toCropSpace(s, crop));
            if (c) this.zoom.click(c, s.t);
          }
        }
        this.listeners.forEach((l) => l.cursor?.(samples));
      });
    }
    this.syncCamera();
  }

  private syncTicker() {
    const fps = useRecord.getState().fps;
    if (fps === this.tickFps || !this.ticker) return;
    this.tickFps = fps;
    this.ticker.postMessage(1000 / fps);
  }

  onPointer(l: PointerListener) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }

  // ---- sources ----

  async useScreen(sourceId: string | null, displayId: string | null) {
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    this.screenVideo.srcObject = null;
    publishStream("screen", null);
    if (!sourceId) {
      if (hasBridge()) await api.stopPointer();
      useRecord.getState().set({ tracking: null });
      return;
    }
    const fps = useRecord.getState().fps;
    // Electron's own desktop capture: we already chose the source in our picker, so no system
    // dialog; the mandatory constraints ask for the native resolution and the frame rate we draw at.
    const constraints = {
      audio: false,
      video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId, maxWidth: 3840, maxHeight: 2160, minFrameRate: 15, maxFrameRate: fps } },
    } as unknown as MediaStreamConstraints;
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.screenStream = stream;
    this.screenVideo.srcObject = stream;
    void this.screenVideo.play().catch(() => {});
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      if (this.screenStream === stream) {
        useRecord.getState().set({ sourceId: null, sourceName: null, displayId: null, notice: "The captured window closed." });
        void this.useScreen(null, null);
      }
    });
    publishStream("screen", stream);
    if (hasBridge()) {
      const tracking = await api.trackPointer(displayId ?? undefined);
      useRecord.getState().set({ tracking });
    }
    this.zoom.reset();
  }

  screenSize() {
    const s = this.screenStream?.getVideoTracks()[0]?.getSettings();
    return s?.width && s?.height ? { width: s.width, height: s.height } : undefined;
  }

  /** Prefer the camera module's filtered stream; open the default camera only when it has none. */
  private syncCamera() {
    const published = getStream("camera");
    const wanted = needsCamera(useRecord.getState().mode);
    if (published) {
      this.fallbackCamera?.getTracks().forEach((t) => t.stop());
      this.fallbackCamera = null;
      if (this.cameraVideo.srcObject !== published) { this.cameraVideo.srcObject = published; void this.cameraVideo.play().catch(() => {}); }
      useRecord.getState().set({ cameraSource: "module" });
      return;
    }
    if (!wanted) {
      this.fallbackCamera?.getTracks().forEach((t) => t.stop());
      this.fallbackCamera = null;
      this.cameraVideo.srcObject = null;
      useRecord.getState().set({ cameraSource: null });
      return;
    }
    if (this.fallbackCamera || this.fallbackPending) return;
    this.fallbackPending = true;
    // give the camera module a moment to publish before opening the device ourselves
    setTimeout(async () => {
      try {
        if (getStream("camera") || !needsCamera(useRecord.getState().mode)) return;
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }, audio: false });
        if (getStream("camera")) { s.getTracks().forEach((t) => t.stop()); return; }
        this.fallbackCamera = s;
        this.cameraVideo.srcObject = s;
        void this.cameraVideo.play().catch(() => {});
        useRecord.getState().set({ cameraSource: "fallback" });
      } catch {
        useRecord.getState().set({ cameraSource: "none" });
      } finally {
        this.fallbackPending = false;
      }
    }, 1500);
  }

  cameraStream(): MediaStream | null { return getStream("camera") ?? this.fallbackCamera; }
  cameraSize() {
    const s = this.cameraStream()?.getVideoTracks()[0]?.getSettings();
    return s?.width && s?.height ? { width: s.width, height: s.height } : undefined;
  }

  // ---- drawing ----

  /** The background is painted once into its own canvas and reused until it or the frame changes. */
  private bgCache: { key: string; canvas: HTMLCanvasElement } | null = null;
  private bgImage: { src: string; img: HTMLImageElement; loaded: boolean } | null = null;

  private draw() {
    const st = useRecord.getState();
    const L = currentLayout(st);
    const { width: W, height: H } = L;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const ctx = this.ctx;
    const now = Date.now();
    const k = pxScale(W, H);
    if (!st.tracking?.hooks) { const c = this.dwell.tick(now); if (c) this.zoom.click(c, now); }

    if (L.mode === "camera") {
      const cv = this.cameraVideo;
      if (L.padding > 0 || (L.screenScale ?? 1) < 1) {
        // the camera alone in a window over the background, styled like the screen window
        this.paintBackground(W, H);
        const r = cameraWindowRect(L);
        const radius = L.cornerRadius * k;
        this.frameShadow(r, radius, L.screenShadow ?? 0, k);
        ctx.save();
        this.roundRect(r.x, r.y, r.w, r.h, radius);
        ctx.clip();
        ctx.fillStyle = "#000";
        ctx.fillRect(r.x, r.y, r.w, r.h);
        if (ready(cv)) {
          const c = coverCrop(cv.videoWidth, cv.videoHeight, r.w, r.h);
          ctx.drawImage(cv, c.x, c.y, c.w, c.h, r.x, r.y, r.w, r.h);
        }
        ctx.restore();
        this.frameBorder(r, radius, (L.screenBorder ?? 0) * k, L.screenBorderColor);
        if (!ready(cv)) this.hint("Waiting for the camera");
        return;
      }
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      if (ready(cv)) {
        const c = coverCrop(cv.videoWidth, cv.videoHeight, W, H);
        ctx.drawImage(cv, c.x, c.y, c.w, c.h, 0, 0, W, H);
      } else this.hint("Waiting for the camera");
      return;
    }

    this.paintBackground(W, H);
    const sv = this.screenVideo;
    if (needsScreen(L.mode) && ready(sv)) {
      const vw = sv.videoWidth, vh = sv.videoHeight;
      // the kept part of the screen, then the zoom inside it
      const src = cropSource(L.crop, vw, vh);
      const r = screenRect(L, src.w, src.h);
      const f = L.zoom.enabled && st.tracking?.normalized ? this.zoom.update(now, this.cursor) : { scale: 1, x: 0.5, y: 0.5 };
      const sw = src.w / f.scale, sh = src.h / f.scale;
      const sx = src.x + Math.min(src.w - sw, Math.max(0, f.x * src.w - sw / 2));
      const sy = src.y + Math.min(src.h - sh, Math.max(0, f.y * src.h - sh / 2));
      const radius = L.cornerRadius * k;
      this.frameShadow(r, radius, L.screenShadow ?? 0, k);
      ctx.save();
      this.roundRect(r.x, r.y, r.w, r.h, radius);
      ctx.clip();
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(sv, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
      this.drawRipples(now, r, { sx: (sx - src.x) / src.w, sy: (sy - src.y) / src.h, sw: sw / src.w, sh: sh / src.h }, k);
      ctx.restore();
      this.frameBorder(r, radius, (L.screenBorder ?? 0) * k, L.screenBorderColor);
    } else if (needsScreen(L.mode)) {
      this.hint(st.sourceId ? "Starting the screen capture" : "Pick a screen or a window to record");
    }

    if (L.mode === "screen-camera") this.drawBubble(L.bubble, W, H, k);
  }

  private paintBackground(W: number, H: number) {
    const st = useRecord.getState();
    const spec = resolveBackground({ id: st.backgroundId, color: st.bgColor, color2: st.bgColor2, angle: st.bgAngle, image: st.bgImage, blur: st.bgBlur });
    if (spec.kind === "image" && this.bgImage?.src !== spec.src) {
      const img = new Image();
      const entry = { src: spec.src, img, loaded: false };
      img.onload = () => { entry.loaded = true; this.bgCache = null; };
      img.src = spec.src;
      this.bgImage = entry;
    }
    const imageReady = spec.kind === "image" && !!this.bgImage?.loaded;
    // the picture itself is keyed by identity (its data URL is long), the rest by value
    const key = spec.kind === "image"
      ? `${W}x${H}|image|${spec.blur}|${spec.color}|${spec.src.length}:${spec.src.slice(-64)}|${imageReady}`
      : `${W}x${H}|${JSON.stringify(spec)}`;
    if (this.bgCache?.key !== key) {
      const c = this.bgCache?.canvas ?? document.createElement("canvas");
      c.width = W; c.height = H;
      const g = c.getContext("2d")!;
      if (spec.kind === "gradient") {
        const l = gradientLine(spec.angle, W, H);
        const grad = g.createLinearGradient(l.x0, l.y0, l.x1, l.y1);
        spec.stops.forEach((s, i) => grad.addColorStop(i / Math.max(1, spec.stops.length - 1), s));
        g.fillStyle = grad;
      } else g.fillStyle = spec.color;
      g.fillRect(0, 0, W, H);
      if (spec.kind === "image" && imageReady && this.bgImage) {
        const img = this.bgImage.img;
        const blur = spec.blur * pxScale(W, H);
        // drawn a little larger when blurred, so the soft edge falls outside the frame
        const grow = blur * 2;
        const crop = coverCrop(img.naturalWidth, img.naturalHeight, W, H);
        g.filter = blur > 0 ? `blur(${blur}px)` : "none";
        g.drawImage(img, crop.x, crop.y, crop.w, crop.h, -grow, -grow, W + grow * 2, H + grow * 2);
        g.filter = "none";
      }
      this.bgCache = { key, canvas: c };
    }
    this.ctx.drawImage(this.bgCache.canvas, 0, 0);
  }

  private frameShadow(r: Rect, radius: number, amount: number, k: number) {
    if (amount <= 0) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${(0.25 + 0.35 * amount).toFixed(3)})`;
    ctx.shadowBlur = 64 * amount * k;
    ctx.shadowOffsetY = 20 * amount * k;
    ctx.fillStyle = "#000";
    this.roundRect(r.x, r.y, r.w, r.h, radius);
    ctx.fill();
    ctx.restore();
  }

  /** A border drawn inside the window's edge, so it never changes the window's size. */
  private frameBorder(r: Rect, radius: number, width: number, color: string | undefined) {
    if (width <= 0) return;
    const ctx = this.ctx;
    const h = width / 2;
    ctx.save();
    this.roundRect(r.x + h, r.y + h, r.w - width, r.h - width, Math.max(0, radius - h));
    ctx.lineWidth = width;
    ctx.strokeStyle = color || "#ffffff";
    ctx.stroke();
    ctx.restore();
  }

  private drawRipples(now: number, r: Rect, view: { sx: number; sy: number; sw: number; sh: number }, k: number) {
    const ctx = this.ctx;
    this.ripples = this.ripples.filter((p) => now - p.t < 600);
    for (const p of this.ripples) {
      const t = (now - p.t) / 600;
      const x = r.x + ((p.x - view.sx) / view.sw) * r.w;
      const y = r.y + ((p.y - view.sy) / view.sh) * r.h;
      ctx.beginPath();
      ctx.arc(x, y, (14 + 34 * t) * k, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.75 * (1 - t)})`;
      ctx.lineWidth = 4 * k;
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${0.18 * (1 - t)})`;
      ctx.fill();
    }
  }

  private drawBubble(layout: BubbleLayout, W: number, H: number, k: number) {
    const ctx = this.ctx;
    const b = bubbleRect(layout, W, H);
    const radius = bubbleRadius(layout, b);
    const shadow = layout.shadow ?? 0.6;
    if (shadow > 0) {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${(0.3 + 0.3 * shadow).toFixed(3)})`;
      ctx.shadowBlur = 56 * shadow * k;
      ctx.shadowOffsetY = 16 * shadow * k;
      ctx.fillStyle = "#1b1b1e";
      this.roundRect(b.x, b.y, b.w, b.h, radius);
      ctx.fill();
      ctx.restore();
    }
    ctx.save();
    this.roundRect(b.x, b.y, b.w, b.h, radius);
    ctx.clip();
    ctx.fillStyle = "#1b1b1e";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    if (ready(this.cameraVideo)) {
      const c = coverCrop(this.cameraVideo.videoWidth, this.cameraVideo.videoHeight, b.w, b.h);
      ctx.drawImage(this.cameraVideo, c.x, c.y, c.w, c.h, b.x, b.y, b.w, b.h);
    }
    ctx.restore();
    const border = (layout.border ?? 0) * k;
    if (border > 0) this.frameBorder(b, radius, border, layout.borderColor);
    if (this.bubbleHover && useRecord.getState().status === "idle") {
      // the drag outline only shows between takes
      this.roundRect(b.x, b.y, b.w, b.h, radius);
      ctx.lineWidth = 3 * k;
      ctx.strokeStyle = "rgba(61,220,151,0.9)";
      ctx.stroke();
    } else if (border <= 0) {
      this.roundRect(b.x, b.y, b.w, b.h, radius);
      ctx.lineWidth = 2 * k;
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.stroke();
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (r <= 0) ctx.rect(x, y, w, h);
    else ctx.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  }

  private hint(text: string) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.font = `500 ${Math.round(this.canvas.height / 32)}px -apple-system, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, this.canvas.width / 2, this.canvas.height / 2);
  }
}

let instance: Compositor | null = null;
export function compositor(): Compositor {
  if (!instance) { instance = new Compositor(); instance.start(); }
  return instance;
}
