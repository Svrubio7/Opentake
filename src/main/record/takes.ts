// Takes on disk: <recordings folder>/<date time>/ with take.json, timeline.json and the tracks. The
// folder is Documents/OpenTake recordings unless another was chosen in Settings (src/main/settings.ts).
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { RecordBeginRequest, RecordMode, RecordTrack, TakeFiles, TakeInfo, TakeTimeline } from "../../shared/types";
import { takeFolderName, validTakeId } from "./ffmpeg-core";
import { recordingsDir, recordingsProblem } from "../settings";
import { cleanTitle, isInside } from "../settings-core";

export interface TakeMeta {
  id: string;
  createdAt: number;
  status: "recording" | "done";
  mode: RecordMode;
  durationMs: number | null;
  /** file extension per recorded track */
  containers: Partial<Record<RecordTrack, string>>;
  fps: number;
  sceneChanges?: number;
  overlays?: boolean;
  /** a name the person gave the take */
  title?: string;
  /** the app closed before the take was saved; recoverTakes finished it */
  recovered?: boolean;
  frame?: { width: number; height: number };
  /** exports written outside the take folder (or under a chosen name), absolute paths */
  exports?: string[];
}

export const recordingsRoot = () => recordingsDir();

export function takeDir(id: unknown): string {
  if (!validTakeId(id)) throw new Error("bad take id");
  const root = resolve(recordingsRoot());
  const dir = resolve(root, id);
  if (!dir.startsWith(root + sep)) throw new Error("bad take id");
  return dir;
}

const metaCache = new Map<string, TakeMeta>();

export async function readMeta(id: string): Promise<TakeMeta> {
  const cached = metaCache.get(id);
  if (cached) return cached;
  const meta = JSON.parse(await readFile(join(takeDir(id), "take.json"), "utf8")) as TakeMeta;
  metaCache.set(id, meta);
  return meta;
}

async function writeMeta(meta: TakeMeta) {
  metaCache.set(meta.id, meta);
  await writeFile(join(takeDir(meta.id), "take.json"), JSON.stringify(meta, null, 2));
}

export async function beginTake(req: RecordBeginRequest): Promise<{ takeId: string; dir: string }> {
  const problem = await recordingsProblem();
  if (problem) throw new Error(problem);
  const root = recordingsRoot();
  await mkdir(root, { recursive: true });
  const base = takeFolderName(new Date(req.startedAt));
  let id = base;
  for (let i = 2; existsSync(join(root, id)); i++) id = `${base} (${i})`;
  const dir = takeDir(id);
  await mkdir(dir);
  const containers: Partial<Record<RecordTrack, string>> = {};
  for (const [k, v] of Object.entries(req.containers)) if (v === "webm" || v === "mp4") containers[k as RecordTrack] = v;
  const frame = req.layout.width > 0 && req.layout.height > 0 ? { width: req.layout.width, height: req.layout.height } : undefined;
  await writeMeta({ id, createdAt: req.startedAt, status: "recording", mode: req.mode, durationMs: null, containers, fps: req.layout.fps, frame });
  return { takeId: id, dir };
}

const TRACKS: RecordTrack[] = ["composite", "screen", "camera", "system"];

export async function appendChunk(id: string, track: RecordTrack, data: Uint8Array) {
  if (!TRACKS.includes(track)) throw new Error("bad track");
  const meta = await readMeta(id);
  const ext = meta.containers[track];
  if (!ext) throw new Error(`track ${track} was not opened`);
  await appendFile(join(takeDir(id), `${track}.${ext}`), data);
}

export async function saveTake(id: string, final: boolean, durationMs: number, timeline: TakeTimeline) {
  const dir = takeDir(id);
  await writeFile(join(dir, "timeline.json"), JSON.stringify(timeline));
  const meta = await readMeta(id);
  await writeMeta({ ...meta, durationMs, status: final ? "done" : meta.status, sceneChanges: timeline.scenes?.length ?? 0, overlays: (timeline.overlays?.length ?? 0) > 0 });
}

export async function readTimeline(id: string): Promise<TakeTimeline | null> {
  try {
    return JSON.parse(await readFile(join(takeDir(id), "timeline.json"), "utf8")) as TakeTimeline;
  } catch {
    return null;
  }
}

export function takeFiles(id: string, meta: TakeMeta): TakeFiles {
  const dir = takeDir(id);
  const f = (name: string) => (existsSync(join(dir, name)) ? join(dir, name) : undefined);
  return {
    composite: meta.containers.composite && f(`composite.${meta.containers.composite}`),
    screen: meta.containers.screen && f(`screen.${meta.containers.screen}`),
    camera: meta.containers.camera && f(`camera.${meta.containers.camera}`),
    system: meta.containers.system && f(`system.${meta.containers.system}`),
    mp4: f("take.mp4"),
    hires: f("take-hires.mp4"),
    edit: f("edit.json"),
    captions: f("captions.json"),
    outputs: exportedFiles(dir, meta.exports),
  };
}

export async function listTakes(): Promise<TakeInfo[]> {
  const root = recordingsRoot();
  if (!existsSync(root)) return [];
  const out: TakeInfo[] = [];
  for (const e of await readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !validTakeId(e.name)) continue;
    try {
      metaCache.delete(e.name); // the folder may have been touched outside the app
      const meta = await readMeta(e.name);
      const dir = takeDir(e.name);
      let size = 0;
      for (const f of await readdir(dir)) size += (await stat(join(dir, f))).size;
      out.push({
        id: e.name, dir, createdAt: meta.createdAt, durationMs: meta.durationMs, status: meta.status, mode: meta.mode, files: takeFiles(e.name, meta),
        sizeBytes: size, sceneChanges: meta.sceneChanges, overlays: meta.overlays, title: meta.title || undefined, recovered: meta.recovered, frame: meta.frame,
      });
    } catch {
      // not a take folder
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export const forgetTake = (id: string) => metaCache.delete(id);

/** Every export of a take, newest first: the old take-*.mp4 names in its folder and the exports it lists (still on disk). */
function exportedFiles(dir: string, listed: string[] = []): string[] {
  let own: string[] = [];
  try { own = readdirSync(dir).filter((n) => /^take(-[\w.-]+)?\.(mp4|webm|gif|srt|vtt)$/.test(n)).map((n) => join(dir, n)); } catch { /* folder gone */ }
  const all = [...new Set([...listed, ...own])].filter((f) => existsSync(f));
  const mtime = (f: string) => { try { return statSync(f).mtimeMs; } catch { return 0; } };
  return all.sort((a, b) => mtime(b) - mtime(a));
}

/** Gives a take a title (empty clears it). The folder keeps its date name, so nothing else moves. */
export async function renameTake(id: string, title: unknown): Promise<string> {
  const meta = await readMeta(id);
  const t = cleanTitle(title);
  await writeMeta({ ...meta, title: t || undefined });
  return t;
}

/** Remembers an export (and the caption files beside it) so the takes list can show and reveal it. */
export async function recordExport(id: string, files: string[]) {
  const meta = await readMeta(id);
  const exports = [...new Set([...files.map((f) => resolve(f)), ...(meta.exports ?? [])])].slice(0, 200);
  await writeMeta({ ...meta, exports });
}

/** A file the take may show in Explorer or Finder: inside its folder, or one of its exports. */
export async function isTakeFile(id: string, file: string): Promise<boolean> {
  const p = resolve(file);
  if (p !== takeDir(id) && isInside(p, takeDir(id), process.platform === "win32")) return true;
  const meta = await readMeta(id);
  return (meta.exports ?? []).some((f) => resolve(f) === p);
}

export { writeMeta };
