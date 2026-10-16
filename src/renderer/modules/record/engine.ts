// The live compositor: screen, camera bubble, frame and auto zoom drawn into one canvas.
// The canvas IS the recording (recorder.ts captures it), so the stage shows exactly what is recorded.
import { getStream, publishStream, subscribeStreams } from "@core/streams";
import type { CursorSample } from "@shared/types";
import { api, hasBridge } from "./api";
import { BACKGROUNDS, bubbleRect, coverCrop, needsCamera, needsScreen, screenRect } from "./layout-core";
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
      api.onClick((e) => {
        this.zoom.click(e, e.t);
        this.ripples.push({ x: e.x, y: e.y, t: e.t });
        this.listeners.forEach((l) => l.click?.(e));
      });
      api.onCursor((samples) => {
        const last = samples[samples.length - 1];
        if (last) { this.cursor = last; this.zoom.move(last.t); }
        if (!useRecord.getState().tracking?.hooks) {
          for (const s of samples) {
            const c = this.dwell.push(s);
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

  private draw() {
    const st = useRecord.getState();
    const L = currentLayout(st);
    const { width: W, height: H } = L;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const ctx = this.ctx;
    const now = Date.now();
    if (!st.tracking?.hooks) { const c = this.dwell.tick(now); if (c) this.zoom.click(c, now); }

    if (L.mode === "camera") {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      if (ready(this.cameraVideo)) {
        const c = coverCrop(this.cameraVideo.videoWidth, this.cameraVideo.videoHeight, W, H);
        ctx.drawImage(this.cameraVideo, c.x, c.y, c.w, c.h, 0, 0, W, H);
      } else this.hint("Waiting for the camera");
      return;
    }

    this.paintBackground(L.background, W, H);
    const sv = this.screenVideo;
    if (needsScreen(L.mode) && ready(sv)) {
      const vw = sv.videoWidth, vh = sv.videoHeight;
      const r = screenRect(L, vw, vh);
      const f = L.zoom.enabled && st.tracking?.normalized ? this.zoom.update(now, this.cursor) : { scale: 1, x: 0.5, y: 0.5 };
      const sw = vw / f.scale, sh = vh / f.scale;
      const sx = Math.min(vw - sw, Math.max(0, f.x * vw - sw / 2));
      const sy = Math.min(vh - sh, Math.max(0, f.y * vh - sh / 2));
      const radius = L.padding > 0 ? L.cornerRadius : 0;
      if (L.padding > 0) {
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.45)";
        ctx.shadowBlur = 48;
        ctx.shadowOffsetY = 16;
        ctx.fillStyle = "#000";
        this.roundRect(r.x, r.y, r.w, r.h, radius);
        ctx.fill();
        ctx.restore();
      }
      ctx.save();
      this.roundRect(r.x, r.y, r.w, r.h, radius);
      ctx.clip();
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(sv, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
      this.drawRipples(now, r, { sx: sx / vw, sy: sy / vh, sw: sw / vw, sh: sh / vh });
      ctx.restore();
    } else if (needsScreen(L.mode)) {
      this.hint(st.sourceId ? "Starting the screen capture" : "Pick a screen or a window to record");
    }

    if (L.mode === "screen-camera") this.drawBubble(L.bubble, W, H);
  }

  private paintBackground(id: string, W: number, H: number) {
    const ctx = this.ctx;
    const bg = BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0];
    if (bg.stops.length > 1) {
      const g = ctx.createLinearGradient(0, 0, W, H);
      bg.stops.forEach((c, i) => g.addColorStop(i / (bg.stops.length - 1), c));
      ctx.fillStyle = g;
    } else ctx.fillStyle = bg.stops[0];
    ctx.fillRect(0, 0, W, H);
  }

  private drawRipples(now: number, r: { x: number; y: number; w: number; h: number }, view: { sx: number; sy: number; sw: number; sh: number }) {
    const ctx = this.ctx;
    this.ripples = this.ripples.filter((p) => now - p.t < 600);
    for (const p of this.ripples) {
      const k = (now - p.t) / 600;
      const x = r.x + ((p.x - view.sx) / view.sw) * r.w;
      const y = r.y + ((p.y - view.sy) / view.sh) * r.h;
      ctx.beginPath();
      ctx.arc(x, y, 14 + 34 * k, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.75 * (1 - k)})`;
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.fillStyle = `rgba(255,255,255,${0.18 * (1 - k)})`;
      ctx.fill();
    }
  }

  private bubblePath(b: ReturnType<typeof bubbleRect>, shape: "circle" | "rounded") {
    if (shape === "circle") {
      this.ctx.beginPath();
      this.ctx.arc(b.x + b.w / 2, b.y + b.h / 2, b.w / 2, 0, Math.PI * 2);
    } else this.roundRect(b.x, b.y, b.w, b.h, Math.min(b.w, b.h) * 0.18);
  }

  private drawBubble(layout: { cx: number; cy: number; size: number; shape: "circle" | "rounded" }, W: number, H: number) {
    const ctx = this.ctx;
    const b = bubbleRect(layout, W, H);
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 40;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = "#1b1b1e";
    this.bubblePath(b, layout.shape);
    ctx.fill();
    ctx.restore();
    ctx.save();
    this.bubblePath(b, layout.shape);
    ctx.clip();
    if (ready(this.cameraVideo)) {
      const c = coverCrop(this.cameraVideo.videoWidth, this.cameraVideo.videoHeight, b.w, b.h);
      ctx.drawImage(this.cameraVideo, c.x, c.y, c.w, c.h, b.x, b.y, b.w, b.h);
    }
    ctx.restore();
    this.bubblePath(b, layout.shape);
    ctx.lineWidth = 3;
    ctx.strokeStyle = this.bubbleHover && useRecord.getState().status === "idle" ? "rgba(61,220,151,0.9)" : "rgba(255,255,255,0.18)";
    ctx.stroke();
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number) {
    const ctx = this.ctx;
    ctx.beginPath();
    if (r <= 0) ctx.rect(x, y, w, h);
    else ctx.roundRect(x, y, w, h, r);
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
