// Recording: MediaRecorder on the composited canvas + the processed mic, plus ISO tracks of the raw
// screen and the camera. Chunks go to disk every second through IPC, so a crash keeps the take.
import { getStream } from "@core/streams";
import type { ExportOutput, RecordMode, RecordShortcut, RecordTrack, TakeTimeline } from "@shared/types";
import { t } from "../../../shared/i18n";
import { api, hasBridge } from "./api";
import { AUDIO_BPS, DISK_POLL_MS, diskBeforeTake, diskWhileRecording, takeBitrate, type DiskLevel } from "./disk-core";
import { delayedSoundPath, laterQueue } from "./delay-core";
import { getEngine } from "../audio/engine";
import { delayedSound } from "./delayed-sound";
import { compositor } from "./engine";
import { extensionFor, needsCamera, needsScreen, pickMime, videoBitrate } from "./layout-core";
import { currentLayout, useRecord } from "./store";

import { useShell } from "../shell/store";
import { muteOwnAudio, systemSound, useSystemSound, type TakeAudio } from "./system-audio";
import { pickAudioMime, systemAudioWanted } from "./system-audio-core";

interface Track { track: RecordTrack; rec: MediaRecorder; queue: Promise<void>; bps: number }

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
  /** undoes what the take took: the computer sound capture, the muted playback */
  cleanup: (() => void)[];
  /** what all tracks write together, bits a second */
  bitrate: number;
  diskLevel: DiskLevel;
  /** the composite picture runs this far behind real time (auto zoom ahead of clicks); 0 = live */
  delayMs: number;
  /** schedules a composite recorder step delayMs later, in order (at once when delayMs is 0) */
  later: (fn: () => void) => void;
}


let session: Session | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let outroTimer: ReturnType<typeof setTimeout> | null = null;
/** the app is quitting: the take ends without its outro or the export after it */
let quitting = false;

export { PICK_NOTICE } from "./notice-core";

/** An error from the main process without Electron's "Error invoking remote method" wrapping. */
export function ipcMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

/** A write that failed because the folder went away (a drive unplugged) says so in plain words. */
function writeFailure(track: RecordTrack, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ENOENT|EIO|ENODEV|ENXIO|EBUSY|not available|no such file/i.test(msg)) {
    return t("record.rec.folderGone");
  }
  if (/ENOSPC|no space/i.test(msg)) return t("record.rec.driveFull");
  return t("record.rec.writeFailed", { track: t(`record.rec.track.${track}`), reason: msg });
}

// a message from main that ends in "Settings" / "Ajustes" names its own fix
const SETTINGS_HINT = /Settings|Ajustes/;

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
  const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: bps, audioBitsPerSecond: AUDIO_BPS });
  const t: Track = { track, rec, queue: Promise.resolve(), bps };
  rec.ondataavailable = (e) => {
    if (!e.data.size) return;
    const blob = e.data;
    // chained so chunks land on disk in order
    t.queue = t.queue
      .then(async () => api.chunk({ takeId: s.takeId, track, data: new Uint8Array(await blob.arrayBuffer()) }))
      .catch((err) => {
        if (s.failed) return;
        s.failed = writeFailure(track, err);
        st().set({ error: s.failed });
        // keep going would only lose more: end the take with what reached the disk
        setTimeout(() => { if (session === s) void finishTake(s); }, 0);
      });
  };
  return t;
}

