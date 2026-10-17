// Takes on disk for the MCP server: the same folders, take.json, timeline.json, edit.json and
// captions.json the app uses (src/main/record/takes.ts and editor-store.ts), read and written without
// Electron. Every take id is checked and every path stays inside the recordings folder.
import { existsSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CaptionBurn, TakeCaptions, TakeEdit, TakeTimeline } from "../shared/types";
import { parseCaptions } from "../renderer/modules/editor/captions-core";
import { isWhole, parseEdit, wholeTake } from "../renderer/modules/editor/edit-core";
import { cleanTitle, isInside } from "../main/settings-core";
import { validTakeId } from "../main/record/ffmpeg-core";
import { parseCaptionStyle, parseChapters, type Chapter } from "../main/record/take-extras";

export interface Meta {
  id: string;
  createdAt: number;
  status: "recording" | "done";
  mode: "camera" | "screen-camera" | "screen";
  durationMs: number | null;
  containers: Partial<Record<"composite" | "screen" | "camera" | "system", string>>;
  fps: number;
  sceneChanges?: number;
  overlays?: boolean;
  title?: string;
  recovered?: boolean;
  frame?: { width: number; height: number };
  exports?: string[];
  /** made from a video file by import_video */
  imported?: { from: string; at: number };
}

const WIN = process.platform === "win32";

export class Store {
  constructor(readonly root: string) {}

  /** The take's folder; throws a plain line for an id that is not a take here. */
  dir(id: unknown): string {
    if (!validTakeId(id)) throw new Error(`"${String(id).slice(0, 80)}" is not a take id. Use list_takes to see them.`);
    const root = resolve(this.root);
    const dir = resolve(root, id);
    if (dir === root || !isInside(dir, root, WIN)) throw new Error("That take is outside the recordings folder");
    if (!existsSync(join(dir, "take.json"))) throw new Error(`There is no take "${id}" in ${root}. Use list_takes to see them.`);
    return dir;
  }

  async meta(id: string): Promise<Meta> {
    return JSON.parse(await readFile(join(this.dir(id), "take.json"), "utf8")) as Meta;
  }

  /** Changes take.json from what is on disk right now (the app may have written it meanwhile). */
  async patchMeta(id: string, patch: (m: Meta) => Meta): Promise<Meta> {
    const next = patch(await this.meta(id));
    await atomicWrite(join(this.dir(id), "take.json"), JSON.stringify(next, null, 2));
    return next;
  }

  async ids(): Promise<string[]> {
    if (!existsSync(this.root)) return [];
    const out: { id: string; createdAt: number }[] = [];
    for (const e of await readdir(this.root, { withFileTypes: true })) {
      if (!e.isDirectory() || !validTakeId(e.name)) continue;
      try { out.push({ id: e.name, createdAt: (await this.meta(e.name)).createdAt }); } catch { /* not a take */ }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt).map((t) => t.id);
  }

  /** "latest" (or nothing) is the newest take. */
  async resolve(take: string | undefined): Promise<string> {
    if (!take || take === "latest" || take === "last") {
      const [first] = await this.ids();
      if (!first) throw new Error(`There are no takes in ${this.root} yet.`);
      return first;
    }
    this.dir(take);
    return take;
  }

  file(id: string, name: string) { return join(this.dir(id), name); }

  async files(id: string): Promise<{ name: string; bytes: number }[]> {
    const dir = this.dir(id);
    const out: { name: string; bytes: number }[] = [];
    for (const e of await readdir(dir, { withFileTypes: true })) if (e.isFile()) out.push({ name: e.name, bytes: (await stat(join(dir, e.name))).size });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  track(id: string, m: Meta, track: keyof Meta["containers"]): string | null {
    const ext = m.containers[track];
    if (!ext) return null;
    const f = join(this.dir(id), `${track}.${ext}`);
    return existsSync(f) ? f : null;
  }

  async timeline(id: string): Promise<TakeTimeline | null> {
    return (await readJson(this.file(id, "timeline.json"))) as TakeTimeline | null;
  }

  async edit(id: string, durationMs: number | null): Promise<TakeEdit | null> {
    const e = parseEdit(await readJson(this.file(id, "edit.json")), durationMs ?? Number.MAX_SAFE_INTEGER);
    return e?.keep.length ? e : null;
  }

  /** The kept stretches: the edit, or the whole take. */
  async keep(id: string, durationMs: number) {
    return (await this.edit(id, durationMs))?.keep ?? wholeTake(durationMs);
  }

  /** Saves the cuts. The whole take in one piece is saved as such (the editor reads it as uncut); nothing is deleted. */
  async writeEdit(id: string, keep: TakeEdit["keep"], durationMs: number): Promise<TakeEdit> {
    const e = parseEdit({ version: 1, keep }, durationMs);
    if (!e?.keep.length) throw new Error("That would cut the whole take. An edit has to keep something.");
    const file = this.file(id, "edit.json");
    if (isWhole(e.keep, durationMs) && e.keep.length === 1 && !existsSync(file)) return e;
    await atomicWrite(file, JSON.stringify(e, null, 1));
    return e;
  }

  async captions(id: string): Promise<TakeCaptions | null> {
    return parseCaptions(await readJson(this.file(id, "captions.json")));
  }

  async writeCaptions(id: string, c: TakeCaptions) {
    const parsed = parseCaptions(c);
    if (!parsed) throw new Error("These captions could not be read");
    await atomicWrite(this.file(id, "captions.json"), JSON.stringify(parsed));
  }

  async chapters(id: string, durationMs: number | null): Promise<Chapter[]> {
    return parseChapters(await readJson(this.file(id, "chapters.json")), durationMs)?.chapters ?? [];
  }

  async writeChapters(id: string, chapters: Chapter[]) {
    await atomicWrite(this.file(id, "chapters.json"), JSON.stringify({ version: 1, chapters }, null, 1));
  }

  async captionStyle(id: string): Promise<CaptionBurn | null> {
    return parseCaptionStyle(await readJson(this.file(id, "caption-style.json")));
  }

  async writeCaptionStyle(id: string, s: CaptionBurn) {
    await atomicWrite(this.file(id, "caption-style.json"), JSON.stringify(s, null, 1));
  }

  async setTitle(id: string, title: string): Promise<string> {
    const t = cleanTitle(title);
    await this.patchMeta(id, (m) => ({ ...m, title: t || undefined }));
    return t;
  }

  async recordExports(id: string, files: string[]) {
    await this.patchMeta(id, (m) => ({ ...m, exports: [...new Set([...files.map((f) => resolve(f)), ...(m.exports ?? [])])].slice(0, 200) }));
  }
}

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

/** Written beside and renamed over, so the app never reads half a file. */
export async function atomicWrite(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
