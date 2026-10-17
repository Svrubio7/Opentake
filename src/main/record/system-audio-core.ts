// Which systems can record the computer's own sound, and the Chromium switches that make it work.
// Pure: platform and OS release in, a verdict out.
import type { SystemAudioSupport } from "../../shared/types";

/** Darwin 22 is macOS 13, the first with ScreenCaptureKit audio. */
const MAC_FIRST_DARWIN = 22;

export function systemAudioSupport(platform: string, release: string): SystemAudioSupport {
  if (platform === "win32") return { supported: true };
  if (platform === "darwin") {
    const major = Number.parseInt(release.split(".")[0] ?? "", 10);
    return Number.isFinite(major) && major >= MAC_FIRST_DARWIN
      ? { supported: true }
      : { supported: false, reason: "Recording computer sound needs macOS 13 or newer." };
  }
  // Linux: PulseAudio or PipeWire (through its Pulse layer) record the speakers' monitor; whether one
  // is running only shows when the capture is tried
  if (platform === "linux") return { supported: true };
  return { supported: false, reason: "Recording computer sound is not available on this system." };
}

/** Chromium features that turn on loopback capture where it is off by default. */
export function loopbackFeatures(platform: string): string[] {
  if (platform === "darwin") return ["MacLoopbackAudioForScreenShare", "MacSckSystemAudioLoopbackOverride"];
  if (platform === "linux") return ["PulseaudioLoopbackForScreenShare"];
  return [];
}

/** Adds `features` to an existing --enable-features value without dropping what is already there. */
export function mergeFeatures(existing: string, features: string[]): string {
  const list = existing.split(",").map((f) => f.trim()).filter(Boolean);
  for (const f of features) if (!list.includes(f)) list.push(f);
  return list.join(",");
}
