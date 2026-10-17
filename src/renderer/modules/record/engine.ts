// The live compositor: screen, camera bubble, frame and auto zoom drawn into one canvas.
// The canvas IS the recording (recorder.ts captures it), so the stage shows exactly what is recorded.
// During a take with auto zoom everything is drawn DELAY_MS behind real time (delay-core.ts), from
// rings of stored frames, so the zoom can start before the click it serves.
import { getStream, publishStream, subscribeStreams } from "@core/streams";
import type { CursorSample, RecordLayout, RecordMode } from "@shared/types";
import { t } from "../../../shared/i18n";
import { api, hasBridge } from "./api";
import {
  coverCrop, cropSource, gradientLine, needsCamera, needsScreen, pxScale, resolveBackground, toCropSpace, type Rect,
} from "./layout-core";
import { History, planDelay, ringSlots, storeSize } from "./delay-core";
import { FrameRing, type StoredFrame } from "./frame-ring";
import { OverlayPainter, useOverlays } from "./overlays";
import { SCENE_MS, blendScenes, coversFrame, easeInOutCubic, sceneGeometry, type CameraLayer, type Layer, type SceneGeom } from "./scenes-core";
import { currentLayout, isBusy, useRecord } from "./store";
import { DEFAULT_ZOOM, DwellDetector, LiveZoom, cursorAt, type Pt, type TimedPt } from "./zoom-core";

type PointerListener = { click?: (p: Pt & { t: number; button: number }) => void; cursor?: (s: CursorSample[]) => void };

function hiddenVideo(): HTMLVideoElement {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  return v;
}

const ready = (v: HTMLVideoElement) => v.srcObject != null && v.readyState >= 2 && v.videoWidth > 0;

/** A picture to draw: a live video or a stored frame, and its size in pixels. */
interface Source { img: CanvasImageSource; w: number; h: number }

