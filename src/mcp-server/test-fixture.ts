// A small take made with ffmpeg for the end-to-end tests: a test pattern, a sound written to a file (never
// played), clicks and a scene switch, with separate screen, camera and computer sound tracks. The
// composite is written as a live WebM, with no index and no length, like MediaRecorder's files.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A mono 16-bit WAV of tone bursts with silences between them, as a Buffer. */
export function toneWav(spans: { start: number; end: number }[], seconds: number, rate = 48000): Buffer {
  const n = Math.round(seconds * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const on = spans.some((s) => t >= s.start && t < s.end);
    // a voice-like mix of two tones, well above the -35 dB silence threshold
    const v = on ? 0.35 * Math.sin(2 * Math.PI * 220 * t) + 0.2 * Math.sin(2 * Math.PI * 330 * t) : 0;
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export const FIXTURE_TAKE = "2026-10-17 10.00.00";
export const FIXTURE_SPANS = [{ start: 0, end: 2 }, { start: 4.5, end: 7 }, { start: 9, end: 12 }];

function ff(bin: string, args: string[]) {
  const r = spawnSync(bin, ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
}

/** Makes <root>/<FIXTURE_TAKE>/ with take.json, timeline.json and the four tracks. Returns its folder. */
export function makeFixtureTake(ffmpeg: string, root: string, o: { speechWav?: string; seconds?: number } = {}): string {
  const seconds = o.seconds ?? 12;
  const dir = join(root, FIXTURE_TAKE);
  mkdirSync(dir, { recursive: true });
  const wav = o.speechWav ?? join(dir, "..", "fixture-tone.wav");
  if (!o.speechWav) writeFileSync(wav, toneWav(FIXTURE_SPANS, seconds));
  const t = String(seconds);
  const vp8 = ["-c:v", "libvpx", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "1M"];
  ff(ffmpeg, ["-f", "lavfi", "-i", `testsrc2=size=1280x720:rate=30:duration=${t}`, "-i", wav, "-t", t, ...vp8, "-c:a", "libopus", "-ar", "48000", "-ac", "2", "-f", "webm", "-live", "1", join(dir, "composite.webm")]);
  ff(ffmpeg, ["-f", "lavfi", "-i", `testsrc=size=1280x720:rate=30:duration=${t}`, "-t", t, ...vp8, "-an", join(dir, "screen.webm")]);
  ff(ffmpeg, ["-f", "lavfi", "-i", `smptebars=size=640x480:rate=30:duration=${t}`, "-i", wav, "-t", t, ...vp8, "-c:a", "libopus", "-ar", "48000", join(dir, "camera.webm")]);
  ff(ffmpeg, ["-f", "lavfi", "-i", `sine=frequency=880:duration=${seconds - 2}`, "-c:a", "libopus", "-ar", "48000", join(dir, "system.webm")]);
  const createdAt = new Date(2026, 9, 17, 10, 0, 0).getTime();
  writeFileSync(join(dir, "take.json"), JSON.stringify({
    id: FIXTURE_TAKE, createdAt, status: "done", mode: "screen-camera", durationMs: seconds * 1000,
    containers: { composite: "webm", screen: "webm", camera: "webm", system: "webm" }, fps: 30, sceneChanges: 1, overlays: false, frame: { width: 1280, height: 720 },
  }, null, 2));
  const layout = {
    mode: "screen-camera", aspect: "16:9", width: 1280, height: 720, fps: 30,
    bubble: { cx: 0.85, cy: 0.8, size: 0.25, shape: "circle" }, padding: 0.04, cornerRadius: 12, background: "#101014", zoom: { enabled: true, scale: 1.8 },
  };
  writeFileSync(join(dir, "timeline.json"), JSON.stringify({
    version: 1, layout, screenSize: { width: 1280, height: 720 }, cameraSize: { width: 640, height: 480 }, hooks: true,
    clicks: [1000, 1300, 1600, 5000, 9500].map((t) => ({ t, x: 0.5, y: 0.5, button: 1 })),
    cursor: [{ t: 0, x: 0.5, y: 0.5 }, { t: seconds * 1000, x: 0.5, y: 0.5 }],
    scenes: [{ t: 6000, scene: "screen" }],
    overlays: [],
  }));
  return dir;
}
