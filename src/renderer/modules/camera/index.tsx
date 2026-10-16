// OWNED BY: camera agent. The sidebar panel for the camera, plus a preview other modules may reuse.
import { useEffect, useRef, type ChangeEvent } from "react";
import { useStream } from "@core/useStream";
import { ADJUST_META, AUTO_KEYS, LOOKS, resLabel, type AdjustKey, type AutoKey, type Histogram } from "./camera-core";
import { retryCamera, startCameraEngine } from "./engine";
import type { BgMode } from "./gl";
import { useCamera } from "./store";
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
      if (fill) { ctx.fillStyle = color; ctx.fill(); } else { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); }
    };
    ctx.globalCompositeOperation = "lighter";
    draw(hist.r, "rgba(255,80,80,0.35)", true);
    draw(hist.g, "rgba(80,220,120,0.35)", true);
    draw(hist.b, "rgba(90,140,255,0.35)", true);
    ctx.globalCompositeOperation = "source-over";
    draw(hist.l, "rgba(255,255,255,0.8)", false);
  }, [hist]);
  return <canvas ref={ref} className="cam-hist" width={320} height={64} aria-label="Histogram" />;
}

function Slider({ k }: { k: AdjustKey }) {
  const meta = ADJUST_META[k];
  const isAutoKey = (AUTO_KEYS as readonly string[]).includes(k);
  const auto = useCamera((s) => s.auto && isAutoKey && s.autoKeys[k as AutoKey]);
  const autoAvailable = useCamera((s) => s.auto && isAutoKey);
  const value = useCamera((s) => (auto ? s.autoNow[k as AutoKey] : s.manual[k]));
  const setManual = useCamera((s) => s.setManual);
  const backToAuto = useCamera((s) => s.backToAuto);
  const shown = k === "exposure" ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}` : `${value >= 0 && meta.min < 0 ? "+" : ""}${Math.round(value * 100)}`;
  return (
    <div className={`cam-slider ${auto ? "is-auto" : ""}`}>
      <div className="cam-slider-head">
        <span>{meta.label}</span>
        <span className="cam-slider-right">
          {autoAvailable && (auto
            ? <span className="cam-pill on" title="Auto is steering this. Drag to take over.">Auto</span>
            : <button className="cam-pill" onClick={() => backToAuto(k as AutoKey)} title="Let Auto steer this again">Back to Auto</button>)}
          <span className="cam-val">{shown}</span>
        </span>
      </div>
      <input
        type="range" min={meta.min} max={meta.max} step={meta.step} value={value}
        onChange={(e) => setManual(k, Number(e.target.value))}
        onDoubleClick={() => (isAutoKey && autoAvailable ? backToAuto(k as AutoKey) : setManual(k, k === "sharpen" ? 0.25 : 0))}
      />
    </div>
  );
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="cam-seg" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.v)} role="radio" aria-checked={o.v === value} className={o.v === value ? "on" : ""} onClick={() => onChange(o.v)}>{o.label}</button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="cam-toggle" title={hint}>
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="cam-switch" aria-hidden />
    </label>
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
      <div className="cam-card cam-status">
        <p>Camera is off.</p>
        <button className="cam-primary" onClick={() => set({ enabled: true })}>Turn camera on</button>
      </div>
    );
  }
  return (
    <div className={`cam-card cam-status ${status}`}>
      <p>{error}</p>
      <button className="cam-primary" onClick={retryCamera}>Try again</button>
    </div>
  );
}

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
    <div className="cam">
      <div className="cam-hero">
        <div className="cam-preview">
          <CameraPreview />
          {s.status === "starting" && <div className="cam-overlay">Starting camera</div>}
          {live && report && (
            <div className={`cam-score ${report.level}`} title="Lighting score">
              <span className="dot" />{report.score}
            </div>
          )}
          {live && <div className="cam-meta">{s.actual ? `${resLabel(`${s.actual.w}x${s.actual.h}`)} · ${s.outFps} fps` : ""}</div>}
        </div>
        {live && (
          <div className="cam-light">
            <HistogramView hist={s.hist} />
            <p className={`cam-tip ${report?.level ?? ""}`}>{report?.tip ?? "Measuring the light"}</p>
          </div>
        )}
      </div>

      <StatusCard />

      <section className="cam-section">
        <h3>Camera</h3>
        <label className="cam-field">
          <span>Device</span>
          <select value={s.deviceId ?? ""} onChange={(e) => s.set({ deviceId: e.target.value || null, resolution: null })} disabled={!s.devices.length}>
            {!s.devices.length && <option value="">No camera</option>}
            {s.devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
          </select>
        </label>
        <div className="cam-row">
          <label className="cam-field grow">
            <span>Resolution</span>
            <select value={resValue} onChange={(e) => s.set({ resolution: e.target.value })} disabled={!s.resOptions.length}>
              {s.resOptions.map((r) => <option key={r} value={r}>{resLabel(r)}</option>)}
            </select>
          </label>
          <div className="cam-field">
            <span>Frame rate</span>
            <Seg value={s.fps} options={s.fpsOptions.map((f) => ({ v: f, label: `${f}` }))} onChange={(v) => s.set({ fps: v })} />
          </div>
        </div>
        {live && s.actual && s.fps === 60 && s.actual.fps < 50 && (
          <p className="cam-note">This camera gives {s.actual.fps} fps at this resolution. Try a lower resolution for 60.</p>
        )}
        {live && s.outFps > 0 && s.outFps < Math.min(s.fps, s.actual?.fps || s.fps) * 0.75 && (
          <p className="cam-note">Processing is behind ({s.outFps} fps). A lower resolution or less skin smoothing will help.</p>
        )}
        <Toggle label="Mirror preview" checked={s.mirrorPreview} onChange={(v) => s.set({ mirrorPreview: v })} hint="Only what you see here" />
        <Toggle label="Mirror recording" checked={s.mirrorRecording} onChange={(v) => s.set({ mirrorRecording: v })} hint="Flips the recorded video" />
        <Toggle label="Camera on" checked={s.enabled} onChange={(v) => s.set({ enabled: v })} />
      </section>

      <section className="cam-section">
        <div className="cam-section-head">
          <h3>Look</h3>
          <button className="cam-link" onClick={s.resetLook}>Reset</button>
        </div>
        <div className="cam-looks">
          {LOOKS.map((l) => (
            <button key={l.id} className={`cam-look ${s.look === l.id ? "on" : ""}`} onClick={() => s.set({ look: l.id })}>
              <span className={`swatch ${l.id}`} />{l.label}
            </button>
          ))}
        </div>
        <div className="cam-slider">
          <div className="cam-slider-head"><span>Look strength</span><span className="cam-val">{Math.round(s.lookAmount * 100)}</span></div>
          <input type="range" min={0} max={1} step={0.01} value={s.lookAmount} onChange={(e) => s.set({ lookAmount: Number(e.target.value) })} />
        </div>
        <Toggle label="Auto lighting" checked={s.auto} onChange={(v) => s.set({ auto: v })}
          hint="Steers exposure, shadows, highlights and white balance toward the look, a few times a second" />
        {s.auto && s.faceStatus === "error" && <p className="cam-note">Face detection is unavailable, Auto meters the centre of the frame.</p>}
      </section>

      <section className="cam-section">
        <h3>Light and colour</h3>
        {(["exposure", "shadows", "highlights", "temperature", "tint", "contrast", "saturation", "vibrance"] as AdjustKey[]).map((k) => <Slider key={k} k={k} />)}
      </section>

      <section className="cam-section">
        <h3>Detail</h3>
        {(["sharpen", "smoothing", "vignette"] as AdjustKey[]).map((k) => <Slider key={k} k={k} />)}
      </section>

      <section className="cam-section">
        <h3>Background</h3>
        <Seg<BgMode> value={s.bgMode} onChange={(v) => s.set({ bgMode: v })}
          options={[{ v: "none", label: "None" }, { v: "blur", label: "Blur" }, { v: "color", label: "Colour" }, { v: "image", label: "Image" }]} />
        {s.bgMode !== "none" && s.segStatus === "loading" && <p className="cam-note">Loading background removal</p>}
        {s.bgMode !== "none" && s.segStatus === "error" && <p className="cam-note warn">Background removal could not start on this computer.</p>}
        {s.bgMode === "blur" && (
          <div className="cam-slider">
            <div className="cam-slider-head"><span>Blur strength</span><span className="cam-val">{Math.round(s.bgBlur * 100)}</span></div>
            <input type="range" min={0} max={1} step={0.01} value={s.bgBlur} onChange={(e) => s.set({ bgBlur: Number(e.target.value) })} />
          </div>
        )}
        {s.bgMode === "color" && (
          <label className="cam-field cam-color">
            <span>Colour</span>
            <input type="color" value={s.bgColor} onChange={(e) => s.set({ bgColor: e.target.value })} />
          </label>
        )}
        {s.bgMode === "image" && (
          <div className="cam-bgimg">
            {s.bgImage ? <img src={s.bgImage} alt="Background" /> : <div className="cam-bgimg-empty">No picture yet</div>}
            <button onClick={() => fileRef.current?.click()}>{s.bgImage ? "Change picture" : "Choose picture"}</button>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
      </section>

      <section className="cam-section">
        <h3>Framing</h3>
        <div className="cam-slider">
          <div className="cam-slider-head"><span>Zoom</span><span className="cam-val">{s.zoom.toFixed(2)}x</span></div>
          <input type="range" min={1} max={3} step={0.01} value={s.zoom} onChange={(e) => s.set({ zoom: Number(e.target.value) })} onDoubleClick={() => s.set({ zoom: 1 })} />
        </div>
        <Toggle label="Auto-frame" checked={s.autoFrame} onChange={(v) => s.set({ autoFrame: v })} hint="Keeps your face centred with a slow, smooth follow" />
        {s.autoFrame && (
          <p className="cam-note">{s.faceStatus === "error" ? "Face detection is unavailable on this computer." : s.faceFound ? "Following your face." : "Looking for your face."}</p>
        )}
      </section>
    </div>
  );
}
