// The Record panel's look settings: frame size, background, the screen window, the camera bubble,
// and saved looks. Everything here is drawn live by the compositor, so the stage is the preview.
import { useRef, useState } from "react";
import { ArrowDownLeft, ArrowDownRight, ArrowLeftRight, ArrowUpLeft, ArrowUpRight, ImagePlus, RotateCcw, Save, Trash } from "lucide-react";
import type { BubbleLayout, BubbleShape, FrameCrop, OutputAspect, OutputQuality } from "@shared/types";
import { t } from "@shared/i18n";
import { Button, Card, ColorField, Disclosure, Hint, NumberField, Segmented, Slider, Switch } from "../../ui";
import {
  BACKGROUNDS, CUSTOM_SIDE, bubbleAspect, bubbleCorners, clampBubble, maxBubbleSize, needsScreen, outputSize, type CustomBackground,
} from "./layout-core";
import { DEFAULT_LOOK, applyLook, currentLayout, isBusy, loadLooks, lookOf, storeLooks, useRecord, type SavedLook } from "./store";

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** -1..1 as words at the ends and the centre, a percentage between */
const placeLabel = (lo: string, hi: string) => (v: number) =>
  Math.abs(v) < 0.025 ? t("record.place.centre") : v <= -0.975 ? lo : v >= 0.975 ? hi : pct((v + 1) / 2);

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
      if (!storeLooks(lite)) return setNote(t("record.looks.saveFailed"));
      setLooks(lite);
      setNote(t("record.looks.savedLite", { name: n }));
    } else {
      setLooks(next);
      setNote(t("record.looks.saved", { name: n }));
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
    <Card title={t("card.look")} hint={t("record.looks.hint")}>
      <div className="look-row">
        <select className="select" value={picked} aria-label={t("record.looks.list")} onChange={(e) => {
          const v = e.target.value;
          setPicked(v);
          setNote(null);
          if (v === "__default") { applyLook(DEFAULT_LOOK); setPicked(""); return; }
          const l = looks.find((x) => x.name === v);
          if (l) applyLook(l.look);
        }}>
          <option value="">{looks.length ? t("record.looks.choose") : t("record.looks.none")}</option>
          <option value="__default">{t("record.looks.standard")}</option>
          {looks.map((l) => <option key={l.name} value={l.name}>{l.name}</option>)}
        </select>
        {picked && <Button variant="ghost" size="icon" onClick={remove} title={t("record.looks.deleteTitle", { name: picked })} aria-label={t("record.looks.delete")}><Trash /></Button>}
        <Button variant="ghost" size="icon" onClick={() => { applyLook(DEFAULT_LOOK); setPicked(""); setNote(t("record.looks.backToStandard")); }} title={t("record.looks.resetTitle")} aria-label={t("record.looks.reset")}><RotateCcw /></Button>
      </div>
      {naming ? (
        <div className="look-row">
          <input ref={name} className="input" placeholder={t("record.looks.namePlaceholder")} maxLength={40} autoFocus defaultValue={picked}
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setNaming(false); }} />
          <Button variant="ink" onClick={save}>{t("record.looks.save")}</Button>
          <Button variant="ghost" onClick={() => setNaming(false)}>{t("record.cancel")}</Button>
        </div>
      ) : (
        <Button onClick={() => setNaming(true)}><Save />{t("record.looks.saveCurrent")}</Button>
      )}
      {note && <p className="note">{note}</p>}
    </Card>
  );
}

// ---------- frame size ----------

const aspectOptions = (): { value: OutputAspect; label: string; hint: string }[] => [
  { value: "16:9", label: "16:9", hint: t("record.aspect.landscape") },
  { value: "9:16", label: "9:16", hint: t("record.aspect.vertical") },
  { value: "1:1", label: "1:1", hint: t("record.aspect.square") },
  { value: "4:5", label: "4:5", hint: t("record.aspect.portrait") },
  { value: "4:3", label: "4:3", hint: t("record.aspect.classic") },
  { value: "custom", label: t("record.aspect.custom"), hint: t("record.aspect.customHint") },
];
const QUALITY: { value: OutputQuality; label: string }[] = [
  { value: 720, label: "720p" }, { value: 1080, label: "1080p" }, { value: 1440, label: "1440p" }, { value: 2160, label: "4K" },
];

