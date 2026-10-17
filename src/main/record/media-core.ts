// The editor's player streams a take through opentake-media://take/<id>/<file> (pure parts, tested
// in media-core.test.ts). Only a take's own media files are served, never a path from the URL.
import { validTakeId } from "./ffmpeg-core";

export const MEDIA_SCHEME = "opentake-media";

/** The files a take URL may name. */
const SERVABLE = /^(composite|screen|camera|preview)\.(webm|mp4)$|^take(-[\w.-]+)?\.(mp4|webm|gif)$/;

export const mediaUrl = (takeId: string, file: string) => `${MEDIA_SCHEME}://take/${encodeURIComponent(takeId)}/${encodeURIComponent(file)}`;

/** The take id and file a media URL names, or null when it is anything else. */
export function parseMediaUrl(url: string): { takeId: string; file: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== `${MEDIA_SCHEME}:` || u.hostname !== "take") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  let takeId: string, file: string;
  try { takeId = decodeURIComponent(parts[0]); file = decodeURIComponent(parts[1]); } catch { return null; }
  if (!validTakeId(takeId) || !SERVABLE.test(file)) return null;
  return { takeId, file };
}

/** A single "bytes=" range clamped to the file, null when absent, "invalid" when it cannot be served. */
export function parseRange(header: string | null | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return "invalid";
  let start: number, end: number;
  if (!m[1]) {
    const n = Number(m[2]); // the last n bytes
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}

export function mimeFor(file: string): string {
  if (file.endsWith(".mp4")) return "video/mp4";
  if (file.endsWith(".gif")) return "image/gif";
  return "video/webm";
}
