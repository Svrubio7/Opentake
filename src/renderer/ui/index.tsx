// The shared controls every module uses, so the whole app speaks one design language (styles in ui.css).
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import {
  AppWindow, ArrowDownUp, AudioLines, Clapperboard, CircleDot, Crop, FileText, FileVideo, FolderOpen, FolderOutput, Frame, IdCard, Image,
  Info, Keyboard, LifeBuoy, Mic, MousePointer2, Palette, PanelTop, PenLine, PictureInPicture2, Sparkle, Stamp, SunMedium, Video, ZoomIn,
  type LucideIcon,
} from "lucide-react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Button({ variant = "outline", size, block, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "ink" | "outline" | "ghost" | "danger" | "link";
  size?: "sm" | "lg" | "icon" | "icon-sm";
  block?: boolean;
}) {
  const sizes = size === "icon-sm" ? "btn-icon btn-sm" : size ? `btn-${size}` : "";
  return <button type={type} className={cx("btn", `btn-${variant}`, sizes, block && "btn-block", className)} {...rest} />;
}

/** An explanation that lives on hover, next to a title or a label. */
export function Hint({ text }: { text: string }) {
  return <span className="hint" title={text} aria-label={text} tabIndex={0}><Info /></span>;
}

/** Each card's mark by its title, so every module's cards carry one without passing it (an `icon` prop wins). */
const CARD_MARKS: Record<string, LucideIcon> = {
  Look: Palette, Frame, Background: Image, "Screen window": AppWindow, "Camera window": AppWindow, Camera: Video, Pointer: MousePointer2,
  "Draw on screen": PenLine, Keystrokes: Keyboard, Logo: Stamp, "Name card": IdCard, "Intro and outro": Clapperboard, Recording: CircleDot,
  "Auto zoom": ZoomIn, "When you stop": FileVideo, Input: Mic, Sound: AudioLines, "Light and colour": SunMedium, Detail: Sparkle, Framing: Crop,
  Scroll: ArrowDownUp, Script: FileText, Overlay: PanelTop, "Pop-out window": PictureInPicture2, Keys: Keyboard, "Recordings folder": FolderOpen,
  Exports: FolderOutput, Help: LifeBuoy,
};

export function Card({ title, hint, action, icon, className, children }: { title?: ReactNode; hint?: string; action?: ReactNode; icon?: LucideIcon | null; className?: string; children?: ReactNode }) {
  const Mark = icon === null ? null : icon ?? (typeof title === "string" ? CARD_MARKS[title] : undefined);
  return (
    <section className={cx("card", className)}>
      {(title || action) && (
        <div className="card-head">
          <h3 className="card-title">{Mark && <span className="card-mark" aria-hidden><Mark /></span>}{title}{hint && <Hint text={hint} />}</h3>
          {action && <div className="card-actions">{action}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export type SegOption<T> = { value: T; label: ReactNode; hint?: string; disabled?: boolean };

export function Segmented<T extends string | number>({ value, options, onChange, disabled, fill, icon, label }: {
  value: T; options: SegOption<T>[]; onChange: (v: T) => void; disabled?: boolean; fill?: boolean; icon?: boolean; label?: string;
}) {
  return (
    <div className={cx("seg", fill && "seg-fill", icon && "seg-icon")} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} title={o.hint}
          aria-label={typeof o.label === "string" ? undefined : o.hint}
          className={o.value === value ? "on" : ""} disabled={disabled || o.disabled} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The bare switch, for places that bring their own label (a stage header). */
export function SwitchControl({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onChange(!checked); }} />
  );
}

/** A labelled on/off row. The whole row is the click target. */
export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: string; disabled?: boolean }) {
  return (
    <div className={cx("switch-row", disabled && "disabled")} onClick={() => !disabled && onChange(!checked)}>
      <span>{label}{hint && <Hint text={hint} />}</span>
      <SwitchControl checked={checked} onChange={onChange} label={typeof label === "string" ? label : "Toggle"} disabled={disabled} />
    </div>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format, hint, side, onDoubleClick, disabled }: {
  label: ReactNode; value: number; min: number; max: number; step?: number; onChange: (v: number) => void;
  format?: (v: number) => string; hint?: string; side?: ReactNode; onDoubleClick?: () => void; disabled?: boolean;
}) {
  // a range around zero (exposure, EQ gain) fills from the zero point, the rest from the left
  const at = (v: number) => Math.max(0, Math.min(1, (v - min) / (max - min || 1))) * 100;
  const origin = min < 0 && max > 0 ? at(0) : 0;
  const lo = Math.min(origin, at(value)), hi = Math.max(origin, at(value));
  return (
    <label className="slider">
      <span className="slider-head">
        <span>{label}{hint && <Hint text={hint} />}</span>
        <span className="slider-side">{side}<span className="slider-value">{format ? format(value) : value}</span></span>
      </span>
      <input className="range" type="range" min={min} max={max} step={step} value={value} disabled={disabled}
        style={{ "--lo": `${lo}%`, "--hi": `${hi}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))} onDoubleClick={onDoubleClick} />
    </label>
  );
}

export function Field({ label, hint, inline, children }: { label: ReactNode; hint?: string; inline?: boolean; children: ReactNode }) {
  return (
    <label className={cx("field", inline && "field-inline")}>
      <span className={inline ? "row-label" : "label"}>{label}{hint && <> <Hint text={hint} /></>}</span>
      {children}
    </label>
  );
}

/** A colour swatch that opens the system picker, with the hex beside it. */
export function ColorField({ label, value, onChange, disabled }: { label: ReactNode; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <label className={cx("field field-inline color-field", disabled && "disabled")}>
      <span className="row-label">{label}</span>
      <span className="color-control">
        <span className="color-hex tnum">{value.toUpperCase()}</span>
        <input type="color" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} />
      </span>
    </label>
  );
}

/** A whole-number box that commits on blur or Enter, so typing "1" on the way to "1080" changes nothing. */
export function NumberField({ label, value, min, max, step = 1, suffix, onCommit, disabled }: {
  label: ReactNode; value: number; min: number; max: number; step?: number; suffix?: string; onCommit: (v: number) => void; disabled?: boolean;
}) {
  const commit = (el: HTMLInputElement) => {
    const n = Number(el.value);
    if (!Number.isFinite(n)) { el.value = String(value); return; }
    const v = Math.min(max, Math.max(min, Math.round(n / step) * step));
    el.value = String(v);
    if (v !== value) onCommit(v);
  };
  return (
    <label className={cx("number-field", disabled && "disabled")}>
      <span className="label">{label}</span>
      <span className="number-control">
        <input key={value} className="input tnum" type="number" inputMode="numeric" defaultValue={value} min={min} max={max} step={step} disabled={disabled}
          onBlur={(e) => commit(e.currentTarget)} onKeyDown={(e) => { if (e.key === "Enter") commit(e.currentTarget); }} />
        {suffix && <span className="number-suffix">{suffix}</span>}
      </span>
    </label>
  );
}

/** A section inside a card that folds away (the less used settings). */
export function Disclosure({ title, children, defaultOpen }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="disclosure" open={defaultOpen}>
      <summary>{title}</summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Tag({ tone = "neutral", children, title }: { tone?: "neutral" | "brand" | "good" | "warn" | "danger" | "rec"; children: ReactNode; title?: string }) {
  return <span className={cx("tag", tone)} title={title}><i className="dot" />{children}</span>;
}
