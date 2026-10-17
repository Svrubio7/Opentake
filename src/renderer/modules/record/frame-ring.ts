// A short memory of frames: each compositor tick copies the newest source frame into the oldest
// canvas, at the size the picture needs (delay-core.ts storeSize), and the delayed picture reads
// back the frame stored at its own time. The canvases are made once and reused.
import { pickFrame } from "./delay-core";

export interface StoredFrame { canvas: HTMLCanvasElement; w: number; h: number }

export class FrameRing {
  private slots: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; t: number; w: number; h: number }[] = [];
  private next = 0;
  constructor(private size: number) {}

  /** Copies `src` (its sx, sy, sw, sh part) into the ring at time t, w x h pixels. */
  push(src: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, w: number, h: number, t: number) {
    if (!this.slots.length) {
      for (let i = 0; i < this.size; i++) {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("No canvas for the frame ring");
        this.slots.push({ canvas, ctx, t: -Infinity, w: 0, h: 0 });
      }
    }
    const s = this.slots[this.next];
    this.next = (this.next + 1) % this.slots.length;
    if (s.canvas.width !== w || s.canvas.height !== h) { s.canvas.width = w; s.canvas.height = h; }
    s.ctx.imageSmoothingQuality = "high";
    s.ctx.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
    s.t = t; s.w = w; s.h = h;
  }

  /** The frame stored at time t; the oldest one while the ring is younger than t (null when empty). */
  at(t: number, tickMs: number): StoredFrame | null {
    const i = pickFrame(this.slots.map((s) => s.t), t, tickMs);
    if (i >= 0) return this.slots[i];
    let old: (typeof this.slots)[number] | null = null;
    for (const s of this.slots) if (Number.isFinite(s.t) && (!old || s.t < old.t)) old = s;
    return old;
  }

  /** Frees the canvases' memory (a 0 x 0 canvas holds none). */
  release() {
    for (const s of this.slots) { s.canvas.width = 0; s.canvas.height = 0; }
    this.slots = [];
    this.next = 0;
  }
}
