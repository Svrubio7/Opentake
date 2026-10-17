// The Record panel's look settings: frame size, background, the screen window, the camera bubble,
// and saved looks. Everything here is drawn live by the compositor, so the stage is the preview.
import { useRef, useState } from "react";
import { ArrowDownLeft, ArrowDownRight, ArrowLeftRight, ArrowUpLeft, ArrowUpRight, ImagePlus, RotateCcw, Save, Trash } from "lucide-react";
import type { BubbleLayout, BubbleShape, FrameCrop, OutputAspect, OutputQuality } from "@shared/types";
import { Button, Card, ColorField, Disclosure, Hint, NumberField, Segmented, Slider, Switch } from "../../ui";
import {
  BACKGROUNDS, CUSTOM_SIDE, bubbleAspect, bubbleCorners, clampBubble, maxBubbleSize, needsScreen, outputSize, type CustomBackground,
} from "./layout-core";
import { DEFAULT_LOOK, applyLook, currentLayout, isBusy, loadLooks, lookOf, storeLooks, useRecord, type SavedLook } from "./store";

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** -1..1 as words at the ends and the centre, a percentage between */
const placeLabel = (lo: string, hi: string) => (v: number) =>
  Math.abs(v) < 0.025 ? "Centre" : v <= -0.975 ? lo : v >= 0.975 ? hi : pct((v + 1) / 2);

// ---------- saved looks ----------

export function LooksCard() {
  const [looks, setLooks] = useState<SavedLook[]>(() => loadLooks());
  const [picked, setPicked] = useState("");
  const [naming, setNaming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const name = useRef<HTMLInputElement>(null);

  const save = () => {
    const n = name.current?.value.trim();
    if (!n) return;
    const next = [...looks.filter((l) => l.name !== n), { name: n, look: lookOf(useRecord.getState()) }];
    if (!storeLooks(next)) {
      // a look with a big background picture can be more than storage holds: keep it without the picture
      const lite = next.map((l) => (l.name === n ? { ...l, look: { ...l.look, bgImage: null, logoImage: null } } : l));
      if (!storeLooks(lite)) return setNote("Could not save the look.");
      setLooks(lite);
      setNote(`Saved "${n}" without its pictures (too large to keep).`);
    } else {
      setLooks(next);
      setNote(`Saved "${n}".`);
    }
    setPicked(n);
    setNaming(false);
  };

  const remove = () => {
    const next = looks.filter((l) => l.name !== picked);
    storeLooks(next);
    setLooks(next);
    setPicked("");
    setNote(null);
  };

  return (
    <Card title="Look" hint="A look is the frame, background, screen window and camera together. Save the ones you use and switch in one click.">
      <div className="look-row">
        <select className="select" value={picked} aria-label="Saved looks" onChange={(e) => {
          const v = e.target.value;
          setPicked(v);
          setNote(null);
          if (v === "__default") { applyLook(DEFAULT_LOOK); setPicked(""); return; }
          const l = looks.find((x) => x.name === v);
          if (l) applyLook(l.look);
        }}>
          <option value="">{looks.length ? "Choose a saved look" : "No saved looks yet"}</option>
          <option value="__default">Standard</option>
          {looks.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
        </select>
        {picked && <Button variant="ghost" size="icon" onClick={remove} title={`Delete "${picked}"`} aria-label="Delete look"><Trash /></Button>}
        <Button variant="ghost" size="icon" onClick={() => { applyLook(DEFAULT_LOOK); setPicked(""); setNote("Back to the standard look."); }} title="Reset to the standard look" aria-label="Reset look"><RotateCcw /></Button>
      </div>
      {naming ? (
        <div className="look-row">
          <input ref={name} className="input" placeholder="Name this look" maxLength={40} autoFocus defaultValue={picked}
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setNaming(false); }} />
          <Button variant="ink" onClick={save}>Save</Button>
          <Button variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
        </div>
      ) : (
        <Button onClick={() => setNaming(true)}><Save />Save current look</Button>
      )}
      {note && <p className="note">{note}</p>}
    </Card>
  );
}

// ---------- frame size ----------

const ASPECT_OPTIONS: { value: OutputAspect; label: string; hint: string }[] = [
  { value: "16:9", label: "16:9", hint: "Landscape: YouTube, a demo, a course" },
  { value: "9:16", label: "9:16", hint: "Vertical: Reels, TikTok, Shorts" },
  { value: "1:1", label: "1:1", hint: "Square" },
  { value: "4:5", label: "4:5", hint: "Portrait feed post" },
  { value: "4:3", label: "4:3", hint: "Classic" },
  { value: "custom", label: "Custom", hint: "Any width and height" },
];
const QUALITY: { value: OutputQuality; label: string }[] = [
  { value: 720, label: "720p" }, { value: 1080, label: "1080p" }, { value: 1440, label: "1440p" }, { value: 2160, label: "4K" },
];