export function FrameCard() {
  const s = useRecord();
  const busy = isBusy(s.status);
  const size = outputSize(s.aspect, s.quality, { width: s.customWidth, height: s.customHeight });
  return (
    <Card title={t("card.frame")} hint={t("record.frame.hint")}>
      <Segmented fill label={t("record.frame.shape")} value={s.aspect} options={aspectOptions()} onChange={(aspect) => s.set({ aspect })} disabled={busy} />
      {s.aspect === "custom" ? (
        <div className="look-row end">
          <NumberField label={t("record.frame.width")} value={s.customWidth} min={CUSTOM_SIDE.min} max={CUSTOM_SIDE.max} step={2} suffix="px" disabled={busy} onCommit={(customWidth) => s.set({ customWidth })} />
          <Button variant="ghost" size="icon" disabled={busy} title={t("record.frame.swap")} aria-label={t("record.frame.swap")}
            onClick={() => s.set({ customWidth: s.customHeight, customHeight: s.customWidth })}><ArrowLeftRight /></Button>
          <NumberField label={t("record.frame.height")} value={s.customHeight} min={CUSTOM_SIDE.min} max={CUSTOM_SIDE.max} step={2} suffix="px" disabled={busy} onCommit={(customHeight) => s.set({ customHeight })} />
        </div>
      ) : (
        <div className="row">
          <span className="row-label">{t("record.frame.resolution")}</span>
          <Segmented<OutputQuality> value={s.quality} options={QUALITY.map((q) => ({ ...q, hint: t("record.frame.qualityHint", { label: q.label }) }))} onChange={(quality) => s.set({ quality })} disabled={busy} />
        </div>
      )}
      <p className="note tnum">{size.width} × {size.height} px{size.width * size.height > 3840 * 2160 * 0.9 ? `. ${t("record.frame.large")}` : ""}</p>
    </Card>
  );
}

// ---------- background ----------

const customTiles = (): { id: CustomBackground; label: string }[] => [
  { id: "color", label: t("record.bg.colour") }, { id: "gradient", label: t("record.bg.gradient") }, { id: "image", label: t("record.bg.picture") },
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
    try { s.set({ bgImage: await loadPicture(f), backgroundId: "image" }); } catch { setErr(t("record.bg.readFailed")); }
  };

  return (
    <Card title={t("card.background")} hint={s.mode === "camera" ? t("record.bg.hintCamera") : t("record.bg.hintScreen")}>
      <div className="rec-swatches">
        {BACKGROUNDS.map((b) => (
          <button key={b.id} type="button" title={b.label} aria-label={b.label} aria-pressed={b.id === s.backgroundId}
            className={b.id === s.backgroundId ? "on" : ""} style={{ background: b.id === "none" ? undefined : b.css }} onClick={() => s.set({ backgroundId: b.id })}>
            {b.id === "none" ? b.label : ""}
          </button>
        ))}
      </div>
      <div className="rec-swatches">
        {customTiles().map((c) => (
          <button key={c.id} type="button" aria-pressed={c.id === s.backgroundId} className={c.id === s.backgroundId ? "on wide" : "wide"}
            style={{ background: tileCss(c.id) }} title={c.label}
            onClick={() => (c.id === "image" && !s.bgImage ? file.current?.click() : s.set({ backgroundId: c.id }))}>
            <span className="swatch-label">{c.id === "image" && !s.bgImage ? <><ImagePlus />{c.label}</> : c.label}</span>
          </button>
        ))}
      </div>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />

      {s.backgroundId === "color" && <ColorField label={t("record.bg.colour")} value={s.bgColor} onChange={(bgColor) => s.set({ bgColor })} />}
      {s.backgroundId === "gradient" && (
        <>
          <ColorField label={t("record.bg.from")} value={s.bgColor} onChange={(bgColor) => s.set({ bgColor })} />
          <ColorField label={t("record.bg.to")} value={s.bgColor2} onChange={(bgColor2) => s.set({ bgColor2 })} />
          <Slider label={t("record.bg.angle")} value={s.bgAngle} min={0} max={360} step={5} onChange={(bgAngle) => s.set({ bgAngle })} format={(v) => `${v}°`} onDoubleClick={() => s.set({ bgAngle: 135 })} />
        </>
      )}
      {s.backgroundId === "image" && (
        <>
          <div className="look-row">
            <Button onClick={() => file.current?.click()}><ImagePlus />{s.bgImage ? t("record.bg.changePicture") : t("record.bg.choosePicture")}</Button>
            {s.bgImage && <Button variant="ghost" onClick={() => s.set({ bgImage: null, backgroundId: "graphite" })}>{t("record.bg.remove")}</Button>}
          </div>
          <Slider label={t("record.bg.blur")} value={s.bgBlur} min={0} max={60} step={1} onChange={(bgBlur) => s.set({ bgBlur })} format={(v) => (v ? `${v}px` : t("record.off"))} />
        </>
      )}
      {err && <p className="note note-danger">{err}</p>}
    </Card>
  );
}

