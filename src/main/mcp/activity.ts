// The assistant's activity list and its undo, shared by the MCP server (which writes it) and the app
// (which shows it in Settings and can undo). No Electron. Everything lives in <userData>/assistant:
// activity.jsonl, one line per tool call, and snapshots/<id>.json, the files an edit changed as they
// were before it. Undo puts them back only while they still hold what the assistant wrote, so a later
// change by hand is never thrown away. Nothing is deleted: a file the edit created is moved aside.
import { t } from "../../shared/i18n";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ActivityEntry {
  id: string;
  at: number;
  tool: string;
  takeId?: string;
  summary: string;
  ok: boolean;
  /** the edit can be undone (a snapshot was kept) */
  undoable?: boolean;
  /** when it was undone */
  undoneAt?: number;
}

/** A file of a take as an edit found it. `take.json#title` stands for the title alone. */
interface SnapFile { name: string; before: string | null; after?: string | null }
interface Snapshot { id: string; takeId: string; takeDir: string; files: SnapFile[] }

export const TITLE = "take.json#title";
const MAX_LOG_BYTES = 2_000_000;

export const assistantDir = (userData: string) => join(userData, "assistant");
const logFile = (userData: string) => join(assistantDir(userData), "activity.jsonl");
const snapFile = (userData: string, id: string) => join(assistantDir(userData), "snapshots", `${id}.json`);

export const newId = () => `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
const hash = (s: string | null) => (s == null ? null : createHash("sha256").update(s).digest("hex"));

async function readText(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); } catch { return null; }
}

async function readTitle(takeDir: string): Promise<string | null> {
  try { return (JSON.parse(await readFile(join(takeDir, "take.json"), "utf8")) as { title?: string }).title ?? null; } catch { return null; }
}

async function current(takeDir: string, name: string): Promise<string | null> {
  return name === TITLE ? readTitle(takeDir) : readText(join(takeDir, name));
}

async function atomicWrite(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/** What the named files hold now, before an edit changes them. */
export async function snapshot(takeId: string, takeDir: string, names: string[]): Promise<Snapshot> {
  return { id: newId(), takeId, takeDir, files: await Promise.all(names.map(async (name) => ({ name, before: await current(takeDir, name) }))) };
}

async function append(userData: string, line: object) {
  await mkdir(assistantDir(userData), { recursive: true });
  const f = logFile(userData);
  // keep the list short: past 2 MB only the newest half stays
  try {
    if ((await stat(f)).size > MAX_LOG_BYTES) {
      const lines = (await readFile(f, "utf8")).trim().split("\n");
      await atomicWrite(f, lines.slice(-Math.floor(lines.length / 2)).join("\n") + "\n");
    }
  } catch { /* no log yet */ }
  await appendFile(f, JSON.stringify(line) + "\n");
}

/** Logs a tool call; with a snapshot, the edit becomes undoable (what it wrote is fingerprinted now). */
export async function record(userData: string, e: Omit<ActivityEntry, "id" | "at" | "undoable">, snap?: Snapshot): Promise<ActivityEntry> {
  const entry: ActivityEntry = { ...e, id: snap?.id ?? newId(), at: Date.now(), undoable: !!snap };
  if (snap) {
    const files = await Promise.all(snap.files.map(async (f) => ({ ...f, after: hash(await current(snap.takeDir, f.name)) })));
    const changed = files.filter((f) => f.after !== hash(f.before));
    if (changed.length) {
      await mkdir(join(assistantDir(userData), "snapshots"), { recursive: true });
      await writeFile(snapFile(userData, entry.id), JSON.stringify({ ...snap, files: changed }));
    } else entry.undoable = false;
  }
  await append(userData, entry);
  return entry;
}

/** The newest entries first, with undone ones marked. */
export async function readActivity(userData: string, limit = 100): Promise<ActivityEntry[]> {
  const text = await readText(logFile(userData));
  if (!text) return [];
  const entries = new Map<string, ActivityEntry>();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const j = JSON.parse(raw) as ActivityEntry & { undo?: string };
      if (j.undo) { const e = entries.get(j.undo); if (e) e.undoneAt = j.at; continue; }
      if (typeof j.id === "string" && typeof j.tool === "string") entries.set(j.id, j);
    } catch { /* a torn line */ }
  }
  return [...entries.values()].sort((a, b) => b.at - a.at).slice(0, limit);
}

export interface UndoResult { ok: boolean; message: string; takeId?: string }

/** Puts an edit's files back as they were before it. */
export async function undo(userData: string, id: string): Promise<UndoResult> {
  if (!/^[a-z0-9]+-[0-9a-f]{8}$/.test(id)) return { ok: false, message: t("ma.undo.unknown") };
  const entry = (await readActivity(userData, 10_000)).find((e) => e.id === id);
  if (!entry) return { ok: false, message: t("ma.undo.gone") };
  if (entry.undoneAt) return { ok: false, message: t("ma.undo.already"), takeId: entry.takeId };
  const raw = await readText(snapFile(userData, id));
  if (!raw) return { ok: false, message: t("ma.undo.cannot"), takeId: entry.takeId };
  const snap = JSON.parse(raw) as Snapshot;
  if (!existsSync(snap.takeDir)) return { ok: false, message: t("ma.undo.noFolder"), takeId: snap.takeId };
  for (const f of snap.files) {
    if (hash(await current(snap.takeDir, f.name)) !== f.after) {
      return { ok: false, message: t("ma.undo.changedSince"), takeId: snap.takeId };
    }
  }
  for (const f of snap.files) {
    if (f.name === TITLE) {
      const meta = JSON.parse(await readFile(join(snap.takeDir, "take.json"), "utf8")) as { title?: string };
      if (f.before == null) delete meta.title; else meta.title = f.before;
      await atomicWrite(join(snap.takeDir, "take.json"), JSON.stringify(meta, null, 2));
    } else if (f.before == null) {
      // the edit made this file: move it aside instead of deleting it
      const aside = join(snap.takeDir, ".assistant");
      await mkdir(aside, { recursive: true });
      await rename(join(snap.takeDir, f.name), join(aside, `undone-${id}-${f.name}`));
    } else {
      await atomicWrite(join(snap.takeDir, f.name), f.before);
    }
  }
  await append(userData, { undo: id, at: Date.now() });
  return { ok: true, message: t("ma.undo.done", { summary: entry.summary }), takeId: snap.takeId };
}
