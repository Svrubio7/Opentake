// Recording: MediaRecorder on the composited canvas + the processed mic, plus ISO tracks of the raw
// screen and the camera. Chunks go to disk every second through IPC, so a crash keeps the take.
import { getStream } from "@core/streams";
import type { ExportOutput, RecordTrack, TakeTimeline } from "@shared/types";
import { api, hasBridge } from "./api";
import { compositor } from "./engine";
import { extensionFor, needsCamera, needsScreen, pickMime, videoBitrate } from "./layout-core";
import { currentLayout, useRecord } from "./store";

interface Track { track: RecordTrack; rec: MediaRecorder; queue: Promise<void> }

interface Session {
  takeId: string;
  tracks: Track[];
  startWall: number;
  pausedTotal: number;
  pauseStart: number | null;
  timeline: TakeTimeline;
  owned: MediaStreamTrack[];
  unsubscribe: () => void;
  timers: ReturnType<typeof setInterval>[];
  failed: string | null;
}

let session: Session | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;

const st = () => useRecord.getState();

function recordingClock(s: Session, wall = Date.now()) {
  const paused = s.pausedTotal + (s.pauseStart != null ? wall - s.pauseStart : 0);
  return wall - s.startWall - paused;
}

const elapsed = () => (session ? recordingClock(session) : 0);

async function getMicTracks(owned: MediaStreamTrack[]): Promise<MediaStreamTrack[]> {
  const mic = getStream("mic");
  if (mic?.getAudioTracks().length) {
    st().set({ micSource: "module" });
    return mic.getAudioTracks();
  }
  try {
    // the Mic module has not published its processed voice: record the default mic untouched
    const raw = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    owned.push(...raw.getTracks());
    st().set({ micSource: "fallback" });
    return raw.getAudioTracks();
  } catch {
    st().set({ micSource: "none" });
    return [];
  }
}

function makeTrack(s: Session, track: RecordTrack, stream: MediaStream, mime: string, bps: number): Track {
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: bps, audioBitsPerSecond: 192_000 });
  const t: Track = { track, rec, queue: Promise.resolve() };
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    const blob = e.data;
    // chained so chunks land on disk in order
    t.queue = t.queue
      .then(async () => api.chunk({ takeId: s.takeId, track, data: new Uint8Array(await blob.arrayBuffer()) }))
      .catch((err) => {
        s.failed = `Could not write the ${track} track: ${err instanceof Error ? err.message : err}`;
        st().set({ error: s.failed });
      });
  };
  return t;
}

/** Starts recording (with the 3-2-1 countdown when it is on). */
export function startRecording() {
  const s = st();
  if (s.status !== "idle") return;
  if (!hasBridge()) return s.set({ error: "Recording needs the desktop app." });
  if (needsScreen(s.mode) && !getStream("screen")) return s.set({ error: "Pick a screen or a window first." });
  s.set({ error: null, notice: null });
  if (!s.countdown) return void begin();
  let n = 3;
  s.set({ status: "countdown", countdownValue: n });
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n > 0) return st().set({ countdownValue: n });
    clearInterval(countdownTimer!);
    countdownTimer = null;
    st().set({ countdownValue: 0 });
    void begin();
  }, 1000);
}

function cancelCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  st().set({ status: "idle", countdownValue: 0 });
}

