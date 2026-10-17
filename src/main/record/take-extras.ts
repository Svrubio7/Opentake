// Small files beside a take that the assistant writes and the timeline export reads: chapters.json
// (named moments) and caption-style.json (how burned-in captions look by default). Pure parsing and
// checking, no Electron (the MCP server imports this too). Tested in take-extras.test.ts.
import type { CaptionBurn } from "../../shared/types";

export interface Chapter { /** ms on the recording clock */ t: number; title: string }
export interface TakeChapters { version: 1; chapters: Chapter[] }

const MAX_CHAPTERS = 100;

/** Chapters from disk or a caller: sorted, one per moment, titles one short line. */
export function parseChapters(raw: unknown, durationMs: number | null): TakeChapters | null {
  const r = raw as { version?: unknown; chapters?: unknown } | null;
  if (!r || r.version !== 1 || !Array.isArray(r.chapters)) return null;
  return { version: 1, chapters: cleanChapters(r.chapters, durationMs) };
}

export function cleanChapters(list: unknown[], durationMs: number | null): Chapter[] {
  const seen = new Set<number>();
  return list
    .map((c) => c as { t?: unknown; title?: unknown })
    .filter((c) => c && typeof c.t === "number" && Number.isFinite(c.t) && typeof c.title === "string")
    .map((c) => ({ t: Math.max(0, Math.round(c.t as number)), title: (c.title as string).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) }))
    .filter((c) => c.title && (durationMs == null || c.t <= durationMs))
    .sort((a, b) => a.t - b.t)
    .filter((c) => (seen.has(c.t) ? false : (seen.add(c.t), true)))
    .slice(0, MAX_CHAPTERS);
}

const STYLES = ["clean", "boxed", "social"] as const;

/** A caption look from disk or a caller, or null when it is not one. */
export function parseCaptionStyle(raw: unknown): CaptionBurn | null {
  const r = raw as Partial<CaptionBurn> | null;
  if (!r || !STYLES.includes(r.style as (typeof STYLES)[number])) return null;
  const position = r.position === "top" ? "top" : "bottom";
  const margin = typeof r.margin === "number" && Number.isFinite(r.margin) ? Math.min(0.4, Math.max(0, r.margin)) : 0.08;
  return { style: r.style as CaptionBurn["style"], position, margin };
}
