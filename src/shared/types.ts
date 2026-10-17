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
export type OutputAspect = "16:9" | "9:16" | "1:1" | "4:3" | "4:5" | "custom";
/** The output's shorter side in pixels (a custom size sets both sides itself). */
export type OutputQuality = 720 | 1080 | 1440 | 2160;
export type BubbleShape = "circle" | "rounded";

/**
 * Camera bubble placement in output space: centre as fractions of the frame, width as a fraction of
 * its shorter side. The optional fields came after v1.0.0: without them a bubble is the old 4:3 one.
 */
export interface BubbleLayout {
  cx: number;
  cy: number;
  size: number;
  shape: BubbleShape;
  /** rounded only: width / height (4:3 by default) */
  aspect?: number;
  /** rounded only: corner radius as a fraction of the shorter side, 0 square to 0.5 pill */
  radius?: number;
  /** border width in pixels at 1080p (scaled with the output) */
  border?: number;
  borderColor?: string;
  /** drop shadow strength, 0 to 1 */
  shadow?: number;
}

/** What is cut off each edge of the captured screen, as fractions of its width or height. */
export interface FrameCrop { top: number; right: number; bottom: number; left: number }

export interface RecordLayout {
  mode: RecordMode;
  aspect: OutputAspect;
  width: number;
  height: number;
  fps: number;
  bubble: BubbleLayout;
  /** padding around the screen as a fraction of the shorter output side (0 = edge to edge) */
  padding: number;
  /** screen corner radius in pixels at 1080p (scaled with the output) */
  cornerRadius: number;
  background: string;
  zoom: { enabled: boolean; scale: number };
  /** the screen window's size inside the padding, 0.3 to 1 (1 = as large as fits) */
  screenScale?: number;
  /** where a smaller window sits in the room left over: -1 left/top, 0 centre, 1 right/bottom */
  screenPosition?: { x: number; y: number };
  /** drop shadow strength of the screen window, 0 to 1 */
  screenShadow?: number;
  /** border width of the screen window in pixels at 1080p */
  screenBorder?: number;
  screenBorderColor?: string;
  /** cut off the edges of the captured screen (a taskbar, a browser's tabs) */
  crop?: FrameCrop;
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
  /** scene switches during the take (it starts on layout.mode) */
  scenes?: { t: number; scene: RecordMode }[];
  /** what was drawn over the picture (logo, name card, keys, intro, outro, pointer); the hi-res export redraws none of it */
  overlays?: string[];
}

export interface TakeFiles {
  composite?: string; screen?: string; camera?: string; system?: string; mp4?: string; hires?: string;
  /** editor: edit.json and captions.json beside the take, and every other exported file */
  edit?: string; captions?: string; outputs?: string[];
}

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
  /** how many times the take switched scenes (the hi-res export follows one layout only) */
  sceneChanges?: number;
  /** the composite carries overlays the hi-res export does not redraw */
  overlays?: boolean;
}

export type LoudnessTarget = "off" | "-14" | "-16";
export interface ExportOptions {
  takeId: string;
  /** composite = what you saw; hires = the screen track at native resolution with the zoom redone */
  kind: "composite" | "hires";
  loudness: LoudnessTarget;
  trimSilence: boolean;
  /** frame, format, quality and captions; left out = the plain MP4 at the take's own size */
  output?: ExportOutput;
  /** apply edit.json when the take has one (default true) */
  useEdit?: boolean;
}
export interface ExportProgress { takeId: string; stage: string; ratio: number | null; done?: boolean; error?: string; output?: string }

export interface RecordBeginRequest { mode: RecordMode; startedAt: number; layout: RecordLayout; containers: { composite: string; screen?: string; camera?: string; system?: string } }
export interface RecordBeginResult { takeId: string; dir: string }
export type RecordTrack = "composite" | "screen" | "camera" | "system";
export interface RecordChunk { takeId: string; track: RecordTrack; data: Uint8Array }
export interface RecordSave { takeId: string; final: boolean; durationMs: number; timeline: TakeTimeline }