export function FrameCard() {
  const s = useRecord();
  const busy = isBusy(s.status);
  const size = outputSize(s.aspect, s.quality, { width: s.customWidth, height: s.customHeight });
  return (
    <Card title="Frame" hint="The size of the video you record. It cannot change while a take is running.">
      <Segmented fill label="Frame shape" value={s.aspect} options={ASPECT_OPTIONS} onChange={(aspect) => s.set({ aspect })} disabled={busy} />
      {s.aspect === "custom" ? (
        <div className="look-row end">
          <NumberField label="Width" value={s.customWidth} min={CUSTOM_SIDE.min} max={CUSTOM_SIDE.max} step={2} suffix="px" disabled={busy} onCommit={(customWidth) => s.set({ customWidth })} />
          <Button variant="ghost" size="icon" disabled={busy} title="Swap width and height" aria-label="Swap width and height"
            onClick={() => s.set({ customWidth: s.customHeight, customHeight: s.customWidth })}><ArrowLeftRight /></Button>
          <NumberField label="Height" value={s.customHeight} min={CUSTOM_SIDE.min} max={CUSTOM_SIDE.max} step={2} suffix="px" disabled={busy} onCommit={(customHeight) => s.set({ customHeight })} />
        </div>
      ) : (
        <div className="row">
          <span className="row-label">Resolution</span>
          <Segmented<OutputQuality> value={s.quality} options={QUALITY.map((q) => ({ ...q, hint: `${q.label} on the shorter side` }))} onChange={(quality) => s.set({ quality })} disabled={busy} />
        </div>
      )}
      <p className="note tnum">{size.width} × {size.height} px{size.width * size.height > 3840 * 2160 * 0.9 ? ". Large frames need a fast computer." : ""}</p>
    </Card>
  );
}

// ---------- background ----------

const CUSTOM_TILES: { id: CustomBackground; label: string }[] = [
  { id: "color", label: "Colour" }, { id: "gradient", label: "Gradient" }, { id: "image", label: "Picture" },
];

/** Reads a picture and keeps it at most 2560 px on its long side, as JPEG, so it stays light to store and draw. */
async function loadPicture(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/jpeg", 0.88);
}

export function BackgroundCard() {
  const s = useRecord();
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const tileCss = (id: CustomBackground) =>
    id === "color" ? s.bgColor : id === "gradient" ? `linear-gradient(${s.bgAngle}deg,${s.bgColor},${s.bgColor2})`
      : s.bgImage ? `center / cover no-repeat url("${s.bgImage}")` : undefined;

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    try { s.set({ bgImage: await loadPicture(f), backgroundId: "image" }); } catch { setErr("That file could not be read as a picture."); }
  };

  return (
    <Card title="Background" hint={s.mode === "camera" ? "Pick a background to show the camera as a window over it." : "Shows around the screen window. None records the screen edge to edge."}>
      <div className="rec-swatches">
        {BACKGROUNDS.map((b) => (
          <button key={b.id} type="button" title={b.label} aria-label={b.label} aria-pressed={b.id === s.backgroundId}
            className={b.id === s.backgroundId ? "on" : ""} style={{ background: b.id === "none" ? undefined : b.css }} onClick={() => s.set({ backgroundId: b.id })}>
            {b.id === "none" ? "None" : ""}
          </button>
        ))}
      </div>
      <div className="rec-swatches">
        {CUSTOM_TILES.map((t) => (
          <button key={t.id} type="button" aria-pressed={t.id === s.backgroundId} className={t.id === s.backgroundId ? "on wide" : "wide"}
            style={{ background: tileCss(t.id) }} title={t.label}
            onClick={() => (t.id === "image" && !s.bgImage ? file.current?.click() : s.set({ backgroundId: t.id }))}>
            <span className="swatch-label">{t.id === "image" && !s.bgImage ? <><ImagePlus />{t.label}</> : t.label}</span>
          </button>
        ))}
      </div>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />

      {s.backgroundId === "color" && <ColorField label="Colour" value={s.bgColor} onChange={(bgColor) => s.set({ bgColor })} />}
      {s.backgroundId === "gradient" && (
        <>
          <ColorField label="From" value={s.bgColor} onChange={(bgColor) => s.set({ bgColor })} />
          <ColorField label="To" value={s.bgColor2} onChange={(bgColor2) => s.set({ bgColor2 })} />
          <Slider label="Angle" value={s.bgAngle} min={0} max={360} step={5} onChange={(bgAngle) => s.set({ bgAngle })} format={(v) => `${v}°`} onDoubleClick={() => s.set({ bgAngle: 135 })} />
        </>
      )}
      {s.backgroundId === "image" && (
        <>
          <div className="look-row">
            <Button onClick={() => file.current?.click()}><ImagePlus />{s.bgImage ? "Change picture" : "Choose picture"}</Button>
            {s.bgImage && <Button variant="ghost" onClick={() => s.set({ bgImage: null, backgroundId: "graphite" })}>Remove</Button>}
          </div>
          <Slider label="Blur" value={s.bgBlur} min={0} max={60} step={1} onChange={(bgBlur) => s.set({ bgBlur })} format={(v) => (v ? `${v}px` : "Off")} />
        </>
      )}
      {err && <p className="note note-danger">{err}</p>}
    </Card>
  );
}

