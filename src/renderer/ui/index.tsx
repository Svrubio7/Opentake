// The shared controls every module uses, so the whole app speaks one design language (styles in ui.css).
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import { Info } from "lucide-react";

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

export function Card({ title, hint, action, className, children }: { title?: ReactNode; hint?: string; action?: ReactNode; className?: string; children?: ReactNode }) {
  return (
    <section className={cx("card", className)}>
      {(title || action) && (
        <div className="card-head">
          <h3 className="card-title">{title}{hint && <Hint text={hint} />}</h3>
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

export function Tag({ tone = "neutral", children, title }: { tone?: "neutral" | "brand" | "good" | "warn" | "danger" | "rec"; children: ReactNode; title?: string }) {
  return <span className={cx("tag", tone)} title={title}><i className="dot" />{children}</span>;
}