class Compositor {
  readonly canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })!;
  private screenVideo = hiddenVideo();
  private cameraVideo = hiddenVideo();
  private zoom = new LiveZoom({ ...DEFAULT_ZOOM });
  private dwell = new DwellDetector();
  private cursor: Pt | null = null;
  /** click rings, spotlight, our own pointer, keys, logo, name card, intro and outro */
  readonly overlays = new OverlayPainter();
  private listeners = new Set<PointerListener>();
  private fallbackCamera: MediaStream | null = null;
  private fallbackPending = false;
  private screenStream: MediaStream | null = null;
  private ticker: Worker | null = null;
  private tickFps = 0;
  /** the scene on screen, and the switch animating into it */
  private shownMode: RecordMode | null = null;
  private trans: { from: SceneGeom; start: number } | null = null;
  private lastGeom: SceneGeom | null = null;
  private geomSize = "";
  /** a take that used the camera keeps it open until it ends, so switching back is instant */
  private keepCamera = false;
  /** hover feedback from the stage (bubble outline while dragging) */
  bubbleHover: "move" | "resize" | null = null;
  /** how far behind real time the picture is drawn (0 outside a delayed take) */
  private delayMs = 0;
  private rings: { screen: FrameRing; camera: FrameRing } | null = null;
  /** the cursor (cropped-picture space) and the scene, by real time, for the delayed picture */
  private cursorTrail: TimedPt[] = [];
  private modes = new History<RecordMode>(10_000);

  start() {
    if (this.ticker) return;
    // A worker clock instead of requestAnimationFrame: rAF stops when the window is minimized,
    // and the recording must not freeze while you work in another app.
    const src = "let id=null;onmessage=(e)=>{clearInterval(id);id=setInterval(()=>postMessage(0),e.data)}";
    this.ticker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    this.ticker.onmessage = () => this.draw();
    this.syncTicker();
    subscribeStreams(() => this.syncCamera());
    this.modes.push(Date.now(), useRecord.getState().mode);
    useRecord.subscribe((s, prev) => {
      if (s.mode !== prev.mode) this.modes.push(Date.now(), s.mode);
      if (s.fps !== prev.fps) this.syncTicker();
      if (s.mode !== prev.mode || s.status !== prev.status) this.syncCamera();
      if (s.zoomScale !== prev.zoomScale) this.zoom.opts = { ...this.zoom.opts, scale: s.zoomScale };
    });
    this.zoom.opts = { ...this.zoom.opts, scale: useRecord.getState().zoomScale };
    if (hasBridge()) {
      // the zoom and the ripples live in the cropped picture's space; listeners (the timeline) get
      // the raw display position, and the hi-res export applies the crop itself
      api.onClick((e) => {
        const p = toCropSpace(e, useRecord.getState().crop);
        this.zoom.click(p, e.t);
        this.overlays.click(p, e.t);
        this.listeners.forEach((l) => l.click?.(e));
      });
      api.onCursor((samples) => {
        const crop = useRecord.getState().crop;
        const last = samples[samples.length - 1];
        if (last) { this.cursor = toCropSpace(last, crop); this.zoom.move(last.t); }
        for (const s of samples) this.cursorTrail.push(toCropSpace(s, crop));
        const cut = Date.now() - 4000;
        if (this.cursorTrail.length > 600 || this.cursorTrail[0]?.t < cut) this.cursorTrail = this.cursorTrail.filter((p) => p.t >= cut);
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
    useOverlays.setState({ cursorHideable: false });
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
        useRecord.getState().set({ sourceId: null, sourceName: null, displayId: null, notice: t("record.notice.windowClosedShort") });
        void this.useScreen(null, null);
      }
    });
    publishStream("screen", stream);
    // our own pointer can only be drawn where the capture leaves the system one out. Chromium's desktop
    // capture reports cursor "always" today (asking for "never" is ignored), so this stays false for now.
    const cursorMode = (stream.getVideoTracks()[0]?.getSettings() as { cursor?: string } | undefined)?.cursor;
    useOverlays.setState({ cursorHideable: cursorMode === "never" });
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

  /** The camera is needed by the scene on screen, or was used earlier in this take. */
  private cameraWanted() {
    const s = useRecord.getState();
    const busy = isBusy(s.status);
    if (busy && needsCamera(s.mode)) this.keepCamera = true;
    if (!busy) this.keepCamera = false;
    return needsCamera(s.mode) || this.keepCamera;
  }

  /** Prefer the camera module's filtered stream; open the default camera only when it has none. */
  private syncCamera() {
    const published = getStream("camera");
    const wanted = this.cameraWanted();
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
    // give the camera module a moment to publish before opening the device ourselves (not mid-take:
    // a scene switch is waiting for it, and the module would have published already)
    setTimeout(async () => {
      try {
        if (getStream("camera") || !this.cameraWanted()) return;
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
    }, isBusy(useRecord.getState().status) ? 0 : 1500);
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
    const live = currentLayout(st);
    const { width: W, height: H } = live;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    const now = Date.now();
    // the time the picture shows: real time, or DELAY_MS behind it during a delayed take
    const at = now - this.delayMs;
    const k = pxScale(W, H);
    if (!st.tracking?.hooks) { const c = this.dwell.tick(now); if (c) this.zoom.click(c, now); }

    const sv = this.screenVideo;
    const src = ready(sv) ? cropSource(live.crop, sv.videoWidth, sv.videoHeight) : null;
    if (this.rings) this.storeFrames(live, src, now);
    // the scene in force at that time (a switch shows when the picture reaches it)
    const L = this.delayMs ? { ...live, mode: this.modes.at(at) ?? live.mode } : live;
    const screen = this.screenSource(src, at);
    const camera = this.cameraSource(at);
    const cursor = this.delayMs ? cursorAt(this.cursorTrail, at) : this.cursor;
    if (cursor) this.overlays.cursorTo(cursor);
    this.overlays.tick(at);
    const g = this.sceneAt(L, src, at);

    if (!(coversFrame(g.camera, W, H) && camera)) this.paintBackground(W, H);
    if (g.screen && src && screen) this.drawScreen(g.screen, screen, L, st, at, k, cursor);
    if (g.camera) this.drawCamera(g.camera, camera, k, !this.trans && L.mode === "screen-camera");
    if (!this.trans) {
      if (needsScreen(L.mode) && !src) this.hint(st.sourceId ? t("record.stage.starting") : t("record.stage.pick"));
      else if (L.mode === "camera" && !camera) this.hint(t("record.stage.waitingCamera"));
    }
    this.overlays.drawFrame(this.ctx, W, H, k, at, () => this.background(W, H));
  }

  // ---- the delayed picture ----

  /** The kept part of the screen at time t: the live video, or the frame stored for t. */
  private screenSource(src: Rect | null, t: number): (Source & { region: Rect }) | null {
    if (!src) return null;
    if (!this.delayMs || !this.rings) return { img: this.screenVideo, w: this.screenVideo.videoWidth, h: this.screenVideo.videoHeight, region: src };
    const f = this.rings.screen.at(t, 1000 / useRecord.getState().fps);
    return f ? { img: f.canvas, w: f.w, h: f.h, region: { x: 0, y: 0, w: f.w, h: f.h } } : null;
  }

  private cameraSource(t: number): Source | null {
    const cv = this.cameraVideo;
    if (!this.delayMs || !this.rings) return ready(cv) ? { img: cv, w: cv.videoWidth, h: cv.videoHeight } : null;
    const f: StoredFrame | null = this.rings.camera.at(t, 1000 / useRecord.getState().fps);
    return f && f.w > 2 ? { img: f.canvas, w: f.w, h: f.h } : null;
  }

  /** The window sizes a stored frame must serve: this scene's, and the one before it while a switch into this one can still be drawn. */
  private boxes(L: RecordLayout, src: Rect | null, now: number) {
    const modes = [L.mode, this.modes.at(now - SCENE_MS - 200) ?? L.mode];
    let screen = { w: 0, h: 0 }, camera = { w: 0, h: 0 };
    for (const mode of modes) {
      const g = sceneGeometry({ ...L, mode }, src);
      if (g.screen) screen = { w: Math.max(screen.w, g.screen.rect.w), h: Math.max(screen.h, g.screen.rect.h) };
      if (g.camera) camera = { w: Math.max(camera.w, g.camera.rect.w), h: Math.max(camera.h, g.camera.rect.h) };
    }
    return { screen, camera };
  }

  /** Each tick of a delayed take: the newest screen and camera frames into their rings, at the size they will be shown. */
  private storeFrames(L: RecordLayout, src: Rect | null, now: number) {
    const rings = this.rings!;
    const box = this.boxes(L, src, now);
    const sv = this.screenVideo, cv = this.cameraVideo;
    if (src && box.screen.w) {
      const s = storeSize({ w: src.w, h: src.h }, box.screen, this.zoom.opts.scale);
      rings.screen.push(sv, src.x, src.y, src.w, src.h, s.w, s.h, now);
    }
    if (ready(cv) && box.camera.w) {
      // the whole camera frame, enough of it for the window's crop
      const c = coverCrop(cv.videoWidth, cv.videoHeight, box.camera.w, box.camera.h);
      const s = storeSize({ w: cv.videoWidth, h: cv.videoHeight }, { w: box.camera.w * (cv.videoWidth / c.w), h: box.camera.h * (cv.videoHeight / c.h) });
      rings.camera.push(cv, 0, 0, cv.videoWidth, cv.videoHeight, s.w, s.h, now);
    }
  }

  /**
   * Starts drawing the picture DELAY_MS behind real time for a take, when auto zoom is on and the
   * frames fit in memory; returns the delay (0: the take runs live) and why not, for a hint.
   */
  beginDelay(): { delayMs: number; reason: string | null } {
    const st = useRecord.getState();
    const L = currentLayout(st);
    const sv = this.screenVideo, cv = this.cameraVideo;
    const src = ready(sv) ? cropSource(L.crop, sv.videoWidth, sv.videoHeight) : null;
    const box = this.boxes(L, src, Date.now());
    const screen = src ? storeSize({ w: src.w, h: src.h }, box.screen, st.zoomScale) : { w: 0, h: 0 };
    const camera = ready(cv) && box.camera.w ? storeSize({ w: cv.videoWidth, h: cv.videoHeight }, box.camera) : { w: 0, h: 0 };
    const plan = planDelay({
      zoomEnabled: L.zoom.enabled, normalized: !!st.tracking?.normalized, mode: L.mode, fps: L.fps, screen, camera,
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    });
    if (!plan.delayMs || !src) return { delayMs: 0, reason: plan.reason };
    const slots = ringSlots(plan.delayMs, 1000 / L.fps);
    this.rings = { screen: new FrameRing(slots), camera: new FrameRing(slots) };
    this.delayMs = plan.delayMs;
    this.overlays.delayMs = plan.delayMs;
    return { delayMs: plan.delayMs, reason: null };
  }

  /** Back to the live picture once the take's composite has stopped. */
  endDelay() {
    this.delayMs = 0;
    this.overlays.delayMs = 0;
    this.rings?.screen.release();
    this.rings?.camera.release();
    this.rings = null;
  }

  /** Where everything sits this frame: the scene's own layout, or part way through a switch into it. */
  private sceneAt(L: RecordLayout, src: Rect | null, now: number): SceneGeom {
    const target = sceneGeometry(L, src);
    const size = `${L.width}x${L.height}`;
    if (size !== this.geomSize) { this.geomSize = size; this.trans = null; this.lastGeom = null; this.shownMode = L.mode; }
    if (this.shownMode !== L.mode) {
      // from wherever the picture is now, so a switch during a switch carries on smoothly
      if (this.lastGeom) this.trans = { from: this.lastGeom, start: now };
      this.shownMode = L.mode;
    }
    let g = target;
    if (this.trans) {
      const t = Math.max(0, (now - this.trans.start) / SCENE_MS);
      if (t >= 1) this.trans = null;
      else g = blendScenes(this.trans.from, target, easeInOutCubic(t));
    }
    this.lastGeom = g;
    return g;
  }

  /** The kept part of the screen in its window, the zoom inside it, and the pointer layer on top. */
  private drawScreen(layer: Layer, source: Source & { region: Rect }, L: RecordLayout, st: ReturnType<typeof useRecord.getState>, now: number, k: number, cursor: Pt | null) {
    const ctx = this.ctx;
    const r = layer.rect;
    const src = source.region;
    // a delayed take knows where the cursor is going next, as the export does
    const ahead = this.delayMs ? cursorAt(this.cursorTrail, now + this.zoom.opts.cursorLeadMs) : cursor;
    const f = L.zoom.enabled && st.tracking?.normalized ? this.zoom.update(now, cursor, ahead) : { scale: 1, x: 0.5, y: 0.5 };
    const sw = src.w / f.scale, sh = src.h / f.scale;
    const sx = src.x + Math.min(src.w - sw, Math.max(0, f.x * src.w - sw / 2));
    const sy = src.y + Math.min(src.h - sh, Math.max(0, f.y * src.h - sh / 2));
    ctx.save();
    ctx.globalAlpha = layer.alpha;
    this.frameShadow(r, layer.radius, layer.shadow, k);
    ctx.save();
    this.roundRect(r.x, r.y, r.w, r.h, layer.radius);
    ctx.clip();
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source.img, sx, sy, sw, sh, r.x, r.y, r.w, r.h);
    const view = { sx: (sx - src.x) / src.w, sy: (sy - src.y) / src.h, sw: sw / src.w, sh: sh / src.h };
    this.overlays.drawScreen(ctx, r, view, k, now, f.scale, layer.alpha);
    ctx.restore();
    this.frameBorder(r, layer.radius, layer.border, layer.borderColor);
    ctx.restore();
  }

  /** The camera as a bubble, a window, or the whole frame (and anything in between during a switch). */
  private drawCamera(layer: CameraLayer, cam: Source | null, k: number, settled: boolean) {
    const ctx = this.ctx;
    const b = layer.rect, radius = layer.radius;
    ctx.save();
    ctx.globalAlpha = layer.alpha;
    if (layer.shadow > 0 && layer.bubble) {
      ctx.save();
      ctx.shadowColor = `rgba(0,0,0,${(0.3 + 0.3 * layer.shadow).toFixed(3)})`;
      ctx.shadowBlur = 56 * layer.shadow * k;
      ctx.shadowOffsetY = 16 * layer.shadow * k;
      ctx.fillStyle = "#1b1b1e";
      this.roundRect(b.x, b.y, b.w, b.h, radius);
      ctx.fill();
      ctx.restore();
    } else this.frameShadow(b, radius, layer.shadow, k);
    ctx.save();
    this.roundRect(b.x, b.y, b.w, b.h, radius);
    ctx.clip();
    ctx.fillStyle = layer.bubble ? "#1b1b1e" : "#000";
    ctx.fillRect(b.x, b.y, b.w, b.h);
    if (cam) {
      const c = coverCrop(cam.w, cam.h, b.w, b.h);
      ctx.drawImage(cam.img, c.x, c.y, c.w, c.h, b.x, b.y, b.w, b.h);
    }
    ctx.restore();
    if (layer.border > 0) this.frameBorder(b, radius, layer.border, layer.borderColor);
    if (settled && layer.bubble) {
      if (this.bubbleHover && useRecord.getState().status === "idle") {
        // the drag outline only shows between takes
        this.roundRect(b.x, b.y, b.w, b.h, radius);
        ctx.lineWidth = 3 * k;
        ctx.strokeStyle = "rgba(61,220,151,0.9)";
        ctx.stroke();
      } else if (layer.border <= 0) {
        this.roundRect(b.x, b.y, b.w, b.h, radius);
        ctx.lineWidth = 2 * k;
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private paintBackground(W: number, H: number) {
    this.ctx.drawImage(this.background(W, H).canvas, 0, 0);
  }

  /** The background canvas for this frame size (painted only when something about it changed). */
  private background(W: number, H: number): { key: string; canvas: HTMLCanvasElement } {
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
    return this.bgCache;
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
