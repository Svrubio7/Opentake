// The assistant's edits as pure functions (tested in ops-core.test.ts): cuts on the keep list, silences
// from ffmpeg's silencedetect, filler words from the captions, click bursts, and caption fixes. Times
// are ms on the recording clock, the same clock edit.json and captions.json use.
import type { CaptionLang, CaptionLine, TimeRange } from "../shared/types";
import { mergeWithNext, newLineId, retext, setLineEdge, shiftLine, splitLine } from "../renderer/modules/editor/captions-core";
import { MIN_RANGE_MS, normalizeKeep } from "../renderer/modules/editor/edit-core";

// ---- cuts ----

/** What is left of `keep` after taking `cuts` out. Splits inside `keep` stay. */
export function subtractRanges(keep: TimeRange[], cuts: TimeRange[], durationMs: number): TimeRange[] {
  let out = normalizeKeep(keep, durationMs);
  for (const c of normalizeKeep(cuts, durationMs)) {
    const next: TimeRange[] = [];
    for (const r of out) {
      if (c.end <= r.start || c.start >= r.end) { next.push(r); continue; }
      if (c.start > r.start) next.push({ start: r.start, end: c.start });
      if (c.end < r.end) next.push({ start: c.end, end: r.end });
    }
    out = next.filter((r) => r.end - r.start >= MIN_RANGE_MS);
  }
  return out;
}

/** Only the parts of `keep` that are inside `ranges`. */
export function intersectRanges(keep: TimeRange[], ranges: TimeRange[], durationMs: number): TimeRange[] {
  const want = normalizeKeep(ranges, durationMs);
  const out: TimeRange[] = [];
  for (const r of normalizeKeep(keep, durationMs)) {
    for (const w of want) {
      const s = Math.max(r.start, w.start), e = Math.min(r.end, w.end);
      if (e - s >= MIN_RANGE_MS) out.push({ start: s, end: e });
    }
  }
  return out;
}

/** Seconds from a caller as a range in ms, or a plain error. */
export function rangeFromSeconds(r: { start: number; end: number }, durationMs: number): TimeRange {
  if (!Number.isFinite(r.start) || !Number.isFinite(r.end)) throw new Error("A range needs a start and an end in seconds");
  const start = Math.max(0, Math.round(r.start * 1000)), end = Math.min(durationMs, Math.round(r.end * 1000));
  if (end <= start) throw new Error(`The range ${r.start} to ${r.end} s is empty or outside the take (it is ${(durationMs / 1000).toFixed(1)} s long)`);
  return { start, end };
}

// ---- silence ----

/** ffmpeg silencedetect output as silent stretches in ms; a silence still open at the end runs to the end. */
export function parseSilences(stderr: string, durationMs: number | null): TimeRange[] {
  const out: TimeRange[] = [];
  let open: number | null = null;
  for (const line of stderr.split(/\r?\n/)) {
    const s = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (s) { open = Math.max(0, Number(s[1]) * 1000); continue; }
    const e = /silence_end:\s*([\d.]+)/.exec(line);
    if (e && open != null) { out.push({ start: Math.round(open), end: Math.round(Number(e[1]) * 1000) }); open = null; }
  }
  if (open != null && durationMs != null && durationMs > open) out.push({ start: Math.round(open), end: durationMs });
  return out.filter((r) => r.end > r.start);
}

export interface SilenceCutOptions {
  /** only silences at least this long are cut */
  minMs: number;
  /** how much of each pause stays, split between its two sides, so speech is not clipped */
  keepMs: number;
}

/** The stretches to cut out of each long silence, leaving keepMs of pause behind. */
export function silenceCuts(silences: TimeRange[], o: SilenceCutOptions): TimeRange[] {
  const half = Math.max(0, o.keepMs) / 2;
  return silences
    .filter((s) => s.end - s.start >= o.minMs)
    .map((s) => ({ start: Math.round(s.start + half), end: Math.round(s.end - half) }))
    .filter((r) => r.end - r.start >= MIN_RANGE_MS);
}

/** ffmpeg's silencedetect filter for a threshold in dB and a minimum length in ms. */
export const silenceFilter = (noiseDb: number, minMs: number) => `silencedetect=noise=${Math.min(-10, Math.max(-90, noiseDb))}dB:d=${Math.max(0.1, minMs / 1000).toFixed(2)}`;

