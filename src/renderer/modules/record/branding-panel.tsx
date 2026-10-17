// The Record panel's overlay settings: the pointer, keystrokes, logo, name card, intro and outro.
// They are part of the look and drawn live by the compositor, so the stage shows exactly what records.
import { useRef, useState } from "react";
import { ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, Eye, ImagePlus } from "lucide-react";
import { Button, Card, ColorField, Disclosure, Field, Hint, Segmented, Slider, Switch } from "../../ui";
import { compositor } from "./engine";
import type { CardLook, Corner, KeysLook, LowerThirdPosition, LowerThirdStyle, OverlayLook } from "./overlays-core";
import { IS_MAC, useOverlays } from "./overlays";
import { useRecord } from "./store";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const MOD = IS_MAC ? "Cmd" : "Ctrl";

/** Sets part of one overlay's settings. */
function usePatch() {
  const s = useRecord();
  return <K extends Exclude<keyof OverlayLook, "logoImage">>(key: K, p: Partial<OverlayLook[K]>) => s.set({ [key]: { ...s[key], ...p } });
}

// ---------- the pointer ----------

export function PointerCard() {
  const s = useRecord();
  const patch = usePatch();
  const hideable = useOverlays((o) => o.cursorHideable);
  const p = s.pointer;
  return (
    <Card title="Pointer" hint="Click rings and a spotlight are drawn over the screen as you record.">
      <Switch label="Show pointer" checked={p.show || !hideable} disabled={!hideable} onChange={(show) => patch("pointer", { show })}
        hint={hideable ? undefined : "This screen capture always includes the system pointer, so it cannot be hidden, enlarged or smoothed here. Click rings and the spotlight still work."} />
      {hideable && p.show && (
        <>
          <Slider label="Pointer size" value={p.size} min={1} max={3} step={0.25} onChange={(size) => patch("pointer", { size })} format={(v) => `${v}x`} onDoubleClick={() => patch("pointer", { size: 1 })} />
          <Switch label="Smooth movement" hint="Glides between positions instead of jumping" checked={p.smooth} onChange={(smooth) => patch("pointer", { smooth })} />
        </>
      )}
      <Switch label="Click rings" hint="A ring where you click" checked={p.highlight} onChange={(highlight) => patch("pointer", { highlight })} />
      {p.highlight && (
        <>
          <ColorField label="Ring colour" value={p.highlightColor} onChange={(highlightColor) => patch("pointer", { highlightColor })} />
          <Slider label="Ring size" value={p.highlightSize} min={0.5} max={2} step={0.1} onChange={(highlightSize) => patch("pointer", { highlightSize })} format={(v) => `${v.toFixed(1)}x`} onDoubleClick={() => patch("pointer", { highlightSize: 1 })} />
        </>
      )}
      <Switch label="Spotlight" hint="Dims the screen except a circle around the pointer" checked={p.spotlight} onChange={(spotlight) => patch("pointer", { spotlight })} />
      {p.spotlight && (
        <>
          <Slider label="Spotlight size" value={p.spotlightSize} min={0.06} max={0.4} step={0.01} onChange={(spotlightSize) => patch("pointer", { spotlightSize })} format={pct} />
          <Slider label="Dim" value={p.spotlightDim} min={0.1} max={0.9} step={0.05} onChange={(spotlightDim) => patch("pointer", { spotlightDim })} format={pct} />
        </>
      )}
    </Card>
  );
}

// ---------- keystrokes ----------

const KEY_POSITIONS: { value: KeysLook["position"]; label: string }[] = [
  { value: "bottom-left", label: "Left" }, { value: "bottom-center", label: "Centre" }, { value: "bottom-right", label: "Right" },
];
const KEY_SIZES: { value: KeysLook["size"]; label: string }[] = [{ value: "small", label: "S" }, { value: "medium", label: "M" }, { value: "large", label: "L" }];

