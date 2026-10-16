// MediaPipe segmentation + face detection, loaded only from local files (the CSP blocks remote code).
import { FaceDetector, ImageSegmenter } from "@mediapipe/tasks-vision";
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";
import segmenterModel from "./models/selfie_segmenter.tflite?url";
import faceModel from "./models/blaze_face_short_range.tflite?url";
import type { Rect } from "./camera-core";

const fileset = { wasmLoaderPath, wasmBinaryPath };

async function withGpuFallback<T>(make: (delegate: "GPU" | "CPU") => Promise<T>): Promise<T> {
  try { return await make("GPU"); } catch { return make("CPU"); }
}

let segP: Promise<ImageSegmenter> | null = null;
let faceP: Promise<FaceDetector> | null = null;

export function loadSegmenter() {
  segP ??= withGpuFallback((delegate) => ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: segmenterModel, delegate },
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  })).catch((e) => { segP = null; throw e; });
  return segP;
}

export function loadFaceDetector() {
  faceP ??= withGpuFallback((delegate) => FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: faceModel, delegate },
    runningMode: "VIDEO",
    minDetectionConfidence: 0.5,
  })).catch((e) => { faceP = null; throw e; });
  return faceP;
}

let lastTs = 0;
/** VIDEO mode needs strictly increasing timestamps per task; one clock for both is enough. */
function ts() { const t = Math.max(Math.round(performance.now()), lastTs + 1); lastTs = t; return t; }

/** Person confidence as bytes (row 0 = top), smoothed over time with the previous mask. */
export class MaskSmoother {
  private prev: Float32Array | null = null;
  out: Uint8Array = new Uint8Array(0);
  push(person: Float32Array, alpha = 0.65) {
    if (!this.prev || this.prev.length !== person.length) { this.prev = Float32Array.from(person); this.out = new Uint8Array(person.length); }
    const p = this.prev, o = this.out;
    for (let i = 0; i < person.length; i++) {
      const v = p[i] + (person[i] - p[i]) * alpha;
      p[i] = v;
      o[i] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255) | 0;
    }
    return o;
  }
  reset() { this.prev = null; }
}

/** Runs the segmenter on a small frame; returns the person confidence, or null. */
export function segment(seg: ImageSegmenter, input: HTMLCanvasElement): { data: Float32Array; w: number; h: number } | null {
  let out: { data: Float32Array; w: number; h: number } | null = null;
  seg.segmentForVideo(input, ts(), (res) => {
    const masks = res.confidenceMasks;
    if (!masks?.length) return;
    // selfie_segmenter has one channel (person); multi-class models put background first
    const m = masks.length === 1 ? masks[0] : masks[1];
    // copy: the mask's memory is only valid inside this callback
    out = { data: Float32Array.from(m.getAsFloat32Array()), w: m.width, h: m.height };
  });
  return out;
}

/** Largest face, normalised to the input frame. */
export function detectFace(det: FaceDetector, input: HTMLCanvasElement): Rect | null {
  const res = det.detectForVideo(input, ts());
  let best: Rect | null = null;
  let area = 0;
  for (const d of res.detections) {
    const b = d.boundingBox;
    if (!b) continue;
    const a = b.width * b.height;
    if (a > area) {
      area = a;
      best = { x: b.originX / input.width, y: b.originY / input.height, w: b.width / input.width, h: b.height / input.height };
    }
  }
  return best;
}
