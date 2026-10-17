// The Record panel's overlay settings: the pointer, keystrokes, logo, name card, intro and outro.
// They are part of the look and drawn live by the compositor, so the stage shows exactly what records.
import { useRef, useState } from "react";
import { ArrowDownLeft, ArrowDownRight, ArrowUpLeft, ArrowUpRight, Eye, ImagePlus } from "lucide-react";
import { Button, Card, ColorField, Disclosure, Field, Hint, Segmented, Slider, Switch } from "../../ui";
import { compositor } from "./engine";
import type { CardLook, Corner, KeysLook, LowerThirdPosition, LowerThirdStyle, OverlayLook } from "./overlays-core";
import { IS_MAC, useOverlays } from "./overlays";
import { useRecord } from "./store";
import { num, t, tIn } from "@shared/i18n";
import { keyLabel } from "../shell/shortcuts-core";

const pct = (v: number) => num(v, { style: "percent", maximumFractionDigits: 0 });
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
    <Card title={t("card.pointer")} hint={t("ov.pointer.hint")}>
      <Switch label={t("ov.pointer.show")} checked={p.show || !hideable} disabled={!hideable} onChange={(show) => patch("pointer", { show })}
        hint={hideable ? undefined : t("ov.pointer.fixed")} />
      {hideable && p.show && (
        <>
          <Slider label={t("ov.pointer.size")} value={p.size} min={1} max={3} step={0.25} onChange={(size) => patch("pointer", { size })} format={(v) => `${num(v)}x`} onDoubleClick={() => patch("pointer", { size: 1 })} />
          <Switch label={t("ov.pointer.smooth")} hint={t("ov.pointer.smoothHint")} checked={p.smooth} onChange={(smooth) => patch("pointer", { smooth })} />
        </>
      )}
      <Switch label={t("ov.pointer.rings")} hint={t("ov.pointer.ringsHint")} checked={p.highlight} onChange={(highlight) => patch("pointer", { highlight })} />
      {p.highlight && (
        <>
          <ColorField label={t("ov.pointer.ringColour")} value={p.highlightColor} onChange={(highlightColor) => patch("pointer", { highlightColor })} />
          <Slider label={t("ov.pointer.ringSize")} value={p.highlightSize} min={0.5} max={2} step={0.1} onChange={(highlightSize) => patch("pointer", { highlightSize })} format={(v) => `${num(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}x`} onDoubleClick={() => patch("pointer", { highlightSize: 1 })} />
        </>
      )}
      <Switch label={t("ov.pointer.spotlight")} hint={t("ov.pointer.spotlightHint")} checked={p.spotlight} onChange={(spotlight) => patch("pointer", { spotlight })} />
      {p.spotlight && (
        <>
          <Slider label={t("ov.pointer.spotlightSize")} value={p.spotlightSize} min={0.06} max={0.4} step={0.01} onChange={(spotlightSize) => patch("pointer", { spotlightSize })} format={pct} />
          <Slider label={t("ov.pointer.dim")} value={p.spotlightDim} min={0.1} max={0.9} step={0.05} onChange={(spotlightDim) => patch("pointer", { spotlightDim })} format={pct} />
        </>
      )}
    </Card>
  );
}

// ---------- keystrokes ----------

const keyPositions = (): { value: KeysLook["position"]; label: string }[] => [
  { value: "bottom-left", label: t("ov.keys.left") }, { value: "bottom-center", label: t("ov.keys.centre") }, { value: "bottom-right", label: t("ov.keys.right") },
];
const KEY_SIZES: { value: KeysLook["size"]; label: string }[] = [{ value: "small", label: "S" }, { value: "medium", label: "M" }, { value: "large", label: "L" }];