/** Starts recording (with the 3-2-1 countdown when it is on). */
export function startRecording() {
  const s = st();
  if (s.status !== "idle") return;
  if (!hasBridge()) return s.set({ error: t("record.rec.needsApp") });
  // a folder already known to be gone is said before the countdown, not after it (main checks again)
  const folder = useShell.getState().view?.recordings;
  if (folder && folder.state !== "ok") {
    return s.set({
      error: folder.state === "missing"
        ? t("record.notice.folderMissing", { path: folder.path })
        : t("record.notice.folderReadonly", { path: folder.path }),
      noticeAction: "settings",
    });
  }
  if (needsScreen(s.mode) && !getStream("screen")) {
    // the one fix is choosing a screen: open the picker instead of only saying so
    window.dispatchEvent(new Event("opentake:pick-screen"));
    return s.set({ error: null, notice: t("record.notice.pick"), noticeAction: null });
  }
  s.set({ error: null, notice: null, noticeAction: null });
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

/** Opens the computer sound for a take and mixes it with the mic; null when it is off or unavailable. */
async function takeSystemAudio(mic: MediaStreamTrack[], cleanup: (() => void)[], delayMs: number): Promise<TakeAudio | null> {
  const sys = systemSound();
  const ok = await sys.acquire();
  cleanup.push(() => sys.release());
  const audio = ok ? sys.mix(mic, delayMs) : null;
  if (!audio) {
    const reason = useSystemSound.getState().reason;
    st().set({ notice: reason ? t("record.notice.noComputerSoundWhy", { reason: `${reason.charAt(0).toLowerCase()}${reason.slice(1)}` }) : t("record.notice.noComputerSound") });
    return null;
  }
  cleanup.push(audio.dispose);
  // our own playback (the Listen monitor) would come back through the capture
  await muteOwnAudio(true);
  cleanup.push(() => void muteOwnAudio(false));
  return audio;
}

async function checkDiskBeforeTake() {
  try {
    const v = diskBeforeTake((await api.diskSpace()).freeBytes);
    if (v.message) st().set({ notice: v.message });
  } catch { /* the drive could not be read: record anyway */ }
}

async function checkDiskWhileRecording(sess: Session) {
  if (session !== sess) return;
  let v;
  try { v = diskWhileRecording((await api.diskSpace()).freeBytes, sess.bitrate); } catch { return; }
  if (session !== sess || v.level === "ok" || v.level === sess.diskLevel) return;
  sess.diskLevel = v.level;
  if (v.level === "stop") {
    await stopRecording();
    st().set({ error: v.message ?? null });
  } else st().set({ notice: v.message ?? null });
}

async function begin() {
  const s = st();
  const layout = currentLayout(s);
  const comp = compositor();
  const owned: MediaStreamTrack[] = [];
  const cleanup: (() => void)[] = [];
  // with auto zoom the picture runs behind real time from now on (the frames start filling the
  // rings here, before the take's first moment); the composite waits for it below
  const delay = comp.beginDelay();
  cleanup.push(() => comp.endDelay());
  try {
    s.set({ status: "recording", elapsedMs: 0 });
    if (delay.reason) s.set({ notice: t("record.rec.zoomNotice", { reason: delay.reason }) });
    await checkDiskBeforeTake();
    const mic = await getMicTracks(owned);
    const sysAudio = systemAudioWanted(layout.mode, s) ? await takeSystemAudio(mic, cleanup, delay.delayMs) : null;
    const canvasTrack = comp.canvas.captureStream(layout.fps).getVideoTracks()[0];
    owned.push(canvasTrack);
    // a delayed take's composite sound is delayed inside the graph that makes it (the computer sound
    // mix, or the voice engine): one more trip between audio contexts would put it 50 ms behind
    let compositeAudio = sysAudio ? [sysAudio.mixed] : mic;
    const path = delayedSoundPath({ delayMs: delay.delayMs, hasSound: compositeAudio.length > 0, systemMix: !!sysAudio, voiceEngine: st().micSource === "module" });
    if (path === "voice" || path === "hop") {
      const voice = path === "voice" ? getEngine().delayedVoice(delay.delayMs) : null;
      const d = voice ? { tracks: [voice.track], dispose: voice.dispose } : delayedSound(compositeAudio, delay.delayMs);
      cleanup.push(d.dispose);
      compositeAudio = d.tracks;
    }
    const composite = new MediaStream([canvasTrack, ...compositeAudio]);
    const mime = pickMime((m) => MediaRecorder.isTypeSupported(m), compositeAudio.length > 0);
    const isoMime = pickMime((m) => MediaRecorder.isTypeSupported(m), false);

    const screen = needsScreen(layout.mode) && s.isoTracks ? getStream("screen") : null;
    const camera = needsCamera(layout.mode) && layout.mode !== "camera" && s.isoTracks ? comp.cameraStream() : null;
    const camMime = pickMime((m) => MediaRecorder.isTypeSupported(m), mic.length > 0);
    const system = sysAudio && s.isoTracks ? sysAudio.system : null;
    const sysMime = system ? pickAudioMime((m) => MediaRecorder.isTypeSupported(m)) : "";

    const { takeId } = await api.begin({
      mode: layout.mode,
      startedAt: Date.now(),
      layout,
      containers: {
        composite: extensionFor(mime),
        ...(screen ? { screen: extensionFor(isoMime) } : {}),
        ...(camera ? { camera: extensionFor(camMime) } : {}),
        ...(system ? { system: extensionFor(sysMime) } : {}),
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
      scenes: [],
      overlays: comp.overlays.activeList(),
    };
    const sess: Session = {
      takeId, tracks: [], startWall: 0, pausedTotal: 0, pauseStart: null, timeline, owned, unsubscribe: () => {}, timers: [], failed: null, cleanup, bitrate: 0, diskLevel: "ok",
      delayMs: delay.delayMs, later: laterQueue(delay.delayMs),
    };

    sess.tracks.push(makeTrack(sess, "composite", composite, mime, videoBitrate(layout.width, layout.height, layout.fps)));
    if (screen) {
      const ss = comp.screenSize() ?? { width: 1920, height: 1080 };
      sess.tracks.push(makeTrack(sess, "screen", new MediaStream(screen.getVideoTracks()), isoMime, videoBitrate(ss.width, ss.height, layout.fps)));
    }
    if (camera) {
      const cs = comp.cameraSize() ?? { width: 1920, height: 1080 };
      sess.tracks.push(makeTrack(sess, "camera", new MediaStream([...camera.getVideoTracks(), ...mic]), camMime, videoBitrate(cs.width, cs.height, 30)));
    }
    if (system) sess.tracks.push(makeTrack(sess, "system", new MediaStream([system]), sysMime, AUDIO_BPS));
    sess.bitrate = takeBitrate({
      videoBps: sess.tracks.filter((t) => t.track !== "system").map((t) => t.bps),
      audioTracks: sess.tracks.filter((t) => t.rec.stream.getAudioTracks().length > 0).length,
    });

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

    // every scene switch is kept with its time, so an editor (or a later export) can follow the take
    const unsubscribeScenes = useRecord.subscribe((now, prev) => {
      if (now.mode !== prev.mode && session === sess) sess.timeline.scenes?.push({ t: Math.max(0, recordingClock(sess)), scene: now.mode });
    });
    const unsubscribePointer = sess.unsubscribe;
    sess.unsubscribe = () => { unsubscribePointer(); unsubscribeScenes(); };

    sess.startWall = Date.now();
    comp.overlays.takeStarted(sess.startWall);
    // the composite starts when the delayed picture reaches this moment, so every file's clock is the take's
    for (const t of sess.tracks) {
      if (t.track === "composite") sess.later(() => { if (t.rec.state === "inactive") t.rec.start(1000); });
      else t.rec.start(1000);
    }
    session = sess;
    sess.timers.push(setInterval(() => st().set({ elapsedMs: elapsed() }), 200));
    // the click timeline is small: rewrite it every few seconds so a crash keeps it too
    sess.timers.push(setInterval(() => { void api.save({ takeId, final: false, durationMs: elapsed(), timeline: sess.timeline }); }, 5000));
    sess.timers.push(setInterval(() => { void checkDiskWhileRecording(sess); }, DISK_POLL_MS));
    st().set({ takeId, status: "recording" });
  } catch (e) {
    owned.forEach((t) => t.stop());
    cleanup.forEach((f) => f());
    session = null;
    const msg = ipcMessage(e);
    st().set({ status: "idle", error: SETTINGS_HINT.test(msg) ? msg : t("record.rec.startFailed", { reason: msg }), noticeAction: SETTINGS_HINT.test(msg) ? "settings" : null });
  }
}

export function togglePause() {
  const s = session;
  // the outro plays to its end on a timer: a pause there would stop the take with the outro cut short
  if (!s || outroTimer) return;
  const status = st().status;
  // the composite pauses and resumes when its delayed picture reaches the press
  const each = (fn: (t: Track) => void) => s.tracks.forEach((t) => (t.track === "composite" ? s.later(() => fn(t)) : fn(t)));
  if (status === "recording") {
    s.pauseStart = Date.now();
    each((t) => t.rec.state === "recording" && t.rec.pause());
    st().set({ status: "paused" });
  } else if (status === "paused") {
    if (s.pauseStart != null) s.pausedTotal += Date.now() - s.pauseStart;
    s.pauseStart = null;
    each((t) => t.rec.state === "paused" && t.rec.resume());
    st().set({ status: "recording" });
  }
}

export async function stopRecording() {
  if (st().status === "countdown") return cancelCountdown();
  const s = session;
  if (!s || st().status === "stopping") return;
  if (outroTimer) {
    // Stop again during the outro: end the take now
    clearTimeout(outroTimer);
    outroTimer = null;
    return finishTake(s);
  }
  const ms = compositor().overlays.startOutro(Date.now());
  if (ms > 0) {
    // the outro is part of the take: keep recording (resumed if paused) until it has played
    if (st().status === "paused") togglePause();
    outroTimer = setTimeout(() => { outroTimer = null; void finishTake(s); }, ms);
    return;
  }
  return finishTake(s);
}

async function finishTake(s: Session) {
  if (session !== s || st().status === "stopping") return;
  st().set({ status: "stopping" });
  const durationMs = elapsed();
  s.timers.forEach(clearInterval);
  s.unsubscribe();
  const stop = (t: Track) => new Promise<void>((res) => {
    if (t.rec.state === "inactive") return res();
    t.rec.addEventListener("stop", () => res(), { once: true });
    t.rec.stop();
  });
  // the composite stops once its delayed picture has caught up with this moment
  await Promise.all(s.tracks.map((t) => (t.track === "composite" ? new Promise<void>((res) => s.later(() => void stop(t).then(res))) : stop(t))));
  compositor().overlays.takeEnded();
  await Promise.all(s.tracks.map((t) => t.queue));
  s.owned.forEach((t) => t.stop());
  s.cleanup.forEach((f) => f());
  session = null;
  try {
    await api.save({ takeId: s.takeId, final: true, durationMs, timeline: s.timeline });
  } catch (e) {
    st().set({ error: s.failed ?? t("record.rec.closeFailed", { reason: e instanceof Error ? e.message : String(e) }) });
  }
  st().set({ status: "idle", elapsedMs: 0, notice: s.failed ? null : t("record.notice.saved"), noticeAction: s.failed ? null : "takes" });
  await refreshTakes();
  if (st().autoExport && !s.failed && !quitting) void exportTake(s.takeId, "composite");
}

/** Ends the take now (no outro, no export after it) so the app can quit; resolves once it is saved. */
export async function stopForQuit() {
  quitting = true;
  if (st().status === "countdown") return cancelCountdown();
  if (outroTimer) { clearTimeout(outroTimer); outroTimer = null; }
  if (session) await finishTake(session);
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

export async function exportTake(takeId: string, kind: "composite" | "hires", output?: ExportOutput, manual = false) {
  const s = st();
  s.set({ exports: { ...s.exports, [takeId]: { takeId, stage: t("record.rec.exportStarting"), ratio: 0 } } });
  try {
    await api.exportTake({ takeId, kind, loudness: s.loudness, trimSilence: s.trimSilence, output, manual });
  } catch {
    // the failure arrives as a progress event with its message
  }
  await refreshTakes();
}

const SCENE_SHORTCUTS: Partial<Record<RecordShortcut, RecordMode>> = {
  "scene-camera": "camera", "scene-screen-camera": "screen-camera", "scene-screen": "screen",
};

/** Switches scene, before or during a take (never while it is being saved). */
export function switchScene(mode: RecordMode) {
  const s = st();
  if (s.status === "stopping" || s.mode === mode) return;
  s.set({ mode });
}

function onShortcut(a: RecordShortcut) {
  if (a === "toggle") return toggleRecording();
  if (a === "pause") return togglePause();
  const scene = SCENE_SHORTCUTS[a];
  if (scene) return switchScene(scene);
  if (a === "lower-third" && !compositor().overlays.toggleLowerThird()) {
    st().set({ notice: t("record.notice.nameCard"), noticeAction: "overlays" });
  }
}

let wired = false;
/** Shortcut and progress listeners, once per window. */
export function wireRecorder() {
  if (wired || !hasBridge()) return;
  wired = true;
  api.onShortcut(onShortcut);
  api.onExportProgress((p) => {
    const s = st();
    s.set({ exports: { ...s.exports, [p.takeId]: p } });
  });
  void refreshTakes();
}
