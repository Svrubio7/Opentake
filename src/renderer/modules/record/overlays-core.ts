// What is drawn over the picture (pointer, keys, logo, name card, intro and outro cards) as settings
// and pure functions (tested in overlays-core.test.ts). These settings are part of a saved look.
import type { Rect } from "./layout-core";

export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface CursorLook {
  /** draw our own pointer (only where the capture can leave the system pointer out) */
  show: boolean;
  /** 1 to 3 times the normal size */
  size: number;
  /** glide between positions instead of jumping */
  smooth: boolean;
  /** a ring where you click */
  highlight: boolean;
  highlightColor: string;
  /** 0.5 to 2 times the normal ring */
  highlightSize: number;
  /** dim everything but a circle around the pointer */
  spotlight: boolean;
  /** radius as a fraction of the frame's shorter side */
  spotlightSize: number;
  /** how dark the rest gets, 0 to 0.9 */
  spotlightDim: number;
}

export interface KeysLook {
  enabled: boolean;
  /** also show typing (collapsed into a word) and keys without a modifier */
  showAll: boolean;
  position: "bottom-center" | "bottom-left" | "bottom-right";
  size: "small" | "medium" | "large";
}

export interface LogoLook {
  enabled: boolean;
  position: Corner | "custom";
  /** custom position: the logo's centre as fractions of the frame */
  x: number;
  y: number;
  /** the logo's longer side as a fraction of the frame's shorter side */
  size: number;
  opacity: number;
  /** distance from the edges as a fraction of the frame's shorter side */
  margin: number;
}

export type LowerThirdStyle = "bar" | "card" | "minimal";
export type LowerThirdPosition = "bottom-left" | "bottom-right" | "top-left";

export interface LowerThirdLook {
  enabled: boolean;
  name: string;
  title: string;
  style: LowerThirdStyle;
  accent: string;
  position: LowerThirdPosition;
  /** shown for this many seconds at the start of a take; 0 = only with the hotkey */
  seconds: number;
}

export interface CardLook {
  enabled: boolean;
  title: string;
  subtitle: string;
  seconds: number;
  /** "look" paints the look's background behind the text, "color" a plain colour */
  background: "look" | "color";
  color: string;
  textColor: string;
}

export interface OverlayLook {
  pointer: CursorLook;
  keys: KeysLook;
  logo: LogoLook;
  /** the logo picture as a PNG data URL (stored on its own, like the background picture) */
  logoImage: string | null;
  lowerThird: LowerThirdLook;
  intro: CardLook;
  outro: CardLook;
}

/** Everything new starts off, so the standard look records exactly what it did before (click rings were always on). */
export const DEFAULT_OVERLAYS: OverlayLook = {
  pointer: { show: true, size: 1, smooth: true, highlight: true, highlightColor: "#ffffff", highlightSize: 1, spotlight: false, spotlightSize: 0.16, spotlightDim: 0.55 },
  keys: { enabled: false, showAll: false, position: "bottom-center", size: "medium" },
  logo: { enabled: false, position: "top-right", x: 0.9, y: 0.1, size: 0.14, opacity: 0.9, margin: 0.04 },
  logoImage: null,
  lowerThird: { enabled: false, name: "", title: "", style: "bar", accent: "#3ddc97", position: "bottom-left", seconds: 6 },
  intro: { enabled: false, title: "", subtitle: "", seconds: 3, background: "look", color: "#111114", textColor: "#ffffff" },
  outro: { enabled: false, title: "Thanks for watching", subtitle: "", seconds: 3, background: "look", color: "#111114", textColor: "#ffffff" },
};

export const OVERLAY_KEYS = Object.keys(DEFAULT_OVERLAYS) as (keyof OverlayLook)[];

