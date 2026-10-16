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
  /** reading column width as a percent of the prompter window */
  lineWidth: number;
  /** height of the reading guide as a fraction of the window (0.33 = a third down) */
  guide: number;
  /** show VISUAL: lines and [bracketed] direction notes */
  showNotes: boolean;
  /** epoch ms the countdown ends; scrolling waits until then (0 = no countdown) */
  countdownUntil: number;
  /** a jump the controller asks for; the prompter applies it once per nonce */
  seek: { word: number; nonce: number };
  /** voice-paced: the reader is talking right now */
  speaking: boolean;
  /** voice-tracked: the word the recognizer places the reader on */
  target: number;
  /** script language for number reading and recognition */
  lang: "en" | "es";
}

// ---- record module ----

/** A cursor position. x, y are 0..1 inside the captured display; t is wall-clock ms (Date.now()). */
export interface CursorSample { x: number; y: number; t: number }

/** What the main process can see of the pointer: global hooks (real clicks) or cursor polling only. */
export interface ClickTrackingStatus { hooks: boolean; normalized: boolean; reason?: string }

export type RecordMode = "camera" | "screen-camera" | "screen";
export type OutputAspect = "16:9" | "9:16" | "1:1";
export type BubbleShape = "circle" | "rounded";

/** Camera bubble placement in output space: centre and width as fractions of the output frame. */
export interface BubbleLayout { cx: number; cy: number; size: number; shape: BubbleShape }

export interface RecordLayout {
  mode: RecordMode;
  aspect: OutputAspect;
  width: number;
  height: number;
  fps: number;
  bubble: BubbleLayout;
  /** padding around the screen as a fraction of the shorter output side (0 = edge to edge) */
  padding: number;
  /** screen corner radius in output pixels */
  cornerRadius: number;
  background: string;
  zoom: { enabled: boolean; scale: number };
}

/** Saved beside a take as timeline.json; times are ms on the recording clock (pauses removed). */
export interface TakeTimeline {
  version: 1;
  layout: RecordLayout;
  screenSize?: { width: number; height: number };
  cameraSize?: { width: number; height: number };
  hooks: boolean;
  clicks: { t: number; x: number; y: number; button: number }[];
  cursor: { t: number; x: number; y: number }[];
}

export interface TakeFiles { composite?: string; screen?: string; camera?: string; mp4?: string; hires?: string }

export interface TakeInfo {
  id: string;
  dir: string;
  createdAt: number;
  durationMs: number | null;
  /** "recording" means the app stopped before the take was closed: the chunks on disk are still usable */
  status: "recording" | "done";
  mode: RecordMode;
  files: TakeFiles;
  sizeBytes: number;
}

export type LoudnessTarget = "off" | "-14" | "-16";
export interface ExportOptions {
  takeId: string;
  /** composite = what you saw; hires = the screen track at native resolution with the zoom redone */
  kind: "composite" | "hires";
  loudness: LoudnessTarget;
  trimSilence: boolean;
}
export interface ExportProgress { takeId: string; stage: string; ratio: number | null; done?: boolean; error?: string; output?: string }

export interface RecordBeginRequest { mode: RecordMode; startedAt: number; layout: RecordLayout; containers: { composite: string; screen?: string; camera?: string } }
export interface RecordBeginResult { takeId: string; dir: string }
export type RecordTrack = "composite" | "screen" | "camera";
export interface RecordChunk { takeId: string; track: RecordTrack; data: Uint8Array }
export interface RecordSave { takeId: string; final: boolean; durationMs: number; timeline: TakeTimeline }
export type RecordShortcut = "toggle" | "pause";
