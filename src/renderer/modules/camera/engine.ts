// The camera engine: one per app. Opens the device, runs the WebGL pipeline on every camera frame,
// steers Auto lighting and framing, and publishes the filtered canvas as the "camera" stream.
import { publishStream } from "@core/streams";
import type { FaceDetector, ImageSegmenter } from "@mediapipe/tasks-vision";
import {
  AUTO_FRAME_MIN_ZOOM, assessLighting, autoFrameStep, autoTarget, coverFit, cropFor, easeAuto, effectiveAdjust, fpsOptions,
  generateLut, histogram, initialAutoState, initialFrameState, lookById, measureFrame, parseRes, resKey, resolutionOptions,
  segmentationInterval, smoothRect, updateAutoGoal, wbGains, type AutoState, type AutoValues, type FrameState, type Rect,
} from "./camera-core";
import { t } from "@shared/i18n";
import { Renderer } from "./gl";
import { MaskSmoother, detectFace, loadFaceDetector, loadSegmenter, segment } from "./ml";
import { useCamera, type CameraSettings, type CameraStatus } from "./store";
import { useRecord } from "../record/store";
import { afterNextFrame, gpuReadbacksHeld } from "@core/gpu-quiet";

const MEASURE_MS = 300;
const FACE_MS = 200;
const FACE_FORGET_MS = 1200;
const STORE_MS = 300;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.1, 0.1, 0.1];
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function canvas2d(w: number, h: number, read: boolean) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: read, alpha: false })!;
  return { c, ctx };
}

function explain(e: unknown): { status: CameraStatus; error: string } {
  const name = (e as { name?: string })?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return { status: "denied", error: t("camera.err.denied") };
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError")
    return { status: "nocamera", error: t("camera.err.notFound") };
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError")
    return { status: "busy", error: t("camera.err.busy") };
  const why = (e as Error)?.message;
  return { status: "error", error: why ? t("camera.err.failedWhy", { reason: why }) : t("camera.err.failed") };
}

class CameraEngine {
  readonly canvas = document.createElement("canvas");
  private video = document.createElement("video");
  private renderer: Renderer | null = null;
  private src: MediaStream | null = null;
  private out: MediaStream | null = null;
  private outFps = 0;
  private opening: Promise<void> | null = null;
  private wantReopen = false;
  private running = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastRender = 0;
  private lastMeasure = 0;
  private lastStore = 0;
  private lastSeg = 0;
  private lastFace = 0;
  private faceSeenAt = 0;
  private segCost = 6;
  private frames = 0;
  private fpsT0 = 0;
  private fps = 0;
  /** real frames from the camera (frame callbacks only, never the watchdog), per second */
  private srcFrames = 0;
  private srcT0 = 0;
  private face: Rect | null = null;
  private auto: AutoState = initialAutoState();
  private autoNow: AutoValues = { exposure: 0, shadows: 0, highlights: 0, temperature: 0, tint: 0 };
  private frame: FrameState = initialFrameState();
  private seg: ImageSegmenter | null = null;
  private det: FaceDetector | null = null;
  private maskSmoother = new MaskSmoother();
  private maskReady = false;
  private small = canvas2d(256, 144, false);
  // GPU canvases: the copy into them does not wait; the read happens after a composite frame
  private meter = canvas2d(160, 90, false);
  private histC = canvas2d(160, 90, false);
  private lutLook = "";
  private bgLoaded: string | null | undefined = undefined;
  private started = false;