// ---------- the screen window (or the camera window in camera-only takes) ----------

const CROP_EDGES: { key: keyof FrameCrop; label: string }[] = [
  { key: "top", label: "Top" }, { key: "bottom", label: "Bottom" }, { key: "left", label: "Left" }, { key: "right", label: "Right" },
];

export function WindowCard() {
  const s = useRecord();
  const screen = needsScreen(s.mode);
  const what = screen ? "screen" : "camera";
  const framedSwitch = !screen && (
    <Switch label="Show as a window over the background" checked={s.cameraFramed} onChange={(cameraFramed) => s.set({ cameraFramed })} />
  );
  if (s.backgroundId === "none" || (!screen && !s.cameraFramed)) {
    return (
      <Card title={screen ? "Screen window" : "Camera window"}>
        {framedSwitch}
        <p className="note">
          The {what} fills the frame edge to edge.
          {s.backgroundId === "none" ? " Pick a background to give it a size, rounded corners, a shadow and a border." : ""}
        </p>
        {screen && <CropControls />}
      </Card>
    );
  }
  return (
    <Card title={screen ? "Screen window" : "Camera window"} hint="Double-click a slider to reset it.">
      {framedSwitch}
      <Slider label="Size" value={s.screenScale} min={0.3} max={1} step={0.01} onChange={(screenScale) => s.set({ screenScale })} format={pct} onDoubleClick={() => s.set({ screenScale: 1 })} />
      <Slider label="Padding" hint="The margin kept between the window and the frame's edge" value={s.padding} min={0} max={0.2} step={0.005} onChange={(padding) => s.set({ padding })} format={pct} onDoubleClick={() => s.set({ padding: DEFAULT_LOOK.padding })} />
      <Slider label="Rounded corners" value={s.cornerRadius} min={0} max={120} step={1} onChange={(cornerRadius) => s.set({ cornerRadius })} format={(v) => (v ? `${v}px` : "Square")} onDoubleClick={() => s.set({ cornerRadius: DEFAULT_LOOK.cornerRadius })} />
      <Slider label="Shadow" value={s.screenShadow} min={0} max={1} step={0.05} onChange={(screenShadow) => s.set({ screenShadow })} format={(v) => (v ? pct(v) : "Off")} onDoubleClick={() => s.set({ screenShadow: DEFAULT_LOOK.screenShadow })} />
      <Slider label="Border" value={s.screenBorder} min={0} max={24} step={1} onChange={(screenBorder) => s.set({ screenBorder })} format={(v) => (v ? `${v}px` : "Off")} />
      {s.screenBorder > 0 && <ColorField label="Border colour" value={s.screenBorderColor} onChange={(screenBorderColor) => s.set({ screenBorderColor })} />}
      {s.screenScale < 1 && (
        <Disclosure title="Position" defaultOpen>
          <Slider label="Left to right" value={s.screenPosition.x} min={-1} max={1} step={0.05} onChange={(x) => s.set({ screenPosition: { ...s.screenPosition, x } })}
            format={placeLabel("Left", "Right")} onDoubleClick={() => s.set({ screenPosition: { ...s.screenPosition, x: 0 } })} />
          <Slider label="Top to bottom" value={s.screenPosition.y} min={-1} max={1} step={0.05} onChange={(y) => s.set({ screenPosition: { ...s.screenPosition, y } })}
            format={placeLabel("Top", "Bottom")} onDoubleClick={() => s.set({ screenPosition: { ...s.screenPosition, y: 0 } })} />
        </Disclosure>
      )}
      {screen && <CropControls />}
    </Card>
  );
}

