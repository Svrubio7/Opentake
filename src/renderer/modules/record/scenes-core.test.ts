import { describe, expect, it } from "vitest";
import type { RecordLayout } from "@shared/types";
import { blendScenes, coversFrame, easeInOutCubic, lerpRect, scaleRect, sceneGeometry } from "./scenes-core";

const layout = (p: Partial<RecordLayout> = {}): RecordLayout => ({
  mode: "screen-camera", aspect: "16:9", width: 1920, height: 1080, fps: 30,
  bubble: { cx: 0.86, cy: 0.78, size: 0.3, shape: "circle" },
  padding: 0.05, cornerRadius: 18, background: "graphite", zoom: { enabled: true, scale: 1.8 },
  screenScale: 1, screenPosition: { x: 0, y: 0 }, screenShadow: 0.6, screenBorder: 0, ...p,
});
const SCREEN = { w: 1920, h: 1080 };

describe("sceneGeometry", () => {
  it("screen and camera: a window and a bubble", () => {
    const g = sceneGeometry(layout(), SCREEN);
    expect(g.screen?.rect.y).toBe(54);
    expect(g.camera?.bubble).toBe(true);
    expect(g.camera?.rect.w).toBeCloseTo(324);
    expect(g.camera?.radius).toBeCloseTo(162);
  });
  it("screen only has no camera, camera only has no screen", () => {
    expect(sceneGeometry(layout({ mode: "screen" }), SCREEN).camera).toBeNull();
    expect(sceneGeometry(layout({ mode: "camera", padding: 0 }), SCREEN).screen).toBeNull();
  });
  it("camera only fills the frame without padding, sits in a window with it", () => {
    const full = sceneGeometry(layout({ mode: "camera", padding: 0 }), null).camera!;
    expect(full.rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(full.radius).toBe(0);
    const framed = sceneGeometry(layout({ mode: "camera" }), null).camera!;
    expect(framed.rect.x).toBe(54);
    expect(framed.bubble).toBe(false);
  });
  it("no screen window until the capture has a size", () => {
    expect(sceneGeometry(layout(), null).screen).toBeNull();
  });
});

describe("blendScenes", () => {
  const a = sceneGeometry(layout(), SCREEN);
  const b = sceneGeometry(layout({ mode: "camera", padding: 0 }), SCREEN);
  it("starts on the first scene and ends on the second", () => {
    expect(blendScenes(a, b, 0).camera?.rect).toEqual(a.camera?.rect);
    expect(blendScenes(a, b, 1).camera?.rect).toEqual(b.camera?.rect);
    expect(blendScenes(a, b, 1).screen?.alpha).toBe(0);
  });
  it("grows the bubble into the full camera frame", () => {
    const mid = blendScenes(a, b, 0.5).camera!;
    expect(mid.rect.w).toBeGreaterThan(a.camera!.rect.w);
    expect(mid.rect.w).toBeLessThan(1920);
    expect(mid.radius).toBeLessThan(a.camera!.radius);
  });
  it("fades a window that only one scene has", () => {
    const s = sceneGeometry(layout({ mode: "screen" }), SCREEN);
    const mid = blendScenes(s, a, 0.5);
    expect(mid.camera?.alpha).toBeCloseTo(0.5);
    expect(mid.camera!.rect.w).toBeLessThan(a.camera!.rect.w);
    expect(mid.screen?.alpha).toBe(1);
  });
  it("keeps the bubble's look until halfway", () => {
    expect(blendScenes(a, b, 0.4).camera?.bubble).toBe(true);
    expect(blendScenes(a, b, 0.6).camera?.bubble).toBe(false);
  });
});

describe("helpers", () => {
  it("eases in and out", () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    expect(easeInOutCubic(0.1)).toBeLessThan(0.1);
    expect(easeInOutCubic(2)).toBe(1);
  });
  it("scales around the centre and interpolates rects", () => {
    expect(scaleRect({ x: 0, y: 0, w: 100, h: 50 }, 0.5)).toEqual({ x: 25, y: 12.5, w: 50, h: 25 });
    expect(lerpRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 10, w: 20, h: 20 }, 0.5)).toEqual({ x: 5, y: 5, w: 15, h: 15 });
  });
  it("knows when the camera hides everything", () => {
    const full = sceneGeometry(layout({ mode: "camera", padding: 0 }), null).camera;
    expect(coversFrame(full, 1920, 1080)).toBe(true);
    expect(coversFrame({ ...full!, alpha: 0.9 }, 1920, 1080)).toBe(false);
    expect(coversFrame(sceneGeometry(layout(), SCREEN).camera, 1920, 1080)).toBe(false);
  });
});
