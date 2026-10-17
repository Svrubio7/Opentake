import { describe, expect, it } from "vitest";
import { shapeWithHole } from "./draw-core";

const area = (bs: { width: number; height: number }[]) => bs.reduce((n, b) => n + b.width * b.height, 0);

describe("shapeWithHole", () => {
  it("covers the window except the toolbar", () => {
    const outer = { x: 100, y: 0, width: 1000, height: 600 };
    const hole = { x: 320, y: 14, width: 560, height: 96 };
    const parts = shapeWithHole(outer, hole);
    expect(area(parts)).toBe(1000 * 600 - 560 * 96);
    // no part reaches into the hole (relative coordinates: 220..780 x 14..110)
    for (const p of parts) {
      const overlapX = Math.min(p.x + p.width, 780) - Math.max(p.x, 220);
      const overlapY = Math.min(p.y + p.height, 110) - Math.max(p.y, 14);
      expect(overlapX > 0 && overlapY > 0).toBe(false);
    }
  });
  it("drops empty strips when the hole touches an edge", () => {
    const parts = shapeWithHole({ x: 0, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 50, height: 20 });
    expect(parts.every((p) => p.width > 0 && p.height > 0)).toBe(true);
    expect(area(parts)).toBe(100 * 100 - 50 * 20);
  });
});
