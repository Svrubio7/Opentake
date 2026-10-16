// Geometry of the in-window prompter overlay. Rects are fractions of the main window's viewport,
// so a saved place survives window resizes. Pure: unit tested.

export interface Rect { x: number; y: number; w: number; h: number }
export interface Viewport { w: number; h: number }
export type Corner = "nw" | "ne" | "sw" | "se";
export type Snap = "top" | "center" | "left" | "right";

export const MIN_W_PX = 260;
export const MIN_H_PX = 130;

/** Keep the box at least the minimum size and fully inside the window. */
export function clampRect(r: Rect, vp: Viewport): Rect {
  const minW = Math.min(1, MIN_W_PX / Math.max(1, vp.w));
  const minH = Math.min(1, MIN_H_PX / Math.max(1, vp.h));
  const w = Math.min(1, Math.max(minW, r.w));
  const h = Math.min(1, Math.max(minH, r.h));
  const x = Math.min(1 - w, Math.max(0, r.x));
  const y = Math.min(1 - h, Math.max(0, r.y));
  return { x, y, w, h };
}

/** Drag the whole box by a pixel offset. */
export function moveRect(start: Rect, dxPx: number, dyPx: number, vp: Viewport): Rect {
  return clampRect({ ...start, x: start.x + dxPx / vp.w, y: start.y + dyPx / vp.h }, vp);
}

/** Drag one corner by a pixel offset; the opposite corner stays put. */
export function resizeRect(start: Rect, corner: Corner, dxPx: number, dyPx: number, vp: Viewport): Rect {
  const dx = dxPx / vp.w, dy = dyPx / vp.h;
  const minW = Math.min(1, MIN_W_PX / vp.w), minH = Math.min(1, MIN_H_PX / vp.h);
  let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
  if (corner === "nw" || corner === "sw") left = Math.min(right - minW, Math.max(0, left + dx));
  else right = Math.max(left + minW, Math.min(1, right + dx));
  if (corner === "nw" || corner === "ne") top = Math.min(bottom - minH, Math.max(0, top + dy));
  else bottom = Math.max(top + minH, Math.min(1, bottom + dy));
  return clampRect({ x: left, y: top, w: right - left, h: bottom - top }, vp);
}

/** Preset places. "top" is the strip under a webcam that sits on top of the screen. */
export function snapRect(where: Snap, vp: Viewport): Rect {
  const margin = Math.min(0.02, 12 / Math.max(1, vp.w));
  switch (where) {
    case "top": return clampRect({ w: 0.44, h: 0.3, x: (1 - 0.44) / 2, y: 0 }, vp);
    case "center": return clampRect({ w: 0.5, h: 0.42, x: 0.25, y: 0.29 }, vp);
    case "left": return clampRect({ w: 0.3, h: 0.8, x: margin, y: 0.1 }, vp);
    case "right": return clampRect({ w: 0.3, h: 0.8, x: 1 - 0.3 - margin, y: 0.1 }, vp);
  }
}

export function toPixels(r: Rect, vp: Viewport) {
  return { left: Math.round(r.x * vp.w), top: Math.round(r.y * vp.h), width: Math.round(r.w * vp.w), height: Math.round(r.h * vp.h) };
}