// ---- filler words ----

/** Sure fillers are cut by default; maybe ones are also real words and are only cut when asked. */
export const FILLERS: Record<CaptionLang, { sure: string[]; maybe: string[] }> = {
  en: { sure: ["um", "umm", "uh", "uhm", "uhh", "er", "erm", "ah", "hmm", "mm", "mmm"], maybe: ["like", "you know", "i mean", "so", "basically", "actually"] },
  es: { sure: ["eh", "ehm", "em", "emm", "mm", "mmm", "este", "o sea"], maybe: ["pues", "bueno", "vale", "digamos", "tipo"] },
};

export interface Filler { start: number; end: number; text: string; lineId: string; sure: boolean }

const norm = (s: string) => s.toLocaleLowerCase().normalize("NFC").replace(/[.,!?¿¡;:"'()]/g, "");

/**
 * Filler words and phrases in the captions. "este" is only a filler when a pause follows it or it
 * stands alone, never "este video".
 */
export function findFillers(lines: CaptionLine[], lang: CaptionLang, o: { maybe?: boolean; extra?: string[] } = {}): Filler[] {
  const list = FILLERS[lang];
  const phrases = [
    ...list.sure.map((p) => ({ p, sure: true })),
    ...(o.maybe ? list.maybe.map((p) => ({ p, sure: false })) : []),
    ...(o.extra ?? []).map((p) => ({ p: norm(p).trim(), sure: true })).filter((x) => x.p),
  ].map((x) => ({ ...x, words: x.p.split(/\s+/) })).sort((a, b) => b.words.length - a.words.length);
  const words = lines.flatMap((l) => l.words.map((w) => ({ ...w, lineId: l.id, n: norm(w.text) })));
  const out: Filler[] = [];
  for (let i = 0; i < words.length; i++) {
    for (const ph of phrases) {
      const span = words.slice(i, i + ph.words.length);
      if (span.length !== ph.words.length || !span.every((w, j) => w.n === ph.words[j])) continue;
      const nextWord = words[i + span.length];
      if (lang === "es" && ph.p === "este" && nextWord && nextWord.start - span[0].end < 250 && !/[,.]$/.test(span[0].text)) continue;
      out.push({ start: span[0].start, end: span[span.length - 1].end, text: span.map((w) => w.text).join(" "), lineId: span[0].lineId, sure: ph.sure });
      i += span.length - 1;
      break;
    }
  }
  return out;
}

/** The cut for each filler, widened by padMs but never into the words around it. */
export function fillerCuts(fillers: Filler[], lines: CaptionLine[], padMs = 60): TimeRange[] {
  const words = lines.flatMap((l) => l.words).sort((a, b) => a.start - b.start);
  return fillers.map((f) => {
    const before = [...words].reverse().find((w) => w.end <= f.start);
    const after = words.find((w) => w.start >= f.end);
    return { start: Math.max(before?.end ?? 0, f.start - padMs), end: Math.min(after?.start ?? Infinity, f.end + padMs) };
  }).filter((r) => r.end - r.start >= MIN_RANGE_MS);
}

// ---- clicks ----

/** Runs of clicks close together (a burst is a busy moment on screen). */
export function clickBursts(clicks: { t: number }[], windowMs = 2000, min = 3): { start: number; end: number; clicks: number }[] {
  const ts = clicks.map((c) => c.t).sort((a, b) => a - b);
  const out: { start: number; end: number; clicks: number }[] = [];
  let i = 0;
  while (i < ts.length) {
    let j = i;
    while (j + 1 < ts.length && ts[j + 1] - ts[j] <= windowMs) j++;
    if (j - i + 1 >= min) out.push({ start: ts[i], end: ts[j], clicks: j - i + 1 });
    i = j + 1;
  }
  return out;
}

// ---- captions ----

export type CaptionOp =
  | { op: "replace_text"; line_id: string; text: string }
  | { op: "find_replace"; find: string; replace: string; whole_word?: boolean; match_case?: boolean }
  | { op: "split"; line_id: string; before_word: number }
  | { op: "merge_with_next"; line_id: string }
  | { op: "retime"; line_id: string; start?: number; end?: number; shift?: number }
  | { op: "delete"; line_id: string };

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Applies caption fixes in order. Times in the ops are seconds. Unknown lines are reported, not guessed. */
export function applyCaptionOps(lines: CaptionLine[], ops: CaptionOp[]): { lines: CaptionLine[]; applied: number; problems: string[] } {
  let cur = lines.map((l) => ({ ...l, words: [...l.words] }));
  const problems: string[] = [];
  let applied = 0;
  const at = (id: string) => cur.findIndex((l) => l.id === id);
  for (const [n, op] of ops.entries()) {
    const where = `Change ${n + 1}`;
    if (op.op === "find_replace") {
      if (!op.find.trim()) { problems.push(`${where}: nothing to find`); continue; }
      let hits = 0;
      if (op.whole_word === false) {
        const re = new RegExp(escapeRe(op.find), op.match_case ? "gu" : "giu");
        cur = cur.map((l) => {
          const text = l.words.map((w) => w.text).join(" ");
          const next = text.replace(re, () => { hits++; return op.replace; });
          return next === text ? l : retext(l, next);
        });
      } else {
        // whole words: the matched words are replaced in place and share their own time, so the
        // rest of the line keeps its timing
        const find = op.find.trim().split(/\s+/).map((w) => (op.match_case ? w : w.toLocaleLowerCase()));
        const repl = op.replace.trim().split(/\s+/).filter(Boolean);
        const key = (t: string) => { const s = t.replace(/[.,!?;:"'()¿¡]+$/u, "").replace(/^[¿¡"'(]+/u, ""); return op.match_case ? s : s.toLocaleLowerCase(); };
        cur = cur.map((l) => {
          const words = [...l.words];
          let changed = false;
          for (let i = 0; i + find.length <= words.length; i++) {
            if (!find.every((f, j) => key(words[i + j].text) === f)) continue;
            const span = words.slice(i, i + find.length);
            const tail = /[.,!?;:"')]+$/u.exec(span[span.length - 1].text)?.[0] ?? "";
            const s = span[0].start, e = span[span.length - 1].end, step = (e - s) / Math.max(1, repl.length);
            const fresh = repl.map((text, k) => ({ text: k === repl.length - 1 ? text + tail : text, start: Math.round(s + k * step), end: Math.round(s + (k + 1) * step) }));
            words.splice(i, find.length, ...fresh);
            i += fresh.length - 1;
            hits++;
            changed = true;
          }
          return changed ? { ...l, words } : l;
        });
      }
      if (!hits) problems.push(`${where}: "${op.find}" is not in the captions`);
      else applied++;
      continue;
    }
    const i = at(op.line_id);
    if (i < 0) { problems.push(`${where}: no caption line ${op.line_id}`); continue; }
    if (op.op === "replace_text") cur[i] = retext(cur[i], op.text);
    else if (op.op === "split") {
      if (!(op.before_word > 0 && op.before_word < cur[i].words.length)) { problems.push(`${where}: line ${op.line_id} has ${cur[i].words.length} words, split before word 1 to ${cur[i].words.length - 1}`); continue; }
      cur = splitLine(cur, i, op.before_word);
    } else if (op.op === "merge_with_next") {
      if (i >= cur.length - 1) { problems.push(`${where}: line ${op.line_id} is the last one`); continue; }
      cur = mergeWithNext(cur, i);
    } else if (op.op === "retime") {
      let l = cur[i];
      if (op.shift != null) l = shiftLine(l, Math.round(op.shift * 1000));
      if (op.start != null) l = setLineEdge(l, "start", Math.round(op.start * 1000));
      if (op.end != null) l = setLineEdge(l, "end", Math.round(op.end * 1000));
      cur[i] = l;
    } else if (op.op === "delete") cur = cur.filter((_, j) => j !== i);
    applied++;
  }
  // a line emptied by new text goes; ids stay unique
  const seen = new Set<string>();
  cur = cur.filter((l) => l.words.length > 0).map((l) => (seen.has(l.id) ? { ...l, id: newLineId() } : (seen.add(l.id), l)));
  cur.sort((a, b) => a.start - b.start);
  return { lines: cur, applied, problems };
}

/** A transcript as plain text with each line's id and time, for a model to read. */
export function transcriptText(lines: CaptionLine[]): string {
  return lines.map((l) => `[${l.id} ${(l.start / 1000).toFixed(2)}-${(l.end / 1000).toFixed(2)}] ${l.words.map((w) => w.text).join(" ")}`).join("\n");
}
