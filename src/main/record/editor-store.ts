// edit.json and captions.json beside a take: read, checked and written by the main process only.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TakeCaptions, TakeEdit } from "../../shared/types";
import { parseCaptions } from "../../renderer/modules/editor/captions-core";
import { isWhole, parseEdit } from "../../renderer/modules/editor/edit-core";
import { takeDir } from "./takes";

async function readJson(file: string): Promise<unknown> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

/** The take's edit, or null when it has none (or cuts nothing). An unknown length leaves the times as saved. */
export async function readEdit(takeId: string, durationMs: number | null): Promise<TakeEdit | null> {
  const e = parseEdit(await readJson(join(takeDir(takeId), "edit.json")), durationMs ?? Number.MAX_SAFE_INTEGER);
  if (!e || (durationMs != null && isWhole(e.keep, durationMs))) return null;
  return e;
}

/** Saves the edit; an edit that keeps the whole take removes the file, so the take reads as uncut. */
export async function writeEdit(takeId: string, raw: unknown, durationMs: number): Promise<TakeEdit | null> {
  const file = join(takeDir(takeId), "edit.json");
  const e = parseEdit(raw, durationMs);
  if (!e || isWhole(e.keep, durationMs)) { await rm(file, { force: true }); return null; }
  if (!e.keep.length) throw new Error("An edit has to keep something");
  await writeFile(file, JSON.stringify(e, null, 1));
  return e;
}

export async function readCaptions(takeId: string): Promise<TakeCaptions | null> {
  return parseCaptions(await readJson(join(takeDir(takeId), "captions.json")));
}

export async function writeCaptions(takeId: string, raw: unknown): Promise<TakeCaptions | null> {
  const file = join(takeDir(takeId), "captions.json");
  const c = parseCaptions(raw);
  if (!c) throw new Error("These captions could not be read");
  await writeFile(file, JSON.stringify(c));
  return c;
}
