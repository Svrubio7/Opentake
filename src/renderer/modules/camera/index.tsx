// OWNED BY: camera agent. The sidebar panel for the camera, plus a preview other modules may reuse.
import { useEffect, useRef, type ChangeEvent } from "react";
import { useStream } from "@core/useStream";
import { ADJUST_META, AUTO_KEYS, LOOKS, resLabel, type AdjustKey, type AutoKey, type Histogram } from "./camera-core";
import { retryCamera, startCameraEngine } from "./engine";
import type { BgMode } from "./gl";
import { useCamera } from "./store";
import { Button, Card, Field, Segmented, Slider as UiSlider, Switch, Tag } from "../../ui";
import "./camera.css";

/** Live view of the published (filtered) camera stream. */
export function CameraPreview({ className, mirror }: { className?: string; mirror?: boolean }) {
  useEffect(() => { startCameraEngine(); }, []);
  const stream = useStream("camera");
  const mirrorPreview = useCamera((s) => s.mirrorPreview);
  const mirrorRecording = useCamera((s) => s.mirrorRecording);
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => {});
  }, [stream]);
  // the stream already carries the recording mirror; flip again only when the preview wants otherwise
  const flip = (mirror ?? mirrorPreview) !== mirrorRecording;
  return <video ref={ref} className={`cam-preview-video ${flip ? "flip" : ""} ${className ?? ""}`} muted playsInline />;
}

function HistogramView({ hist }: { hist: Histogram | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const W = c.width, H = c.height;
    ctx.clearRect(0, 0, W, H);
    if (!hist) return;
    const all = [...hist.r, ...hist.g, ...hist.b, ...hist.l];
    const max = Math.max(1, ...all.slice().sort((a, b) => b - a).slice(2, 3)); // ignore spikes
    const draw = (bins: number[], color: string, fill: boolean) => {
      ctx.beginPath();
      ctx.moveTo(0, H);
      bins.forEach((v, i) => ctx.lineTo((i / (bins.length - 1)) * W, H - Math.min(1, v / max) * (H - 2)));
      ctx.lineTo(W, H);
      ctx.closePath();
      if (fill) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); }
    };
    ctx.globalCompositeOperation = "lighter";
    draw(hist.r, "rgba(255,80,80,0.35)", true);
    draw(hist.g, "rgba(80,220,120,0.35)", true);
    draw(hist.b, "rgba(90,140,255,0.35)", true);
    ctx.globalCompositeOperation = "source-over";
    // the luma line takes the theme's ink, so it reads on a light card and a dark one
    draw(hist.l, getComputedStyle(c).color, false);
  }, [hist]);
  return <canvas ref={ref} className="cam-hist" width={640} height={120} aria-label="Histogram" />;
}