  start() {
    if (this.started) return;
    this.started = true;
    // Chromium pauses invisible muted autoplay videos: keep ours "visible" and start it with play().
    Object.assign(this.video.style, { position: "fixed", left: "0", top: "0", width: "2px", height: "2px", opacity: "0.01", pointerEvents: "none", zIndex: "-1" });
    this.video.muted = true;
    this.video.playsInline = true;
    document.body.appendChild(this.video);
    this.canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); this.renderer = null; });
    this.canvas.addEventListener("webglcontextrestored", () => this.makeRenderer());
    navigator.mediaDevices?.addEventListener?.("devicechange", () => this.onDeviceChange());
    useCamera.subscribe((s, p) => this.onSettings(s, p));
    if (useCamera.getState().enabled) void this.open(); else useCamera.getState().setLive({ status: "off" });
  }

  /* ---------------------------------------------------------------- device */

  private async listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === "videoinput").map((d, i) => ({ deviceId: d.deviceId, label: d.label || t("camera.deviceN", { n: i + 1 }) }));
      useCamera.getState().setLive({ devices: cams });
      return cams;
    } catch { return []; }
  }

  private async onDeviceChange() {
    const cams = await this.listDevices();
    const s = useCamera.getState();
    if (!s.enabled) return;
    const live = s.status === "live" && this.src?.getVideoTracks()[0]?.readyState === "live";
    if (!live && cams.length) void this.open();
  }

  /** (Re)opens the camera from the current settings. Calls made while opening queue one reopen. */
  open(): Promise<void> {
    if (this.opening) { this.wantReopen = true; return this.opening; }
    this.opening = this.doOpen().finally(() => {
      this.opening = null;
      if (this.wantReopen) { this.wantReopen = false; void this.open(); }
    });
    return this.opening;
  }

  private async doOpen() {
    const st = useCamera.getState();
    st.setLive({ status: "starting", error: null });
    this.stopSource();
    if (!navigator.mediaDevices?.getUserMedia) { st.setLive({ status: "error", error: t("camera.err.unsupported") }); return; }
    // 1080p unless a size was picked: most webcams only reach 4K at 5-15 fps, which looks choppy
    // and smears every movement. The frame rate is a floor, so a camera can't trade it for size.
    const [w, h] = parseRes(st.resolution ?? "") ?? [1920, 1080];
    const video = (deviceId: string | null, floor: boolean): MediaTrackConstraints => ({
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: w }, height: { ideal: h },
      frameRate: floor ? { min: Math.round(st.fps * 0.8), ideal: st.fps } : { ideal: st.fps },
    });
    const get = (deviceId: string | null, floor: boolean) => navigator.mediaDevices.getUserMedia({ video: video(deviceId, floor), audio: false });
    /** with the frame rate floor first; a camera that cannot hold it still opens without one */
    const open = async (deviceId: string | null) => {
      try { return await get(deviceId, true); } catch (e) {
        if ((e as { name?: string })?.name !== "OverconstrainedError") throw e;
        return get(deviceId, false);
      }
    };
    let stream: MediaStream;
    try {
      stream = await open(st.deviceId);
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (st.deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) {
        // the remembered camera is gone: take whichever one is there
        try { stream = await open(null); }
        catch (e2) { await this.listDevices(); st.setLive(explain(e2)); return; }
      } else { await this.listDevices(); st.setLive(explain(e)); return; }
    }
    if (!useCamera.getState().enabled) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.src = stream;
    const track = stream.getVideoTracks()[0];
    const caps = (track.getCapabilities?.() ?? {}) as MediaTrackCapabilities;
    const set = track.getSettings();
    const resOptions = resolutionOptions(caps.width?.max, caps.height?.max);
    if (set.width && set.height && !resOptions.includes(resKey(set.width, set.height))) resOptions.push(resKey(set.width, set.height));
    track.addEventListener("ended", () => {
      if (this.src !== stream) return;
      useCamera.getState().setLive({ status: "error", error: t("camera.err.disconnected") });
    });
    await this.listDevices();
    useCamera.getState().setLive({
      resOptions,
      fpsOptions: fpsOptions(caps.frameRate?.max),
      actual: { w: set.width ?? 0, h: set.height ?? 0, fps: Math.round(set.frameRate ?? st.fps) },
    });
    if (set.deviceId && set.deviceId !== useCamera.getState().deviceId) useCamera.getState().set({ deviceId: set.deviceId });

    this.video.srcObject = stream;
    try { await this.video.play(); } catch { /* play() can reject if replaced mid-start; the next open retries */ }
    if (!this.renderer) this.makeRenderer();
    this.ensureOutput(st.fps);
    this.startLoop();
    useCamera.getState().setLive({ status: "live", error: null });
  }

  private stopSource() {
    this.src?.getTracks().forEach((t) => t.stop());
    this.src = null;
    this.video.srcObject = null;
  }

  stop() {
    this.stopSource();
    this.running = false;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.out?.getTracks().forEach((t) => t.stop());
    this.out = null;
    publishStream("camera", null);
    this.srcT0 = 0;
    this.srcFrames = 0;
    useCamera.getState().setLive({ status: "off", actual: null, outFps: 0, sourceFps: 0 });
  }

  private makeRenderer() {
    try {
      this.renderer = new Renderer(this.canvas);
      this.lutLook = "";
      this.bgLoaded = undefined;
      this.maskReady = false;
    } catch (e) {
      this.renderer = null;
      useCamera.getState().setLive({ status: "error", error: t("camera.err.graphics", { reason: (e as Error).message }) });
    }
  }

  /** The published stream is created once per frame rate; the recorder keeps the same object across resolution changes. */
  private ensureOutput(fps: number) {
    if (this.out && this.outFps === fps) return;
    this.out?.getTracks().forEach((t) => t.stop());
    this.out = this.canvas.captureStream(fps);
    this.outFps = fps;
    publishStream("camera", this.out);
  }

  private onSettings(s: CameraSettings, p: CameraSettings) {
    if (s.enabled !== p.enabled) { if (s.enabled) void this.open(); else this.stop(); return; }
    if (!s.enabled) return;
    if (s.deviceId !== p.deviceId || s.resolution !== p.resolution || s.fps !== p.fps) {
      // the engine itself writes deviceId after opening; do not reopen for that
      const actual = this.src?.getVideoTracks()[0]?.getSettings().deviceId;
      if (s.deviceId !== p.deviceId && s.deviceId === actual && s.resolution === p.resolution && s.fps === p.fps) return;
      if (s.deviceId !== p.deviceId) this.resetTracking();
      void this.open();
    }
    if (s.bgMode !== p.bgMode) { this.maskSmoother.reset(); this.maskReady = false; }
  }

  private resetTracking() {
    this.auto = initialAutoState();
    this.frame = initialFrameState();
    this.face = null;
  }

  /* ---------------------------------------------------------------- loop */

  private startLoop() {
    if (this.running) return;
    this.running = true;
    const v = this.video;
    const onFrame = () => {
      if (!this.running) return;
      v.requestVideoFrameCallback(onFrame);
      this.countSourceFrame(performance.now());
      this.renderOnce(performance.now());
    };
    if ("requestVideoFrameCallback" in v) v.requestVideoFrameCallback(onFrame);
    // Fallback when frame callbacks stop (window hidden, stalled device): keep the stream fed.
    this.watchdog = setInterval(() => {
      const now = performance.now();
      const fps = useCamera.getState().fps;
      if (now - this.lastRender > (1000 / fps) * 2.5) this.renderOnce(now);
    }, 1000 / 30);
  }

  private countSourceFrame(now: number) {
    if (!this.srcT0) this.srcT0 = now;
    this.srcFrames++;
    if (now - this.srcT0 < 2000) return;
    const fps = Math.round((this.srcFrames * 1000) / (now - this.srcT0));
    this.srcFrames = 0;
    this.srcT0 = now;
    if (fps !== useCamera.getState().sourceFps) useCamera.getState().setLive({ sourceFps: fps });
  }

  private renderOnce(now: number) {
    const v = this.video;
    const r = this.renderer;
    if (!r || v.readyState < 2 || !v.videoWidth) return;
    const s = useCamera.getState();
    const dt = this.lastRender ? Math.min(now - this.lastRender, 250) : 16;
    this.lastRender = now;
    const vw = v.videoWidth, vh = v.videoHeight;

    // look LUT and background picture follow the settings lazily
    if (this.lutLook !== s.look) { r.setLut(generateLut(lookById(s.look), 33), 33); this.lutLook = s.look; }
    if (this.bgLoaded !== s.bgImage) this.loadBackground(s.bgImage);

    // machine learning at its own pace, on a small copy of the frame
    const needSeg = s.bgMode !== "none";
    const needFace = s.auto || s.autoFrame;
    // a take's recorders are starting: no readback now (the last mask and face stay)
    const quiet = gpuReadbacksHeld(now);
    // the models read their result back from the GPU: right after a composite frame, not now
    if ((needSeg || needFace) && !quiet) afterNextFrame("camera.ml", () => { if (!gpuReadbacksHeld()) this.runMl(performance.now(), needSeg, needFace); });
    if (this.face && now - this.faceSeenAt > FACE_FORGET_MS) this.face = null;

    if (s.auto) this.autoNow = easeAuto(this.autoNow, this.auto.goal, dt);
    const zoom = s.autoFrame ? Math.max(s.zoom, AUTO_FRAME_MIN_ZOOM) : s.zoom;
    if (s.autoFrame) this.frame = autoFrameStep(this.frame, this.face, zoom, dt);
    else this.frame = { ...this.frame, cx: 0.5, cy: 0.5, goalX: 0.5, goalY: 0.5 };
    const crop = cropFor(zoom, this.frame.cx, this.frame.cy);
    const adjust = effectiveAdjust(s.manual, this.autoNow, s.auto, s.autoKeys);

    r.render(v, vw, vh, {
      adjust,
      wb: wbGains(adjust.temperature, adjust.tint),
      lookAmount: s.lookAmount,
      crop,
      mirror: s.mirrorRecording,
      flipY: s.flipVertical,
      bgMode: s.bgMode,
      bgBlur: s.bgBlur,
      bgColor: hexToRgb(s.bgColor),
      maskReady: this.maskReady,
    }, coverFit(r.backgroundAspect, vw / vh));

    this.frames++;
    if (now - this.fpsT0 >= 1000) { this.fps = (this.frames * 1000) / (now - this.fpsT0); this.frames = 0; this.fpsT0 = now; }

    if (now - this.lastMeasure >= MEASURE_MS && !quiet) {
      this.lastMeasure = now;
      this.measure(s);
    }
  }

  private runMl(now: number, needSeg: boolean, needFace: boolean) {
    const s = useCamera.getState();
    let drawn = false;
    const draw = () => { if (!drawn) { this.small.ctx.drawImage(this.video, 0, 0, 256, 144); drawn = true; } };
    if (needSeg) {
      if (!this.seg) this.ensureSegmenter();
      else if (now - this.lastSeg >= segmentationInterval(this.segCost)) {
        this.lastSeg = now;
        draw();
        const t0 = performance.now();
        try {
          const m = segment(this.seg, this.small.c);
          if (m && this.renderer) { this.renderer.setMask(this.maskSmoother.push(m.data), m.w, m.h); this.maskReady = true; }
        } catch { /* a dropped mask is fine; the last one stays */ }
        this.segCost = this.segCost * 0.8 + (performance.now() - t0) * 0.2;
      }
    }
    if (needFace) {
      if (!this.det) this.ensureFaceDetector();
      else if (now - this.lastFace >= FACE_MS) {
        this.lastFace = now;
        draw();
        try {
          const f = detectFace(this.det, this.small.c);
          if (f) { this.face = smoothRect(this.face, f); this.faceSeenAt = now; }
        } catch { /* keep the last face */ }
      }
    }
    if (s.faceFound !== !!this.face && now - this.lastStore >= STORE_MS) s.setLive({ faceFound: !!this.face });
  }

  private ensureSegmenter() {
    const st = useCamera.getState();
    if (st.segStatus === "loading" || st.segStatus === "error") return;
    st.setLive({ segStatus: "loading" });
    loadSegmenter()
      .then((seg) => { this.seg = seg; useCamera.getState().setLive({ segStatus: "ready" }); })
      .catch((e) => { console.error("[camera] segmenter", e); useCamera.getState().setLive({ segStatus: "error" }); });
  }

  private ensureFaceDetector() {
    const st = useCamera.getState();
    if (st.faceStatus === "loading" || st.faceStatus === "error") return;
    st.setLive({ faceStatus: "loading" });
    loadFaceDetector()
      .then((det) => { this.det = det; useCamera.getState().setLive({ faceStatus: "ready" }); })
      .catch((e) => { console.error("[camera] face detector", e); useCamera.getState().setLive({ faceStatus: "error" }); });
  }

  /** Every ~300 ms: meter the raw frame for Auto + the score, and the output for the histogram. */
  private measure(s: ReturnType<typeof useCamera.getState>) {
    // copied now (the WebGL buffer is only readable in the task that drew it), read back later
    let copied = true;
    try {
      this.histC.ctx.drawImage(this.canvas, 0, 0, 160, 90);
      this.meter.ctx.drawImage(this.video, 0, 0, 160, 90);
    } catch { copied = false; }
    if (copied) afterNextFrame("camera.measure", () => { if (!gpuReadbacksHeld()) this.readMeasure(useCamera.getState()); });
  }

  private readMeasure(s: ReturnType<typeof useCamera.getState>) {
    let hist = s.hist;
    try {
      hist = histogram(this.histC.ctx.getImageData(0, 0, 160, 90).data, 160, 90);
    } catch { /* keep the last histogram */ }
    try {
      const stats = measureFrame(this.meter.ctx.getImageData(0, 0, 160, 90).data, 160, 90, this.face);
      if (s.auto) this.auto = updateAutoGoal(this.auto, autoTarget(stats, lookById(s.look)));
      const report = assessLighting(stats, s.faceStatus === "ready");
      s.setLive({ report, hist, autoNow: { ...this.autoNow }, outFps: Math.round(this.fps), faceFound: !!this.face });
      this.lastStore = performance.now();
    } catch (e) {
      console.error("[camera] measure", e);
    }
  }

  private loadBackground(url: string | null) {
    this.bgLoaded = url;
    if (!url) { this.renderer?.setBackgroundImage(null); return; }
    const img = new Image();
    img.onload = async () => {
      if (this.bgLoaded !== url || !this.renderer) return;
      try {
        const bmp = await createImageBitmap(img);
        this.renderer?.setBackgroundImage(bmp, bmp.width, bmp.height);
        bmp.close();
      } catch { this.renderer?.setBackgroundImage(img, img.naturalWidth, img.naturalHeight); }
    };
    img.src = url;
  }
}

let engine: CameraEngine | null = null;
/** Starts the one camera engine (idempotent). */
let followingRecord = false;
/** A 60 fps recording asks the camera for 60 too, when it can give it (30 stays a choice of its own). */
function followRecordFps() {
  if (followingRecord) return;
  followingRecord = true;
  const match = (fps: number) => {
    const cam = useCamera.getState();
    if (fps === 60 && cam.fps !== 60 && cam.fpsOptions.includes(60)) cam.set({ fps: 60 });
  };
  match(useRecord.getState().fps);
  useRecord.subscribe((s, prev) => { if (s.fps !== prev.fps) match(s.fps); });
}

export function startCameraEngine() {
  engine ??= new CameraEngine();
  engine.start();
  followRecordFps();
  return engine;
}
export function retryCamera() { void startCameraEngine().open(); }
