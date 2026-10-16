import { describe, expect, it } from "vitest";
import { clampRect, moveRect, resizeRect, snapRect, toPixels } from "./overlay-core";

const vp = { w: 1000, h: 800 };
const close = (a: object, b: object) => {
  for (const [k, v] of Object.entries(b)) expect((a as Record<string, number>)[k]).toBeCloseTo(v as number, 6);
};

describe("overlay geometry", () => {
  it("keeps the box inside the window and above the minimum size", () => {
    close(clampRect({ x: 0.9, y: -0.2, w: 0.5, h: 0.3 }, vp), { x: 0.5, y: 0, w: 0.5, h: 0.3 });
    close(clampRect({ x: 0, y: 0, w: 0.01, h: 0.01 }, vp), { w: 0.26, h: 130 / 800 });
    close(clampRect({ x: 0, y: 0, w: 3, h: 2 }, vp), { x: 0, y: 0, w: 1, h: 1 });
  });

  it("moves by pixels and stops at the edges", () => {
    close(moveRect({ x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, 100, 80, vp), { x: 0.2, y: 0.2 });
    close(moveRect({ x: 0.1, y: 0.1, w: 0.4, h: 0.3 }, 5000, -5000, vp), { x: 0.6, y: 0 });
  });

  it("resizes from each corner and keeps the opposite corner", () => {
    const start = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    close(resizeRect(start, "se", 100, 80, vp), { x: 0.2, y: 0.2, w: 0.5, h: 0.5 });
    close(resizeRect(start, "nw", -100, -80, vp), { x: 0.1, y: 0.1, w: 0.5, h: 0.5 });
    close(resizeRect(start, "ne", 100, -80, vp), { x: 0.2, y: 0.1, w: 0.5, h: 0.5 });
    close(resizeRect(start, "sw", -100, 80, vp), { x: 0.1, y: 0.2, w: 0.5, h: 0.5 });
  });

  it("never shrinks below the minimum or flips", () => {
    const r = resizeRect({ x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, "nw", 900, 900, vp);
    expect(r.w).toBeCloseTo(0.26, 6);
    expect(r.x + r.w).toBeCloseTo(0.6, 6);
    expect(r.y + r.h).toBeCloseTo(0.6, 6);
  });

  it("snaps to presets", () => {
    const top = snapRect("top", vp);
    expect(top.y).toBe(0);
    expect(top.x + top.w / 2).toBeCloseTo(0.5, 6);
    expect(snapRect("left", vp).x).toBeLessThan(0.05);
    const right = snapRect("right", vp);
    expect(right.x + right.w).toBeGreaterThan(0.95);
    expect(right.x + right.w).toBeLessThanOrEqual(1);
    const c = snapRect("center", vp);
    expect(c.x + c.w / 2).toBeCloseTo(0.5, 6);
    // a tiny window still gets a usable box
    const tiny = snapRect("top", { w: 400, h: 300 });
    expect(tiny.w * 400).toBeGreaterThanOrEqual(260);
  });

  it("converts to pixels", () => {
    expect(toPixels({ x: 0.1, y: 0.25, w: 0.5, h: 0.5 }, vp)).toEqual({ left: 100, top: 200, width: 500, height: 400 });
  });
});