/** Fills what an older saved look or setting lacks, one object at a time. */
export function mergeOverlays(saved: Partial<OverlayLook> | undefined): OverlayLook {
  const d = DEFAULT_OVERLAYS;
  return {
    pointer: { ...d.pointer, ...saved?.pointer },
    keys: { ...d.keys, ...saved?.keys },
    logo: { ...d.logo, ...saved?.logo },
    logoImage: saved?.logoImage ?? null,
    lowerThird: { ...d.lowerThird, ...saved?.lowerThird },
    intro: { ...d.intro, ...saved?.intro },
    outro: { ...d.outro, ...saved?.outro },
  };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The logo's box: its longer side is `size` of the frame's shorter side, in a corner or at its own centre. */
export function logoRect(logo: LogoLook, imgW: number, imgH: number, W: number, H: number): Rect {
  const m = Math.min(W, H);
  const long = clamp(logo.size, 0.03, 0.5) * m;
  const w = imgW >= imgH ? long : (long * imgW) / Math.max(1, imgH);
  const h = imgW >= imgH ? (long * imgH) / Math.max(1, imgW) : long;
  const margin = clamp(logo.margin, 0, 0.2) * m;
  if (logo.position === "custom") {
    return { x: clamp(logo.x * W - w / 2, 0, W - w), y: clamp(logo.y * H - h / 2, 0, H - h), w, h };
  }
  const left = logo.position.endsWith("left"), top = logo.position.startsWith("top");
  return { x: left ? margin : W - margin - w, y: top ? margin : H - margin - h, w, h };
}

/** Where a box of w x h goes for an overlay anchored at a bottom or top position, `margin` from the edges. */
export function anchorBox(position: KeysLook["position"] | LowerThirdPosition, w: number, h: number, W: number, H: number, marginX: number, marginY: number): Rect {
  const top = position.startsWith("top");
  const x = position.endsWith("left") ? marginX : position.endsWith("right") ? W - marginX - w : (W - w) / 2;
  return { x, y: top ? marginY : H - marginY - h, w, h };
}

export const KEY_SIZE: Record<KeysLook["size"], number> = { small: 0.75, medium: 1, large: 1.35 };

/** Seconds a card is held, kept sensible. */
export const cardMs = (seconds: number) => clamp(seconds, 1, 15) * 1000;
export const CARD_FADE_MS = 500;

/** The intro card's opacity at `ms` into the take: full for its seconds, then it fades into the scene. */
export function introAlpha(intro: Pick<CardLook, "enabled" | "seconds">, ms: number): number {
  if (!intro.enabled || ms < 0) return 0;
  const hold = cardMs(intro.seconds);
  if (ms <= hold) return 1;
  return Math.max(0, 1 - (ms - hold) / CARD_FADE_MS);
}

/** How long the intro takes up at the start of a take (0 when it is off). */
export const introSpanMs = (intro: Pick<CardLook, "enabled" | "seconds">) => (intro.enabled ? cardMs(intro.seconds) + CARD_FADE_MS : 0);

/** The outro card's opacity `ms` after Stop: it fades in, then holds until the take ends. */
export const outroAlpha = (ms: number) => (ms < 0 ? 0 : Math.min(1, ms / CARD_FADE_MS));

/** How long Stop keeps recording for the outro (0 when it is off). */
export const outroSpanMs = (outro: Pick<CardLook, "enabled" | "seconds">) => (outro.enabled ? CARD_FADE_MS + cardMs(outro.seconds) : 0);

/** A small gap between the intro (or the start) and the name card coming in. */
export const LOWER_THIRD_DELAY_MS = 400;

/**
 * Whether the name card should be up `ms` into the take. The hotkey's choice (true or false) wins;
 * otherwise it shows for its seconds after the intro. Between takes it only shows when toggled on.
 */
export function lowerThirdWanted(lt: Pick<LowerThirdLook, "enabled" | "seconds">, ms: number | null, introMs: number, manual: boolean | null): boolean {
  if (!lt.enabled) return false;
  if (manual != null) return manual;
  if (ms == null || lt.seconds <= 0) return false;
  const start = introMs + LOWER_THIRD_DELAY_MS;
  return ms >= start && ms < start + lt.seconds * 1000;
}

/** Moves v toward 0 or 1 at a constant rate, so a card can slide in and out from wherever it is. */
export const approach = (v: number, target: boolean, dtMs: number, durMs: number) =>
  clamp(v + (target ? 1 : -1) * (Math.max(0, dtMs) / Math.max(1, durMs)), 0, 1);

/** The click ring at `age` ms (of `life`): radius grows, the ring fades. Sizes are 1080p pixels. */
export function rippleAt(age: number, life: number, size: number): { radius: number; alpha: number } | null {
  if (age < 0 || age >= life) return null;
  const t = age / life;
  return { radius: (14 + 34 * t) * size, alpha: 1 - t };
}

/** A point in the screen picture's 0..1 space to frame pixels, through the window and the zoom view. */
export function viewToFrame(p: { x: number; y: number }, r: Rect, view: { sx: number; sy: number; sw: number; sh: number }) {
  return { x: r.x + ((p.x - view.sx) / view.sw) * r.w, y: r.y + ((p.y - view.sy) / view.sh) * r.h };
}