// ---------- the screen window (or the camera window in camera-only takes) ----------

const cropEdges = (): { key: keyof FrameCrop; label: string }[] => [
  { key: "top", label: t("record.edge.top") }, { key: "bottom", label: t("record.edge.bottom") }, { key: "left", label: t("record.edge.left") }, { key: "right", label: t("record.edge.right") },
];

export function WindowCard() {
  const s = useRecord();
  const screen = needsScreen(s.mode);
  const framedSwitch = !screen && (
    <Switch label={t("record.window.framed")} checked={s.cameraFramed} onChange={(cameraFramed) => s.set({ cameraFramed })} />
  );
  if (s.backgroundId === "none" || (!screen && !s.cameraFramed)) {
    return (
      <Card title={screen ? t("card.screenWindow") : t("card.cameraWindow")}>
        {framedSwitch}
        <p className="note">
          {screen ? t("record.window.fillsScreen") : t("record.window.fillsCamera")}
          {s.backgroundId === "none" ? ` ${t("record.window.pickBg")}` : ""}
        </p>
        {screen && <CropControls />}
      </Card>
    );
  }
  return (
    <Card title={screen ? t("card.screenWindow") : t("card.cameraWindow")} hint={t("record.window.hint")}>
      {framedSwitch}
      <Slider label={t("record.window.size")} value={s.screenScale} min={0.3} max={1} step={0.01} onChange={(screenScale) => s.set({ screenScale })} format={pct} onDoubleClick={() => s.set({ screenScale: 1 })} />
      <Slider label={t("record.window.padding")} hint={t("record.window.paddingHint")} value={s.padding} min={0} max={0.2} step={0.005} onChange={(padding) => s.set({ padding })} format={pct} onDoubleClick={() => s.set({ padding: DEFAULT_LOOK.padding })} />
      <Slider label={t("record.window.rounded")} value={s.cornerRadius} min={0} max={120} step={1} onChange={(cornerRadius) => s.set({ cornerRadius })} format={(v) => (v ? `${v}px` : t("record.window.square"))} onDoubleClick={() => s.set({ cornerRadius: DEFAULT_LOOK.cornerRadius })} />
      <Slider label={t("record.window.shadow")} value={s.screenShadow} min={0} max={1} step={0.05} onChange={(screenShadow) => s.set({ screenShadow })} format={(v) => (v ? pct(v) : t("record.off"))} onDoubleClick={() => s.set({ screenShadow: DEFAULT_LOOK.screenShadow })} />
      <Slider label={t("record.window.border")} value={s.screenBorder} min={0} max={24} step={1} onChange={(screenBorder) => s.set({ screenBorder })} format={(v) => (v ? `${v}px` : t("record.off"))} />
      {s.screenBorder > 0 && <ColorField label={t("record.window.borderColour")} value={s.screenBorderColor} onChange={(screenBorderColor) => s.set({ screenBorderColor })} />}
      {s.screenScale < 1 && (
        <Disclosure title={t("record.window.position")} defaultOpen>
          <Slider label={t("record.window.leftToRight")} value={s.screenPosition.x} min={-1} max={1} step={0.05} onChange={(x) => s.set({ screenPosition: { ...s.screenPosition, x } })}
            format={placeLabel(t("record.edge.left"), t("record.edge.right"))} onDoubleClick={() => s.set({ screenPosition: { ...s.screenPosition, x: 0 } })} />
          <Slider label={t("record.window.topToBottom")} value={s.screenPosition.y} min={-1} max={1} step={0.05} onChange={(y) => s.set({ screenPosition: { ...s.screenPosition, y } })}
            format={placeLabel(t("record.edge.top"), t("record.edge.bottom"))} onDoubleClick={() => s.set({ screenPosition: { ...s.screenPosition, y: 0 } })} />
        </Disclosure>
      )}
      {screen && <CropControls />}
    </Card>
  );
}

