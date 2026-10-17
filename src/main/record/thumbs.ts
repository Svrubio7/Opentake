// A small picture of each take for the takes list: thumb.jpg in the take folder, made once with
// ffmpeg from the recording (a frame a little after the start) and made again if the take changes.
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegPath } from "./export";
import { runWatched } from "./ffmpeg-run";
import { mediaUrl } from "./media-core";
import { readMeta, takeDir, takeFiles } from "./takes";

const making = new Map<string, Promise<string | null>>();

/** The take's thumbnail as an opentake-media:// address, or null when it has no picture yet. */
export function takeThumb(id: string): Promise<string | null> {
  let p = making.get(id);
  if (!p) {
    p = make(id).finally(() => making.delete(id));
    making.set(id, p);
  }
  return p;
}

async function make(id: string): Promise<string | null> {
  const meta = await readMeta(id);
  if (meta.status !== "done") return null;
  const src = takeFiles(id, meta).composite;
  if (!src) return null;
  const out = join(takeDir(id), "thumb.jpg");
  const stamp = async () => `${mediaUrl(id, "thumb.jpg")}?v=${Math.round((await stat(out)).mtimeMs)}`;
  if (existsSync(out) && (await stat(out)).mtimeMs >= (await stat(src)).mtimeMs) return stamp();
  // a few frames in (the first can be black while the encoder starts); a short take falls back to frame one
  for (const at of ["1", "0"]) {
    const r = await runWatched(ffmpegPath(), ["-nostdin", "-hide_banner", "-y", "-i", src, "-ss", at, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", out], { stallMs: 20_000 }).catch(() => null);
    if (r?.code === 0 && existsSync(out)) return stamp();
  }
  await rm(out, { force: true }).catch(() => {});
  return null;
}
