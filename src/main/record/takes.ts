// Takes on disk: Documents/OpenTake recordings/<date time>/ with take.json, timeline.json and the tracks.
import { app } from "electron";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { RecordBeginRequest, RecordMode, RecordTrack, TakeFiles, TakeInfo, TakeTimeline } from "../../shared/types";
import { takeFolderName, validTakeId } from "./ffmpeg-core";

export interface TakeMeta {
  id: string;
  createdAt: number;
  status: "recording" | "done";
  mode: RecordMode;
  durationMs: number | null;
  /** file extension per recorded track */
  containers: Partial<Record<RecordTrack, string>>;
  fps: number;
}

export const recordingsRoot = () => join(app.getPath("documents"), "OpenTake recordings");

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
  const root = recordingsRoot();
  await mkdir(root, { recursive: true });
  const base = takeFolderName(new Date(req.startedAt));
  let id = base;
  for (let i = 2; existsSync(join(root, id)); i++) id = `${base} (${i})`;
  const dir = takeDir(id);
  await mkdir(dir);
  const containers: Partial<Record<RecordTrack, string>> = {};
  for (const [k, v] of Object.entries(req.containers)) if (v === "webm" || v === "mp4") containers[k as RecordTrack] = v;
  await writeMeta({ id, createdAt: req.startedAt, status: "recording", mode: req.mode, durationMs: null, containers, fps: req.layout.fps });
  return { takeId: id, dir };
}

const TRACKS: RecordTrack[] = ["composite", "screen", "camera"];

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
  await writeMeta({ ...meta, durationMs, status: final ? "done" : meta.status });
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
    mp4: f("take.mp4"),
    hires: f("take-hires.mp4"),
    edit: f("edit.json"),
    captions: f("captions.json"),
    outputs: exportedFiles(dir),
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
      out.push({ id: e.name, dir, createdAt: meta.createdAt, durationMs: meta.durationMs, status: meta.status, mode: meta.mode, files: takeFiles(e.name, meta), sizeBytes: size });
    } catch {
      // not a take folder
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export const forgetTake = (id: string) => metaCache.delete(id);

/** Every export in a take folder (take.mp4, take-reels.webm, take.gif, take.srt...), newest first. */
function exportedFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((n) => /^take(-[\w.-]+)?\.(mp4|webm|gif|srt|vtt)$/.test(n))
      .map((n) => join(dir, n))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  } catch {
    return [];
  }
}