function CropControls() {
  const s = useRecord();
  const edges = cropEdges();
  const cut = edges.some((e) => s.crop[e.key] > 0);
  return (
    <Disclosure title={cut ? t("record.crop.on") : t("record.crop")}>
      <p className="note">{t("record.crop.note")}</p>
      {edges.map((e) => (
        <Slider key={e.key} label={e.label} value={s.crop[e.key]} min={0} max={0.4} step={0.005}
          onChange={(v) => s.set({ crop: { ...s.crop, [e.key]: v } })} format={(v) => (v ? pct(v) : t("record.crop.none"))} onDoubleClick={() => s.set({ crop: { ...s.crop, [e.key]: 0 } })} />
      ))}
      {cut && <Button size="sm" variant="ghost" onClick={() => s.set({ crop: DEFAULT_LOOK.crop })}>{t("record.crop.remove")}</Button>}
    </Disclosure>
  );
}

// ---------- the camera bubble ----------

const corners = () => [
  { icon: ArrowUpLeft, label: t("record.corner.topLeft") }, { icon: ArrowUpRight, label: t("record.corner.topRight") },
  { icon: ArrowDownLeft, label: t("record.corner.bottomLeft") }, { icon: ArrowDownRight, label: t("record.corner.bottomRight") },
];
const shapes = (): { value: BubbleShape; label: string }[] => [{ value: "circle", label: t("record.shape.circle") }, { value: "rounded", label: t("record.shape.rounded") }];

export function CameraBubbleCard() {
  const s = useRecord();
  const L = currentLayout(s);
  const b = s.bubble;
  const set = (p: Partial<BubbleLayout>) => s.set({ bubble: clampBubble({ ...b, ...p }, L.width, L.height) });
  const max = maxBubbleSize(b, L.width, L.height);
  const height = b.size / bubbleAspect(b);
  const maxH = (0.95 * L.height) / Math.min(L.width, L.height);
  return (
    <Card title={t("card.camera")} hint={t("record.bubble.hint")}>
      <div className="row">
        <span className="row-label">{t("record.bubble.shape")}</span>
        <Segmented<BubbleShape> value={b.shape} options={shapes()} onChange={(shape) => set({ shape })} />
      </div>
      {b.shape === "circle" ? (
        <Slider label={t("record.window.size")} value={b.size} min={0.08} max={Math.min(0.9, max)} step={0.01} onChange={(size) => set({ size })} format={pct} onDoubleClick={() => set({ size: DEFAULT_LOOK.bubble.size })} />
      ) : (
        <>
          <Slider label={t("record.frame.width")} value={b.size} min={0.08} max={Math.min(1.6, max)} step={0.01} format={pct}
            onChange={(size) => set({ size, aspect: Math.min(2.5, Math.max(0.5, size / height)) })} />
          <Slider label={t("record.frame.height")} value={height} min={0.08} max={Math.min(1, maxH)} step={0.01} format={pct}
            onChange={(h) => set({ aspect: Math.min(2.5, Math.max(0.5, b.size / h)) })} onDoubleClick={() => set({ aspect: 4 / 3 })} />
          <Slider label={t("record.window.rounded")} value={b.radius ?? 0.18} min={0} max={0.5} step={0.01} onChange={(radius) => set({ radius })}
            format={(v) => (v === 0 ? t("record.window.square") : v >= 0.5 ? t("record.bubble.pill") : pct(v * 2))} onDoubleClick={() => set({ radius: 0.18 })} />
        </>
      )}
      <Slider label={t("record.window.shadow")} value={b.shadow ?? 0.6} min={0} max={1} step={0.05} onChange={(shadow) => set({ shadow })} format={(v) => (v ? pct(v) : t("record.off"))} />
      <Slider label={t("record.window.border")} value={b.border ?? 0} min={0} max={24} step={1} onChange={(border) => set({ border })} format={(v) => (v ? `${v}px` : t("record.off"))} />
      {(b.border ?? 0) > 0 && <ColorField label={t("record.window.borderColour")} value={b.borderColor ?? "#ffffff"} onChange={(borderColor) => set({ borderColor })} />}
      <div className="row">
        <span className="row-label">{t("record.bubble.corner")}<Hint text={t("record.bubble.cornerHint")} /></span>
        <div className="corner-pick">
          {corners().map((c, i) => (
            <Button key={c.label} variant="ghost" size="icon-sm" title={c.label} aria-label={c.label}
              onClick={() => set(bubbleCorners(b, L.width, L.height)[i])}><c.icon /></Button>
          ))}
        </div>
      </div>
    </Card>
  );
}