async function begin() {
  const s = st();
  const layout = currentLayout(s);
  const comp = compositor();
  const owned: MediaStreamTrack[] = [];
  try {
    s.set({ status: "recording", elapsedMs: 0 });
    const mic = await getMicTracks(owned);
    const canvasTrack = comp.canvas.captureStream(layout.fps).getVideoTracks()[0];
    owned.push(canvasTrack);
    const composite = new MediaStream([canvasTrack, ...mic]);
    const mime = pickMime((m) => MediaRecorder.isTypeSupported(m), mic.length > 0);
    const isoMime = pickMime((m) => MediaRecorder.isTypeSupported(m), false);

    const screen = needsScreen(layout.mode) && s.isoTracks ? getStream("screen") : null;
    const camera = needsCamera(layout.mode) && layout.mode !== "camera" && s.isoTracks ? comp.cameraStream() : null;
    const camMime = pickMime((m) => MediaRecorder.isTypeSupported(m), mic.length > 0);

    const { takeId } = await api.begin({
      mode: layout.mode,
      startedAt: Date.now(),
      layout,
      containers: {
        composite: extensionFor(mime),
        ...(screen ? { screen: extensionFor(isoMime) } : {}),
        ...(camera ? { camera: extensionFor(camMime) } : {}),
      },
    });

    const timeline: TakeTimeline = {
      version: 1,
      layout,
      screenSize: comp.screenSize(),
      cameraSize: comp.cameraSize(),
      hooks: !!s.tracking?.hooks,
      clicks: [],
      cursor: [],
    };
    const sess: Session = { takeId, tracks: [], startWall: 0, pausedTotal: 0, pauseStart: null, timeline, owned, unsubscribe: () => {}, timers: [], failed: null };

    sess.tracks.push(makeTrack(sess, "composite", composite, mime, videoBitrate(layout.width, layout.height, layout.fps)));
    if (screen) {
      const ss = comp.screenSize() ?? { width: 1920, height: 1080 };
      sess.tracks.push(makeTrack(sess, "screen", new MediaStream(screen.getVideoTracks()), isoMime, videoBitrate(ss.width, ss.height, layout.fps)));
    }
    if (camera) {
      const cs = comp.cameraSize() ?? { width: 1920, height: 1080 };
      sess.tracks.push(makeTrack(sess, "camera", new MediaStream([...camera.getVideoTracks(), ...mic]), camMime, videoBitrate(cs.width, cs.height, 30)));
    }

    sess.unsubscribe = comp.onPointer({
      click: (e) => {
        if (sess.pauseStart != null) return;
        sess.timeline.clicks.push({ t: Math.max(0, recordingClock(sess, e.t)), x: e.x, y: e.y, button: e.button });
      },
      cursor: (samples) => {
        if (sess.pauseStart != null) return;
        for (const p of samples) sess.timeline.cursor.push({ t: Math.max(0, recordingClock(sess, p.t)), x: p.x, y: p.y });
      },
    });

    sess.startWall = Date.now();
    for (const t of sess.tracks) t.rec.start(1000);
    session = sess;
    sess.timers.push(setInterval(() => st().set({ elapsedMs: elapsed() }), 200));
    // the click timeline is small: rewrite it every few seconds so a crash keeps it too
    sess.timers.push(setInterval(() => { void api.save({ takeId, final: false, durationMs: elapsed(), timeline: sess.timeline }); }, 5000));
    st().set({ takeId, status: "recording" });
  } catch (e) {
    owned.forEach((t) => t.stop());
    session = null;
    st().set({ status: "idle", error: `Could not start recording: ${e instanceof Error ? e.message : e}` });
  }
}

export function togglePause() {
  const s = session;
  if (!s) return;
  const status = st().status;
  if (status === "recording") {
    s.pauseStart = Date.now();
    s.tracks.forEach((t) => t.rec.state === "recording" && t.rec.pause());
    st().set({ status: "paused" });
  } else if (status === "paused") {
    if (s.pauseStart != null) s.pausedTotal += Date.now() - s.pauseStart;
    s.pauseStart = null;
    s.tracks.forEach((t) => t.rec.state === "paused" && t.rec.resume());
    st().set({ status: "recording" });
  }
}

export async function stopRecording() {
  if (st().status === "countdown") return cancelCountdown();
  const s = session;
  if (!s || st().status === "stopping") return;
  st().set({ status: "stopping" });
  const durationMs = elapsed();
  s.timers.forEach(clearInterval);
  s.unsubscribe();
  await Promise.all(s.tracks.map((t) => new Promise<void>((res) => {
    if (t.rec.state === "inactive") return res();
    t.rec.addEventListener("stop", () => res(), { once: true });
    t.rec.stop();
  })));
  await Promise.all(s.tracks.map((t) => t.queue));
  s.owned.forEach((t) => t.stop());
  session = null;
  try {
    await api.save({ takeId: s.takeId, final: true, durationMs, timeline: s.timeline });
  } catch (e) {
    st().set({ error: `Could not close the take: ${e instanceof Error ? e.message : e}` });
  }
  st().set({ status: "idle", elapsedMs: 0, notice: s.failed ? null : "Saved." });
  await refreshTakes();
  if (st().autoExport && !s.failed) void exportTake(s.takeId, "composite");
}

export function toggleRecording() {
  const status = st().status;
  if (status === "idle") startRecording();
  else void stopRecording();
}

export async function refreshTakes() {
  if (!hasBridge()) return;
  try { st().set({ takes: await api.takes() }); } catch { /* folder unreadable: keep the old list */ }
}

export async function exportTake(takeId: string, kind: "composite" | "hires", output?: ExportOutput) {
  const s = st();
  s.set({ exports: { ...s.exports, [takeId]: { takeId, stage: "Starting", ratio: 0 } } });
  try {
    await api.exportTake({ takeId, kind, loudness: s.loudness, trimSilence: s.trimSilence, output });
  } catch {
    // the failure arrives as a progress event with its message
  }
  await refreshTakes();
}

let wired = false;
/** Shortcut and progress listeners, once per window. */
export function wireRecorder() {
  if (wired || !hasBridge()) return;
  wired = true;
  api.onShortcut((a) => (a === "toggle" ? toggleRecording() : togglePause()));
  api.onExportProgress((p) => {
    const s = st();
    s.set({ exports: { ...s.exports, [p.takeId]: p } });
  });
  void refreshTakes();
}