export function KeysCard() {
  const s = useRecord();
  const patch = usePatch();
  const status = useOverlays((o) => o.keys);
  const reason = useOverlays((o) => o.keysReason);
  const k = s.keys;
  return (
    <Card title={t("card.keystrokes")} hint={t("ov.keys.hint")}>
      <Switch label={t("ov.keys.show")} checked={k.enabled} onChange={(enabled) => patch("keys", { enabled })} />
      {k.enabled && (
        <>
          <Switch label={t("ov.keys.all")} checked={k.showAll} onChange={(showAll) => patch("keys", { showAll })}
            hint={t("ov.keys.allHint", { mods: IS_MAC ? t("ov.keys.modsMac") : t("ov.keys.modsWin") })} />
          <div className="row">
            <span className="row-label">{t("ov.keys.position")}</span>
            <Segmented<KeysLook["position"]> value={k.position} options={keyPositions()} onChange={(position) => patch("keys", { position })} />
          </div>
          <div className="row">
            <span className="row-label">{t("ov.keys.size")}</span>
            <Segmented<KeysLook["size"]> value={k.size} options={KEY_SIZES} onChange={(size) => patch("keys", { size })} />
          </div>
          {status === "unavailable" && <p className="note note-danger" title={reason ?? undefined}>{IS_MAC ? t("ov.keys.unavailableMac") : t("ov.keys.unavailable")}</p>}
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

const corners = (): { value: Corner; icon: typeof ArrowUpLeft; label: string }[] => [
  { value: "top-left", icon: ArrowUpLeft, label: t("ov.corner.topLeft") }, { value: "top-right", icon: ArrowUpRight, label: t("ov.corner.topRight") },
  { value: "bottom-left", icon: ArrowDownLeft, label: t("ov.corner.bottomLeft") }, { value: "bottom-right", icon: ArrowDownRight, label: t("ov.corner.bottomRight") },
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
    try { s.set({ logoImage: await loadLogo(f), logo: { ...l, enabled: true } }); } catch { setErr(t("ov.logo.unreadable")); }
  };
  return (
    <Card title={t("card.logo")} hint={t("ov.logo.hint")}>
      <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
      {!s.logoImage ? (
        <Button onClick={() => file.current?.click()}><ImagePlus />{t("ov.logo.add")}</Button>
      ) : (
        <>
          <Switch label={t("ov.logo.show")} checked={l.enabled} onChange={(enabled) => patch("logo", { enabled })} />
          <div className="look-row">
            <img className="logo-thumb" src={s.logoImage} alt="" />
            <Button size="sm" onClick={() => file.current?.click()}>{t("ov.logo.change")}</Button>
            <Button size="sm" variant="ghost" onClick={() => s.set({ logoImage: null, logo: { ...l, enabled: false } })}>{t("ov.logo.remove")}</Button>
          </div>
          {l.enabled && (
            <>
              <div className="row">
                <span className="row-label">{t("ov.logo.corner")}<Hint text={t("ov.logo.cornerHint")} /></span>
                <div className="corner-pick">
                  {corners().map((c) => (
                    <Button key={c.value} variant={l.position === c.value ? "outline" : "ghost"} size="icon-sm" title={c.label} aria-label={c.label} aria-pressed={l.position === c.value}
                      onClick={() => patch("logo", { position: c.value })}><c.icon /></Button>
                  ))}
                </div>
              </div>
              <Slider label={t("ov.logo.size")} value={l.size} min={0.04} max={0.4} step={0.01} onChange={(size) => patch("logo", { size })} format={pct} />
              <Slider label={t("ov.logo.opacity")} value={l.opacity} min={0.1} max={1} step={0.05} onChange={(opacity) => patch("logo", { opacity })} format={pct} />
              {l.position !== "custom" && <Slider label={t("ov.logo.margin")} value={l.margin} min={0} max={0.12} step={0.005} onChange={(margin) => patch("logo", { margin })} format={pct} />}
              <Disclosure title={l.position === "custom" ? t("ov.logo.exactOn") : t("ov.logo.exact")}>
                <Slider label={t("ov.logo.leftToRight")} value={l.x} min={0} max={1} step={0.01} onChange={(x) => patch("logo", { x, position: "custom" })} format={pct} />
                <Slider label={t("ov.logo.topToBottom")} value={l.y} min={0} max={1} step={0.01} onChange={(y) => patch("logo", { y, position: "custom" })} format={pct} />
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

const ltStyles = (): { value: LowerThirdStyle; label: string; hint: string }[] => [
  { value: "bar", label: t("ov.lt.bar"), hint: t("ov.lt.barHint") },
  { value: "card", label: t("ov.lt.card"), hint: t("ov.lt.cardHint") },
  { value: "minimal", label: t("ov.lt.minimal"), hint: t("ov.lt.minimalHint") },
];
const ltPositions = (): { value: LowerThirdPosition; label: string }[] => [
  { value: "bottom-left", label: t("ov.lt.bottomLeft") }, { value: "bottom-right", label: t("ov.lt.bottomRight") }, { value: "top-left", label: t("ov.lt.topLeft") },
];

export function NameCard() {
  const s = useRecord();
  const patch = usePatch();
  const manual = useOverlays((o) => o.lowerThirdManual);
  const lt = s.lowerThird;
  return (
    <Card title={t("card.nameCard")} hint={t("ov.lt.hint", { mod: MOD, shift: keyLabel("Shift", false) })}>
      <Switch label={t("ov.lt.show")} checked={lt.enabled} onChange={(enabled) => patch("lowerThird", { enabled })} />
      {lt.enabled && (
        <>
          <Field label={t("ov.lt.name")}><input className="input" value={lt.name} maxLength={60} placeholder={t("ov.lt.namePlaceholder")} onChange={(e) => patch("lowerThird", { name: e.target.value })} /></Field>
          <Field label={t("ov.lt.title")}><input className="input" value={lt.title} maxLength={80} placeholder={t("ov.lt.titlePlaceholder")} onChange={(e) => patch("lowerThird", { title: e.target.value })} /></Field>
          <div className="row">
            <span className="row-label">{t("ov.lt.style")}</span>
            <Segmented<LowerThirdStyle> value={lt.style} options={ltStyles()} onChange={(style) => patch("lowerThird", { style })} />
          </div>
          <ColorField label={t("ov.lt.accent")} value={lt.accent} onChange={(accent) => patch("lowerThird", { accent })} />
          <Segmented<LowerThirdPosition> fill label={t("ov.lt.position")} value={lt.position} options={ltPositions()} onChange={(position) => patch("lowerThird", { position })} />
          <Slider label={t("ov.lt.atStart")} hint={t("ov.lt.atStartHint")}
            value={lt.seconds} min={0} max={20} step={1} onChange={(seconds) => patch("lowerThird", { seconds })} format={(v) => (v ? `${v} s` : t("ov.lt.off"))} />
          <Button size="sm" onClick={() => compositor().overlays.toggleLowerThird()}><Eye />{manual ? t("ov.lt.hide") : t("ov.lt.showNow")}</Button>
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
      <Field label={t("ov.card.title")}><input className="input" value={card.title} maxLength={80} placeholder={kind === "intro" ? t("ov.card.introPlaceholder") : t("ov.card.outroPlaceholder")} onChange={(e) => set({ title: e.target.value })} /></Field>
      <Field label={t("ov.card.subtitle")}><input className="input" value={card.subtitle} maxLength={120} placeholder={t("ov.card.optional")} onChange={(e) => set({ subtitle: e.target.value })} /></Field>
      <Slider label={t("ov.card.length")} value={card.seconds} min={1} max={10} step={0.5} onChange={(seconds) => set({ seconds })} format={(v) => `${num(v)} s`} />
      <div className="row">
        <span className="row-label">{t("ov.card.background")}</span>
        <Segmented<CardLook["background"]> value={card.background} options={[{ value: "look", label: t("ov.card.bgLook"), hint: t("ov.card.bgLookHint") }, { value: "color", label: t("ov.card.colour") }]} onChange={(background) => set({ background })} />
      </div>
      {card.background === "color" && <ColorField label={t("ov.card.colour")} value={card.color} onChange={(color) => set({ color })} />}
      <ColorField label={t("ov.card.textColour")} value={card.textColor} onChange={(textColor) => set({ textColor })} />
      <Button size="sm" onClick={() => compositor().overlays.preview(kind)}><Eye />{t("ov.card.preview")}</Button>
    </div>
  );
}

/** The standard outro title follows the app's language; a title someone typed stays as it is. */
const outroTitle = (title: string) => (["en", "es"] as const).some((l) => tIn(l, "ov.card.outroDefault") === title) ? { title: t("ov.card.outroDefault") } : {};

export function IntroOutroCard() {
  const s = useRecord();
  const patch = usePatch();
  return (
    <Card title={t("card.introOutro")} hint={t("ov.io.hint")}>
      <Switch label={t("ov.io.intro")} hint={t("ov.io.introHint")} checked={s.intro.enabled} onChange={(enabled) => patch("intro", { enabled })} />
      {s.intro.enabled && <CardFields kind="intro" card={s.intro} />}
      <Switch label={t("ov.io.outro")} hint={t("ov.io.outroHint")} checked={s.outro.enabled} onChange={(enabled) => patch("outro", { enabled, ...(enabled ? outroTitle(s.outro.title) : {}) })} />
      {s.outro.enabled && <CardFields kind="outro" card={s.outro} />}
    </Card>
  );
}
