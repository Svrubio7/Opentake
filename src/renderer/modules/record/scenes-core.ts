// Scenes as pure functions (tested in scenes-core.test.ts): where the screen window and the camera
// sit in each scene, and how one scene turns into the next without changing the canvas.
import type { RecordLayout } from "@shared/types";
import { bubbleRadius, bubbleRect, cameraWindowRect, pxScale, screenRect, type Rect } from "./layout-core";

/** How long a scene switch animates. */
export const SCENE_MS = 450;

/** One drawn window: its place, corner radius (px), opacity, shadow strength (0..1) and border (px). */
export interface Layer { rect: Rect; radius: number; alpha: number; shadow: number; border: number; borderColor?: string }
export interface CameraLayer extends Layer { bubble: boolean }
export interface SceneGeom { screen: Layer | null; camera: CameraLayer | null }

/**
 * Where everything sits in one scene. `screen` is the kept part of the screen picture in source pixels
 * (null while the capture has not started: the scene then has no screen window yet).
 */
export function sceneGeometry(L: RecordLayout, screen: { w: number; h: number } | null): SceneGeom {
  const k = pxScale(L.width, L.height);
  const windowLayer = (rect: Rect): Layer => ({
    rect, radius: L.cornerRadius * k, alpha: 1, shadow: L.screenShadow ?? 0, border: (L.screenBorder ?? 0) * k, borderColor: L.screenBorderColor,
  });
  if (L.mode === "camera") {
    const framed = L.padding > 0 || (L.screenScale ?? 1) < 1;
    const camera: CameraLayer = framed
      ? { ...windowLayer(cameraWindowRect(L)), bubble: false }
      : { rect: { x: 0, y: 0, w: L.width, h: L.height }, radius: 0, alpha: 1, shadow: 0, border: 0, bubble: false };
    return { screen: null, camera };
  }
  const s = screen && screen.w > 0 && screen.h > 0 ? windowLayer(screenRect(L, screen.w, screen.h)) : null;
  if (L.mode === "screen") return { screen: s, camera: null };
  const b = L.bubble;
  const r = bubbleRect(b, L.width, L.height);
  return {
    screen: s,
    camera: { rect: r, radius: bubbleRadius(b, r), alpha: 1, shadow: b.shadow ?? 0.6, border: (b.border ?? 0) * k, borderColor: b.borderColor, bubble: true },
  };
}

export const easeInOutCubic = (t: number) => {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });

/** A rect grown or shrunk around its own centre. */
export function scaleRect(r: Rect, s: number): Rect {
  const w = r.w * s, h = r.h * s;
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h };
}

/** A window that is not in one of the two scenes comes in (or goes out) from this much smaller, faded. */
const ENTER_SCALE = { screen: 0.94, camera: 0.6 };

function blendLayer<T extends Layer>(a: T | null, b: T | null, t: number, enter: number): T | null {
  if (a && b) {
    return {
      ...(t < 0.5 ? a : b),
      rect: lerpRect(a.rect, b.rect, t), radius: lerp(a.radius, b.radius, t), alpha: lerp(a.alpha, b.alpha, t),
      shadow: lerp(a.shadow, b.shadow, t), border: lerp(a.border, b.border, t),
    };
  }
  if (b) return { ...b, rect: scaleRect(b.rect, lerp(enter, 1, t)), radius: b.radius * lerp(enter, 1, t), alpha: b.alpha * t };
  if (a) return { ...a, rect: scaleRect(a.rect, lerp(1, enter, t)), radius: a.radius * lerp(1, enter, t), alpha: a.alpha * (1 - t) };
  return null;
}

/**
 * The picture `t` of the way (0..1, already eased) from one scene to the next: a bubble grows into the
 * full camera frame, a window that only one scene has fades and scales in or out.
 */
export function blendScenes(from: SceneGeom, to: SceneGeom, t: number): SceneGeom {
  return {
    screen: blendLayer(from.screen, to.screen, t, ENTER_SCALE.screen),
    camera: blendLayer(from.camera, to.camera, t, ENTER_SCALE.camera),
  };
}

/** True when the camera layer hides the whole frame (nothing behind it needs drawing). */
export const coversFrame = (c: Layer | null, W: number, H: number) =>
  !!c && c.alpha >= 1 && c.radius <= 0 && c.rect.x <= 0 && c.rect.y <= 0 && c.rect.x + c.rect.w >= W && c.rect.y + c.rect.h >= H;