function CropControls() {
  const s = useRecord();
  const cut = CROP_EDGES.some((e) => s.crop[e.key] > 0);
  return (
    <Disclosure title={cut ? "Crop (on)" : "Crop"}>
      <p className="note">Cut off a taskbar, a browser's tabs or a second monitor's edge. Zoom on clicks follows inside what is kept.</p>
      {CROP_EDGES.map((e) => (
        <Slider key={e.key} label={e.label} value={s.crop[e.key]} min={0} max={0.4} step={0.005}
          onChange={(v) => s.set({ crop: { ...s.crop, [e.key]: v } })} format={(v) => (v ? pct(v) : "None")} onDoubleClick={() => s.set({ crop: { ...s.crop, [e.key]: 0 } })} />
      ))}
      {cut && <Button size="sm" variant="ghost" onClick={() => s.set({ crop: DEFAULT_LOOK.crop })}>Remove crop</Button>}
    </Disclosure>
  );
}

// ---------- the camera bubble ----------

const CORNERS = [
  { icon: ArrowUpLeft, label: "Top left" }, { icon: ArrowUpRight, label: "Top right" },
  { icon: ArrowDownLeft, label: "Bottom left" }, { icon: ArrowDownRight, label: "Bottom right" },
];
const SHAPES: { value: BubbleShape; label: string }[] = [{ value: "circle", label: "Circle" }, { value: "rounded", label: "Rectangle" }];

export function CameraBubbleCard() {
  const s = useRecord();
  const L = currentLayout(s);
  const b = s.bubble;
  const set = (p: Partial<BubbleLayout>) => s.set({ bubble: clampBubble({ ...b, ...p }, L.width, L.height) });
  const max = maxBubbleSize(b, L.width, L.height);
  const height = b.size / bubbleAspect(b);
  const maxH = (0.95 * L.height) / Math.min(L.width, L.height);
  return (
    <Card title="Camera" hint="Drag the camera on the stage to move it, drag its edge to resize it.">
      <div className="row">
        <span className="row-label">Shape</span>
        <Segmented<BubbleShape> value={b.shape} options={SHAPES} onChange={(shape) => set({ shape })} />
      </div>
      {b.shape === "circle" ? (
        <Slider label="Size" value={b.size} min={0.08} max={Math.min(0.9, max)} step={0.01} onChange={(size) => set({ size })} format={pct} onDoubleClick={() => set({ size: DEFAULT_LOOK.bubble.size })} />
      ) : (
        <>
          <Slider label="Width" value={b.size} min={0.08} max={Math.min(1.6, max)} step={0.01} format={pct}
            onChange={(size) => set({ size, aspect: Math.min(2.5, Math.max(0.5, size / height)) })} />
          <Slider label="Height" value={height} min={0.08} max={Math.min(1, maxH)} step={0.01} format={pct}
            onChange={(h) => set({ aspect: Math.min(2.5, Math.max(0.5, b.size / h)) })} onDoubleClick={() => set({ aspect: 4 / 3 })} />
          <Slider label="Rounded corners" value={b.radius ?? 0.18} min={0} max={0.5} step={0.01} onChange={(radius) => set({ radius })}
            format={(v) => (v === 0 ? "Square" : v >= 0.5 ? "Pill" : pct(v * 2))} onDoubleClick={() => set({ radius: 0.18 })} />
        </>
      )}
      <Slider label="Shadow" value={b.shadow ?? 0.6} min={0} max={1} step={0.05} onChange={(shadow) => set({ shadow })} format={(v) => (v ? pct(v) : "Off")} />
      <Slider label="Border" value={b.border ?? 0} min={0} max={24} step={1} onChange={(border) => set({ border })} format={(v) => (v ? `${v}px` : "Off")} />
      {(b.border ?? 0) > 0 && <ColorField label="Border colour" value={b.borderColor ?? "#ffffff"} onChange={(borderColor) => set({ borderColor })} />}
      <div className="row">
        <span className="row-label">Place in a corner<Hint text="Or drag it anywhere on the stage. It settles into a corner when you let go near one." /></span>
        <div className="corner-pick">
          {CORNERS.map((c, i) => (
            <Button key={c.label} variant="ghost" size="icon-sm" title={c.label} aria-label={c.label}
              onClick={() => set(bubbleCorners(b, L.width, L.height)[i])}><c.icon /></Button>
          ))}
        </div>
      </div>
    </Card>
  );
}