// ---- shell: updates ----

/** install = downloads and replaces itself; notify = only says a new version exists; off = dev build */
export type UpdateMode = "install" | "notify" | "off";
export type UpdatePhase = "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error";
export interface UpdateStatus {
  current: string;
  mode: UpdateMode;
  phase: UpdatePhase;
  /** the newer version, once one is found */
  version?: string;
  /** 0..100 while downloading */
  percent?: number;
  /** the release page (notes and downloads) */
  releaseUrl: string;
  error?: string;
  checkedAt?: number;
  /** a take is recording or exporting: restarting waits */
  busy: boolean;
  /** the dev build is pretending to be an older version: never installs */
  fake: boolean;
}

// ---- shell: drawing on the screen ----

export type DrawTool = "pen" | "highlighter" | "arrow" | "rect";
export interface DrawStatus {
  /** drawing mode: the overlay takes the mouse */
  active: boolean;
  /** strokes fade out a few seconds after they are drawn */
  fade: boolean;
  tool: DrawTool;
  color: string;
  shortcut: string;
  /** false when another app holds the shortcut */
  shortcutOk: boolean;
}
export type DrawCommand = "undo" | "clear";
export type RecordShortcut = "toggle" | "pause" | "scene-camera" | "scene-screen-camera" | "scene-screen" | "lower-third";

/** One key press for the keystroke overlay. `key` is a label ("P", "Enter"); the flags are the held modifiers. */
export interface KeyPress { key: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; t: number }

/** Free space on the recordings drive, in bytes. */
export interface DiskSpace { freeBytes: number; totalBytes: number }
/** Whether the computer's own sound can be recorded here; `reason` is one plain line when it cannot. */
export interface SystemAudioSupport { supported: boolean; reason?: string }

// ---- editor: cuts, captions and export options ----

/** A stretch of a take in ms on the recording clock. */
export interface TimeRange { start: number; end: number }
/** Saved beside a take as edit.json: the stretches that stay, in order (neighbours may touch: a split). */
export interface TakeEdit { version: 1; keep: TimeRange[] }

export type CaptionLang = "en" | "es";
export interface CaptionWord { text: string; start: number; end: number }
/** One caption on screen: up to two rows of text, timed by its words (ms on the recording clock). */
export interface CaptionLine { id: string; start: number; end: number; words: CaptionWord[] }
/** Saved beside a take as captions.json. Times are on the recording clock, before any cut. */
export interface TakeCaptions { version: 1; lang: CaptionLang; lines: CaptionLine[] }

export type CaptionStyle = "clean" | "boxed" | "social";
export interface CaptionBurn {
  style: CaptionStyle;
  position: "bottom" | "top";
  /** distance from the edge as a fraction of the frame height */
  margin: number;
}

export type ExportPreset = "original" | "youtube" | "vertical" | "square" | "linkedin" | "x" | "custom";
export type ExportFormat = "mp4" | "webm" | "gif";
export interface ExportOutput {
  preset: ExportPreset;
  format: ExportFormat;
  /** custom preset only */
  width?: number;
  height?: number;
  /** when the frame's shape differs from the take: fit inside with bars, or fill and crop */
  fit: "fit" | "fill";
  /** crf on the x264 scale (18 best .. 28 small), or a target file size in MB (two passes) */
  quality: { mode: "crf"; crf: number } | { mode: "size"; mb: number };
  gif?: { fps: number; width: number };
  captions?: CaptionBurn | null;
}

/** Audio peaks for the editor's waveform: the loudest sample in each bucket, 0 to 1. */
export interface TakePeaks { perSecond: number; peaks: number[] }

export interface EditorTake {
  take: TakeInfo;
  edit: TakeEdit | null;
  captions: TakeCaptions | null;
  /** opentake-media:// address the editor's player can stream (Range requests work) */
  mediaUrl: string;
  durationMs: number | null;
  hasAudio: boolean;
  /** the bundled ffmpeg can burn captions (has libass) */
  canBurn: boolean;
}