export function KeysCard() {
  const s = useRecord();
  const patch = usePatch();
  const status = useOverlays((o) => o.keys);
  const reason = useOverlays((o) => o.keysReason);
  const k = s.keys;
  return (
    <Card title="Keystrokes" hint="Shows the keys you press as a pill near the bottom. Keys are only drawn into the video, never saved anywhere else.">
      <Switch label="Show keystrokes" checked={k.enabled} onChange={(enabled) => patch("keys", { enabled })} />
      {k.enabled && (
        <>
          <Switch label="Show all keys" checked={k.showAll} onChange={(showAll) => patch("keys", { showAll })}
            hint={`Also shows typing, collapsed into words. When off, only shortcuts with ${IS_MAC ? "Cmd, Ctrl or Option" : "Ctrl, Alt or Win"} show, so passwords and messages stay out of the video.`} />
          <div className="row">
            <span className="row-label">Position</span>
            <Segmented<KeysLook["position"]> value={k.position} options={KEY_POSITIONS} onChange={(position) => patch("keys", { position })} />
          </div>
          <div className="row">
            <span className="row-label">Size</span>
            <Segmented<KeysLook["size"]> value={k.size} options={KEY_SIZES} onChange={(size) => patch("keys", { size })} />
          </div>
          {status === "unavailable" && <p className="note note-danger" title={reason ?? undefined}>Keys cannot be read on this computer{IS_MAC ? ": allow OpenTake under Accessibility in System Settings." : "."}</p>}
        </>
      )}
    </Card>
  );
}

// ---------- logo ----------

/** Reads a logo and keeps it at most 640 px on its long side, as PNG so transparency survives. */
async function loadLogo(file: File): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 640 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  return c.toDataURL("image/png");
}

const CORNERS: { value: Corner; icon: typeof ArrowUpLeft; label: string }[] = [
  { value: "top-left", icon: ArrowUpLeft, label: "Top left" }, { value: "top-right", icon: ArrowUpRight, label: "Top right" },
  { value: "bottom-left", icon: ArrowDownLeft, label: "Bottom left" }, { value: "bottom-right", icon: ArrowDownRight, label: "Bottom right" },
];

export function LogoCard() {
  const s = useRecord();
  const patch = usePatch();
  const file = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const l = s.logo;
  const pick = async (f: File | undefined) => {
    if (!f) return;
    setErr(null);
    try { s.set({ logoImage: await loadLogo(f), logo: { ...l, enabled: true } }); } catch { setErr("That file could not be read as a picture."); }
  };
  return (
    <Card title="Logo" hint="A watermark in a corner of every take. A PNG with a transparent background looks best.">
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      {!s.logoImage ? (
        <Button onClick={() => file.current?.click()}><ImagePlus />Add a logo</Button>
      ) : (
        <>
          <Switch label="Show logo" checked={l.enabled} onChange={(enabled) => patch("logo", { enabled })} />
          <div className="look-row">
            <img className="logo-thumb" src={s.logoImage} alt="" />
            <Button size="sm" onClick={() => file.current?.click()}>Change</Button>
            <Button size="sm" variant="ghost" onClick={() => s.set({ logoImage: null, logo: { ...l, enabled: false } })}>Remove</Button>
          </div>
          {l.enabled && (
            <>
              <div className="row">
                <span className="row-label">Corner<Hint text="Or set an exact position below" /></span>
                <div className="corner-pick">
                  {CORNERS.map((c) => (
                    <Button key={c.value} variant={l.position === c.value ? "outline" : "ghost"} size="icon-sm" title={c.label} aria-label={c.label} aria-pressed={l.position === c.value}
                      onClick={() => patch("logo", { position: c.value })}><c.icon /></Button>
                  ))}
                </div>
              </div>
              <Slider label="Size" value={l.size} min={0.04} max={0.4} step={0.01} onChange={(size) => patch("logo", { size })} format={pct} />
              <Slider label="Opacity" value={l.opacity} min={0.1} max={1} step={0.05} onChange={(opacity) => patch("logo", { opacity })} format={pct} />
              {l.position !== "custom" && <Slider label="Margin" value={l.margin} min={0} max={0.12} step={0.005} onChange={(margin) => patch("logo", { margin })} format={pct} />}
              <Disclosure title={l.position === "custom" ? "Exact position (on)" : "Exact position"}>
                <Slider label="Left to right" value={l.x} min={0} max={1} step={0.01} onChange={(x) => patch("logo", { x, position: "custom" })} format={pct} />
                <Slider label="Top to bottom" value={l.y} min={0} max={1} step={0.01} onChange={(y) => patch("logo", { y, position: "custom" })} format={pct} />
              </Disclosure>
            </>
          )}
        </>
      )}
      {err && <p className="note note-danger">{err}</p>}
    </Card>
  );
}

// ---------- name card (lower third) ----------

