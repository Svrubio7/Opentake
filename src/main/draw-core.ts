// OWNED BY: shell agent. Geometry for the drawing windows, free of Electron so it can be tested.

export interface Box { x: number; y: number; width: number; height: number }

/**
 * The rectangles that cover `outer` everywhere except `hole` (both in screen coordinates), in
 * coordinates relative to `outer`: the strokes window's shape with the toolbar cut out of it.
 */
export function shapeWithHole(outer: Box, hole: Box): Box[] {
  const x = hole.x - outer.x, y = hole.y - outer.y, r = x + hole.width, b = y + hole.height;
  return [
    { x: 0, y: 0, width: outer.width, height: y },
    { x: 0, y, width: x, height: hole.height },
    { x: r, y, width: outer.width - r, height: hole.height },
    { x: 0, y: b, width: outer.width, height: outer.height - b },
  ].filter((q) => q.width > 0 && q.height > 0);
}
