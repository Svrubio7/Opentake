// Contracts shared by modules. Types only, no logic.

/** Live streams one module produces and another consumes (src/renderer/core/streams.ts). */
export type StreamKind = "mic" | "camera" | "screen";

export interface ClickEvent { x: number; y: number; t: number; button: number }

export interface ScreenSource { id: string; name: string; thumbnail: string; displayId?: string }

export interface PrompterState {
  script: string;
  playing: boolean;
  /** scroll speed when not following the voice */
  wpm: number;
  fontSize: number;
  mirrored: boolean;
  /** index of the word the reader is on */
  position: number;
  mode: "manual" | "voice-paced" | "voice-tracked";
}