function Slider({ k }: { k: AdjustKey }) {
  const meta = ADJUST_META[k];
  const isAutoKey = (AUTO_KEYS as readonly string[]).includes(k);
  const auto = useCamera((s) => s.auto && isAutoKey && s.autoKeys[k as AutoKey]);
  const autoAvailable = useCamera((s) => s.auto && isAutoKey);
  const value = useCamera((s) => (auto ? s.autoNow[k as AutoKey] : s.manual[k]));
  const setManual = useCamera((s) => s.setManual);
  const backToAuto = useCamera((s) => s.backToAuto);
  const format = (v: number) => (k === "exposure" ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}` : `${v >= 0 && meta.min < 0 ? "+" : ""}${Math.round(v * 100)}`);
  const side = autoAvailable ? (auto
    ? <Tag tone="brand" title="Auto is steering this. Drag to take over.">Auto</Tag>
    : <button type="button" className="tag cam-back" onClick={(e) => { e.preventDefault(); backToAuto(k as AutoKey); }} title="Let Auto steer this again">Back to Auto</button>) : null;
  return (
    <UiSlider label={meta.label} value={value} min={meta.min} max={meta.max} step={meta.step} format={format} side={side}
      onChange={(v) => setManual(k, v)}
      onDoubleClick={() => (isAutoKey && autoAvailable ? backToAuto(k as AutoKey) : setManual(k, k === "sharpen" ? 0.25 : 0))} />
  );
}

async function downscaleImage(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1920 / bmp.width, 1080 / bmp.height);
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.88);
}

function StatusCard() {
  const status = useCamera((s) => s.status);
  const error = useCamera((s) => s.error);
  const set = useCamera((s) => s.set);
  if (status === "live" || status === "starting" || status === "idle") return null;
  if (status === "off") {
    return (
      <Card className="cam-status">
        <p>Camera is off.</p>
        <Button variant="ink" onClick={() => set({ enabled: true })}>Turn camera on</Button>
      </Card>
    );
  }
  return (
    <Card className="cam-status card-danger">
      <p>{error}</p>
      <Button variant="ink" onClick={retryCamera}>Try again</Button>
    </Card>
  );
}

const LEVEL_TONE = { good: "good", ok: "warn", poor: "danger" } as const;

export function CameraPanel() {
  useEffect(() => { startCameraEngine(); }, []);
  const s = useCamera();
  const fileRef = useRef<HTMLInputElement>(null);
  const live = s.status === "live";

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try { s.setBgImage(await downscaleImage(f)); s.set({ bgMode: "image" }); } catch { /* not an image */ }
  };

  const report = s.report;
  const resValue = s.resolution ?? s.resOptions[0] ?? "";

  return (
    <div className="cards cam">
      <section className="card cam-hero">
        <div className="cam-preview">
          <CameraPreview />
          {s.status === "starting" && <div className="cam-overlay">Starting camera</div>}
          {live && report && (
            <span className="cam-score"><Tag tone={LEVEL_TONE[report.level]} title="Lighting score">Light {report.score}</Tag></span>
          )}
          {live && s.actual && <span className="cam-meta tnum">{resLabel(`${s.actual.w}x${s.actual.h}`)} · {s.outFps} fps</span>}
        </div>
        {live && (
          <div className="cam-light">
            <HistogramView hist={s.hist} />
            <p className={`cam-tip ${report?.level ?? ""}`}>{report?.tip ?? "Measuring the light"}</p>
          </div>
        )}
      </section>

      <StatusCard />

      <Card title="Camera">
        <Field label="Device">
          <select className="select" value={s.deviceId ?? ""} onChange={(e) => s.set({ deviceId: e.target.value || null, resolution: null })} disabled={!s.devices.length}>
            {!s.devices.length && <option value="">No camera</option>}
            {s.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
          </select>
        </Field>
        <div className="cam-row">
          <Field label="Resolution">
            <select className="select" value={resValue} onChange={(e) => s.set({ resolution: e.target.value })} disabled={!s.resOptions.length}>
              {s.resOptions.map((r) => <option key={r} value={r}>{resLabel(r)}</option>)}
            </select>
          </Field>
          {s.fpsOptions.length > 0 && (
            <div className="field">
              <span className="label">Frame rate</span>
              <Segmented label="Frame rate" value={s.fps} options={s.fpsOptions.map((f) => ({ value: f, label: `${f}` }))} onChange={(v) => s.set({ fps: v })} />
            </div>
          )}
        </div>
        {live && s.sourceFps > 0 && s.sourceFps < s.fps * 0.75 ? (
          <p className="note note-warn">
            The camera is sending {s.sourceFps} frames a second, not {s.fps}, so movement blurs.
            Cameras slow down in a dim room to let in more light: more light on your face fixes it. A lower resolution can help too.
          </p>
        ) : live && s.actual && s.fps === 60 && s.actual.fps < 50 && (
          <p className="note note-warn">This camera gives {s.actual.fps} fps at this resolution. Try a lower resolution for 60.</p>
        )}
        {live && s.outFps > 0 && s.outFps < Math.min(s.fps, s.actual?.fps || s.fps) * 0.75 && (
          <p className="note note-warn">Processing is behind ({s.outFps} fps). A lower resolution or less skin smoothing will help.</p>
        )}
        <Switch label="Camera on" checked={s.enabled} onChange={(v) => s.set({ enabled: v })} />
        <Switch label="Flip left to right" checked={s.mirrorRecording} onChange={(v) => s.set({ mirrorRecording: v })}
          hint="Many webcams mirror the picture, which makes a face look odd. Set this so writing behind you reads the right way. Changes the recording." />
        <Switch label="Flip upside down" checked={s.flipVertical} onChange={(v) => s.set({ flipVertical: v })}
          hint="For a camera mounted upside down, or one looking down at a desk. Changes the recording." />
        <Switch label="Mirror my preview" checked={s.mirrorPreview} onChange={(v) => s.set({ mirrorPreview: v })}
          hint="Shows you like a mirror while you look at yourself here. The recording is not affected." />
      </Card>

      <Card title="Look" action={<Button variant="ghost" size="sm" onClick={s.resetLook}>Reset</Button>}>
        <div className="cam-looks" role="radiogroup" aria-label="Look">
          {LOOKS.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={s.look === l.id} className={`cam-look ${s.look === l.id ? "on" : ""}`} onClick={() => s.set({ look: l.id })}>
              <span className={`swatch ${l.id}`} />{l.label}
            </button>
          ))}
        </div>
        <UiSlider label="Look strength" value={s.lookAmount} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}`} onChange={(v) => s.set({ lookAmount: v })} />
        <Switch label="Auto lighting" checked={s.auto} onChange={(v) => s.set({ auto: v })}
          hint="Steers exposure, shadows, highlights and white balance toward the look, a few times a second" />
        {s.auto && s.faceStatus === "error" && <p className="note">Face detection is unavailable, Auto meters the centre of the frame.</p>}
      </Card>

      <Card title="Light and colour" hint="Double-click a slider to reset it">
        {(["exposure", "shadows", "highlights", "temperature", "tint", "contrast", "saturation", "vibrance"] as AdjustKey[]).map((k) => <Slider key={k} k={k} />)}
      </Card>

      <Card title="Detail">
        {(["sharpen", "smoothing", "vignette"] as AdjustKey[]).map((k) => <Slider key={k} k={k} />)}
      </Card>

      <Card title="Background">
        <Segmented<BgMode> fill label="Background" value={s.bgMode} onChange={(v) => s.set({ bgMode: v })}
          options={[{ value: "none", label: "None" }, { value: "blur", label: "Blur" }, { value: "color", label: "Colour" }, { value: "image", label: "Image" }]} />
        {s.bgMode !== "none" && s.segStatus === "loading" && <p className="note">Loading background removal</p>}
        {s.bgMode !== "none" && s.segStatus === "error" && <p className="note note-warn">Background removal could not start on this computer.</p>}
        {s.bgMode === "blur" && (
          <UiSlider label="Blur strength" value={s.bgBlur} min={0} max={1} step={0.01} format={(v) => `${Math.round(v * 100)}`} onChange={(v) => s.set({ bgBlur: v })} />
        )}
        {s.bgMode === "color" && (
          <label className="row cam-color">
            <span className="row-label">Colour</span>
            <input type="color" value={s.bgColor} onChange={(e) => s.set({ bgColor: e.target.value })} />
          </label>
        )}
        {s.bgMode === "image" && (
          <div className="cam-bgimg">
            {s.bgImage ? <img src={s.bgImage} alt="Background" /> : <div className="cam-bgimg-empty">No picture yet</div>}
            <Button onClick={() => fileRef.current?.click()}>{s.bgImage ? "Change picture" : "Choose picture"}</Button>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
      </Card>

      <Card title="Framing">
        <UiSlider label="Zoom" value={s.zoom} min={1} max={3} step={0.01} format={(v) => `${v.toFixed(2)}x`} onChange={(v) => s.set({ zoom: v })} onDoubleClick={() => s.set({ zoom: 1 })} />
        <Switch label="Auto-frame" checked={s.autoFrame} onChange={(v) => s.set({ autoFrame: v })} hint="Keeps your face centred with a slow, smooth follow" />
        {s.autoFrame && (
          <p className="note">{s.faceStatus === "error" ? "Face detection is unavailable on this computer." : s.faceFound ? "Following your face." : "Looking for your face."}</p>
        )}
      </Card>
    </div>
  );
}