const LT_STYLES: { value: LowerThirdStyle; label: string; hint: string }[] = [
  { value: "bar", label: "Bar", hint: "A dark panel with an accent bar" },
  { value: "card", label: "Card", hint: "A white card, the title in the accent colour" },
  { value: "minimal", label: "Minimal", hint: "Just the text, with an accent line" },
];
const LT_POSITIONS: { value: LowerThirdPosition; label: string }[] = [
  { value: "bottom-left", label: "Bottom left" }, { value: "bottom-right", label: "Bottom right" }, { value: "top-left", label: "Top left" },
];

export function NameCard() {
  const s = useRecord();
  const patch = usePatch();
  const manual = useOverlays((o) => o.lowerThirdManual);
  const lt = s.lowerThird;
  return (
    <Card title="Name card" hint={`Your name and title as a lower third. ${MOD}+Shift+L shows or hides it at any time, while recording too.`}>
      <Switch label="Show a name card" checked={lt.enabled} onChange={(enabled) => patch("lowerThird", { enabled })} />
      {lt.enabled && (
        <>
          <Field label="Name"><input className="input" value={lt.name} maxLength={60} placeholder="Your name" onChange={(e) => patch("lowerThird", { name: e.target.value })} /></Field>
          <Field label="Title"><input className="input" value={lt.title} maxLength={80} placeholder="What you do (optional)" onChange={(e) => patch("lowerThird", { title: e.target.value })} /></Field>
          <div className="row">
            <span className="row-label">Style</span>
            <Segmented<LowerThirdStyle> value={lt.style} options={LT_STYLES} onChange={(style) => patch("lowerThird", { style })} />
          </div>
          <ColorField label="Accent" value={lt.accent} onChange={(accent) => patch("lowerThird", { accent })} />
          <Segmented<LowerThirdPosition> fill label="Position" value={lt.position} options={LT_POSITIONS} onChange={(position) => patch("lowerThird", { position })} />
          <Slider label="Show at the start" hint="Seconds it stays up when a take starts (after the intro). Off: only the hotkey shows it."
            value={lt.seconds} min={0} max={20} step={1} onChange={(seconds) => patch("lowerThird", { seconds })} format={(v) => (v ? `${v} s` : "Off")} />
          <Button size="sm" onClick={() => compositor().overlays.toggleLowerThird()}><Eye />{manual ? "Hide it" : "Show it now"}</Button>
        </>
      )}
    </Card>
  );
}

// ---------- intro and outro ----------

function CardFields({ kind, card }: { kind: "intro" | "outro"; card: CardLook }) {
  const patch = usePatch();
  const set = (p: Partial<CardLook>) => patch(kind, p);
  return (
    <div className="stack">
      <Field label="Title"><input className="input" value={card.title} maxLength={80} placeholder={kind === "intro" ? "What this video is about" : "Thanks for watching"} onChange={(e) => set({ title: e.target.value })} /></Field>
      <Field label="Subtitle"><input className="input" value={card.subtitle} maxLength={120} placeholder="Optional" onChange={(e) => set({ subtitle: e.target.value })} /></Field>
      <Slider label="Length" value={card.seconds} min={1} max={10} step={0.5} onChange={(seconds) => set({ seconds })} format={(v) => `${v} s`} />
      <div className="row">
        <span className="row-label">Background</span>
        <Segmented<CardLook["background"]> value={card.background} options={[{ value: "look", label: "The look's", hint: "The background chosen above" }, { value: "color", label: "Colour" }]} onChange={(background) => set({ background })} />
      </div>
      {card.background === "color" && <ColorField label="Colour" value={card.color} onChange={(color) => set({ color })} />}
      <ColorField label="Text colour" value={card.textColor} onChange={(textColor) => set({ textColor })} />
      <Button size="sm" onClick={() => compositor().overlays.preview(kind)}><Eye />Preview on the stage</Button>
    </div>
  );
}

export function IntroOutroCard() {
  const s = useRecord();
  const patch = usePatch();
  return (
    <Card title="Intro and outro" hint="Title cards recorded into the take: the intro at the start, the outro after you press Stop.">
      <Switch label="Intro card" hint="The take starts on a title card, then moves into the scene" checked={s.intro.enabled} onChange={(enabled) => patch("intro", { enabled })} />
      {s.intro.enabled && <CardFields kind="intro" card={s.intro} />}
      <Switch label="Outro card" hint="Stop shows an end card for its length, then the take ends. Press Stop again to end at once." checked={s.outro.enabled} onChange={(enabled) => patch("outro", { enabled })} />
      {s.outro.enabled && <CardFields kind="outro" card={s.outro} />}
    </Card>
  );
}
