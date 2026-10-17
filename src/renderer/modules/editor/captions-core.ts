// Captions as pure functions (tested in captions-core.test.ts): Vosk's timed words grouped into
// lines people can read, edited by hand, moved onto the cut timeline, and written as SRT, VTT
// and ASS (for burning in). The main process imports this for the export.
import type { CaptionBurn, CaptionLang, CaptionLine, CaptionWord, TakeCaptions, TimeRange } from "@shared/types";
import { indexAt, toEdited } from "./edit-core";

export interface GroupOptions {
  /** characters per row */
  maxChars: number;
  rows: number;
  /** a silence longer than this ends the line (ms) */
  pauseMs: number;
  minMs: number;
  maxMs: number;
}

export const DEFAULT_GROUP: GroupOptions = { maxChars: 32, rows: 2, pauseMs: 600, minMs: 900, maxMs: 6000 };

/** Words a line should not end on when the break is ours to choose (it reads as cut off). */
const LEANING: Record<CaptionLang, Set<string>> = {
  en: new Set("a an the and or but of to in on at for with from by as that than if so my your our their his her its is are was were be i we you they who which".split(" ")),
  es: new Set("el la los las un una unos unas y o pero de del al a en con por para que como si mi tu su sus nuestro es son fue era lo le les se me te nos".split(" ")),
};

/** Splits text into rows of at most `max` characters, on spaces (a single long word gets its own row). */
export function wrapRows(text: string, max: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const w of text.split(/\s+/).filter(Boolean)) {
    if (!row) row = w;
    else if (row.length + 1 + w.length <= max) row += " " + w;
    else { rows.push(row); row = w; }
  }
  if (row) rows.push(row);
  return rows;
}

/** Two balanced rows read better than a full first row and a stub. */
export function balanceRows(text: string, max: number): string[] {
  const rows = wrapRows(text, max);
  if (rows.length !== 2) return rows;
  const words = text.split(/\s+/).filter(Boolean);
  let best = rows, bestDiff = Math.abs(rows[0].length - rows[1].length);
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" "), b = words.slice(i).join(" ");
    if (a.length > max || b.length > max) continue;
    const d = Math.abs(a.length - b.length);
    if (d < bestDiff) { best = [a, b]; bestDiff = d; }
  }
  return best;
}

export const lineText = (l: Pick<CaptionLine, "words">) => l.words.map((w) => w.text).join(" ");

const fits = (text: string, o: GroupOptions) => wrapRows(text, o.maxChars).length <= o.rows;

let idSeq = 0;
export const newLineId = () => `c${Date.now().toString(36)}${(idSeq++).toString(36)}`;

/** Sentence-ish capitals: the first word after a long pause, and "I" in English. */
function tidyWord(text: string, lang: CaptionLang, startsSentence: boolean): string {
  let t = text;
  if (lang === "en" && (t === "i" || /^i'/.test(t))) t = "I" + t.slice(1);
  if (startsSentence && t) t = t[0].toLocaleUpperCase(lang) + t.slice(1);
  return t;
}

/** Recognised words (seconds, Vosk's shape) to caption words in ms, cleaned up. */
export function fromVosk(words: { word: string; start: number; end: number }[], lang: CaptionLang, sentencePauseMs = 900): CaptionWord[] {
  const out: CaptionWord[] = [];
  let lastEnd = -Infinity;
  for (const w of words) {
    const text = (w.word ?? "").trim();
    if (!text || text === "[unk]") continue;
    const start = Math.round(w.start * 1000), end = Math.max(Math.round(w.end * 1000), Math.round(w.start * 1000) + 1);
    out.push({ text: tidyWord(text, lang, start - lastEnd > sentencePauseMs), start, end });
    lastEnd = end;
  }
  return out;
}

/** Groups timed words into caption lines. */
export function groupWords(words: CaptionWord[], lang: CaptionLang, o: GroupOptions = DEFAULT_GROUP): CaptionLine[] {
  const groups: CaptionWord[][] = [];
  let cur: CaptionWord[] = [];
  const flush = () => { if (cur.length) groups.push(cur); cur = []; };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end > o.pauseMs) flush();
    else if (cur.length) {
      const text = [...cur, w].map((x) => x.text).join(" ");
      if (!fits(text, o) || w.end - cur[0].start > o.maxMs) {
        // a forced break: do not leave a leaning word hanging at the end of the line
        const carry: CaptionWord[] = [];
        while (cur.length > 1 && LEANING[lang].has(cur[cur.length - 1].text.toLowerCase())) carry.unshift(cur.pop()!);
        flush();
        cur = carry;
      }
    }
    cur.push(w);
  }
  flush();
  // a line that starts after a pause starts a sentence
  const lines = groups.map((g, i) => {
    const after = groups[i - 1]?.[groups[i - 1].length - 1];
    const fresh = !after || g[0].start - after.end > o.pauseMs / 2;
    const words = fresh ? [{ ...g[0], text: tidyWord(g[0].text, lang, true) }, ...g.slice(1)] : g;
    return { id: newLineId(), start: g[0].start, end: g[g.length - 1].end, words };
  });
  // short lines stay up long enough to read, never over the next one
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = lines[i + 1]?.start ?? Infinity;
    if (l.end - l.start < o.minMs) l.end = Math.min(l.start + o.minMs, next);
  }
  return lines;
}

// ---- editing by hand ----

/** New text for a line: same word count keeps each word's timing, otherwise the time is shared out. */
export function retext(line: CaptionLine, text: string): CaptionLine {
  const parts = text.split(/\s+/).filter(Boolean);
  if (!parts.length) return { ...line, words: [] };
  if (parts.length === line.words.length) return { ...line, words: line.words.map((w, i) => ({ ...w, text: parts[i] })) };
  const span = Math.max(1, line.end - line.start);
  const weights = parts.map((p) => p.length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let at = line.start;
  const words = parts.map((p, i) => {
    const len = (span * weights[i]) / total;
    const w = { text: p, start: Math.round(at), end: Math.round(at + len) };
    at += len;
    return w;
  });
  return { ...line, words };
}

export function mergeWithNext(lines: CaptionLine[], i: number): CaptionLine[] {
  const a = lines[i], b = lines[i + 1];
  if (!a || !b) return lines;
  return [...lines.slice(0, i), { ...a, end: Math.max(a.end, b.end), words: [...a.words, ...b.words] }, ...lines.slice(i + 2)];
}

/** Splits a line before word `at` (1 .. words-1). */
export function splitLine(lines: CaptionLine[], i: number, at: number): CaptionLine[] {
  const l = lines[i];
  if (!l || at <= 0 || at >= l.words.length) return lines;
  const a = l.words.slice(0, at), b = l.words.slice(at);
  return [
    ...lines.slice(0, i),
    { id: l.id, start: l.start, end: a[a.length - 1].end, words: a },
    { id: newLineId(), start: b[0].start, end: l.end, words: b },
    ...lines.slice(i + 1),
  ];
}

/** The word index a caret position in the line's text falls before (for splitting where you typed). */
export function wordIndexAtCaret(text: string, caret: number): number {
  // a caret inside a word splits after it
  return text.slice(0, caret).split(/\s+/).filter(Boolean).length;
}

/** Moves a line (and its words) in time, never before 0. */
export function shiftLine(line: CaptionLine, ms: number): CaptionLine {
  const d = Math.max(-line.start, ms);
  return { ...line, start: line.start + d, end: line.end + d, words: line.words.map((w) => ({ ...w, start: w.start + d, end: w.end + d })) };
}

/** Moves one edge of a line; words outside it are squeezed in. */
export function setLineEdge(line: CaptionLine, edge: "start" | "end", t: number): CaptionLine {
  const start = edge === "start" ? Math.min(Math.max(0, t), line.end - 100) : line.start;
  const end = edge === "end" ? Math.max(t, line.start + 100) : line.end;
  return { ...line, start, end, words: line.words.map((w) => ({ ...w, start: Math.min(Math.max(w.start, start), end), end: Math.min(Math.max(w.end, start), end) })) };
}

export const dropEmpty = (lines: CaptionLine[]) => lines.filter((l) => l.words.length > 0);

export const activeLine = (lines: CaptionLine[], t: number) => lines.findIndex((l) => t >= l.start && t < l.end);

// ---- onto the cut timeline ----

/** A word a cut clips keeps its caption only when this much of it is still heard (ms). */
export const MIN_CLIPPED_WORD_MS = 150;

/**
 * The captions of the edited take: words that were cut go, the rest move to edited time.
 * A word a cut runs through is kept only when most of it and at least MIN_CLIPPED_WORD_MS of it
 * is still heard, and then starts or ends exactly on the cut (a sliver of a word left at a cut
 * edge flashed by as a caption of its own). A line whose words all went is dropped. Lines stay
 * in order and never overlap.
 */
export function remapLines(lines: CaptionLine[], keep: TimeRange[] | null): CaptionLine[] {
  if (!keep) return lines;
  const out: CaptionLine[] = [];
  for (const l of lines) {
    const words: CaptionWord[] = [];
    for (const w of l.words) {
      const mid = (w.start + w.end) / 2;
      const r = keep[indexAt(keep, mid)];
      if (!r) continue;
      // the part of the word inside the stretch that holds its middle, snapped to that stretch
      const from = Math.max(w.start, r.start), to = Math.min(w.end, r.end);
      const clipped = from > w.start || to < w.end;
      if (clipped && to - from < MIN_CLIPPED_WORD_MS) continue;
      const s = toEdited(from, keep)!;
      words.push({ ...w, start: s, end: Math.max(s + (to - from), s + 1) });
    }
    if (!words.length) continue;
    const startS = toEdited(l.start, keep);
    const endS = toEdited(l.end, keep);
    const start = Math.min(words[0].start, startS ?? Infinity);
    const end = Math.max(words[words.length - 1].end, endS != null && endS - words[words.length - 1].end < 2000 ? endS : 0);
    out.push({ ...l, start, end, words });
  }
  for (let i = 0; i < out.length - 1; i++) out[i].end = Math.min(out[i].end, out[i + 1].start);
  return out.filter((l) => l.end > l.start);
}

// ---- files ----

function stamp(ms: number, sep: "," | "."): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000), m = Math.floor((t % 3600000) / 60000), s = Math.floor((t % 60000) / 1000), f = t % 1000;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(f, 3)}`;
}

export function toSrt(lines: CaptionLine[], maxChars = DEFAULT_GROUP.maxChars): string {
  return lines.map((l, i) => `${i + 1}\n${stamp(l.start, ",")} --> ${stamp(l.end, ",")}\n${balanceRows(lineText(l), maxChars).join("\n")}\n`).join("\n");
}

export function toVtt(lines: CaptionLine[], maxChars = DEFAULT_GROUP.maxChars): string {
  return "WEBVTT\n\n" + lines.map((l) => `${stamp(l.start, ".")} --> ${stamp(l.end, ".")}\n${balanceRows(lineText(l), maxChars).join("\n")}\n`).join("\n");
}

const assTime = (ms: number) => {
  const cs = Math.max(0, Math.round(ms / 10));
  const h = Math.floor(cs / 360000), m = Math.floor((cs % 360000) / 6000), s = Math.floor((cs % 6000) / 100), c = cs % 100;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
};
/** ASS colours are &HAABBGGRR, alpha 00 = opaque. */
export const assColor = (hex: string, alpha = 0) => {
  const h = hex.replace("#", "");
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};
const assEscape = (t: string) => t.replace(/\\/g, "\\\\").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");

export const SOCIAL_HIGHLIGHT = "#FFD60A";

/** Social captions: a few big words at a time. */
export function socialChunks(lines: CaptionLine[], maxWords = 3, maxChars = 18): CaptionLine[] {
  const out: CaptionLine[] = [];
  for (const l of lines) {
    let cur: CaptionWord[] = [];
    const flush = () => {
      if (!cur.length) return;
      out.push({ id: `${l.id}-${out.length}`, start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
      cur = [];
    };
    for (const w of l.words) {
      const text = [...cur, w].map((x) => x.text).join(" ");
      if (cur.length && (cur.length >= maxWords || text.length > maxChars)) flush();
      cur.push(w);
    }
    flush();
    // the last chunk keeps the line's tail, and each chunk holds until the next one starts
    if (out.length) out[out.length - 1].end = Math.max(out[out.length - 1].end, l.end);
  }
  for (let i = 0; i < out.length - 1; i++) if (out[i + 1].start - out[i].end < 400) out[i].end = out[i + 1].start;
  return out;
}

/**
 * An ASS script sized to the output frame. Fonts come from the fontsdir the export passes (Geist),
 * with the system's sans serif as the fallback.
 */
export function toAss(lines: CaptionLine[], burn: CaptionBurn, W: number, H: number, font = "Geist"): string {
  const short = Math.min(W, H);
  const social = burn.style === "social";
  const size = Math.round(short * (social ? 0.085 : 0.05));
  const align = burn.position === "top" ? 8 : 2;
  const marginV = Math.round(Math.max(0, Math.min(0.4, burn.margin)) * H);
  const marginH = Math.round(W * 0.06);
  // Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut,
  // ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
  const white = assColor("#FFFFFF");
  const style =
    burn.style === "boxed"
      ? `Style: Default,${font},${size},${white},${white},${assColor("#000000", 0x60)},${assColor("#000000", 0x60)},-1,0,0,0,100,100,0,0,3,${Math.round(size * 0.28)},0,${align},${marginH},${marginH},${marginV},1`
      : social
        ? `Style: Default,${font},${size},${white},${white},${assColor("#000000")},${assColor("#000000", 0x80)},-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size * 0.09))},${Math.round(size * 0.06)},${align},${marginH},${marginH},${marginV},1`
        : `Style: Default,${font},${size},${white},${white},${assColor("#000000", 0x40)},${assColor("#000000", 0x70)},-1,0,0,0,100,100,0,0,1,${Math.max(1, Math.round(size * 0.04))},${Math.max(1, Math.round(size * 0.06))},${align},${marginH},${marginH},${marginV},1`;
  const rowChars = Math.max(12, Math.floor(((W - 2 * marginH) / (size * 0.52))));
  const events: string[] = [];
  if (social) {
    const hl = assColor(SOCIAL_HIGHLIGHT).replace("&H00", "&H");
    for (const l of socialChunks(lines)) {
      l.words.forEach((w, i) => {
        const s = i === 0 ? l.start : w.start;
        const e = i === l.words.length - 1 ? l.end : l.words[i + 1].start;
        if (e <= s) return;
        const text = l.words.map((x, j) => (j === i ? `{\\c${hl}&}${assEscape(x.text.toUpperCase())}{\\c&HFFFFFF&}` : assEscape(x.text.toUpperCase()))).join(" ");
        events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Default,,0,0,0,,${text}`);
      });
    }
  } else {
    for (const l of lines) {
      const rows = balanceRows(lineText(l), Math.min(rowChars, 42)).map(assEscape);
      events.push(`Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Default,,0,0,0,,${rows.join("\\N")}`);
    }
  }
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${W}`,
    `PlayResY: ${H}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    style,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

export function parseCaptions(raw: unknown): TakeCaptions | null {
  const c = raw as TakeCaptions | null;
  if (!c || c.version !== 1 || !Array.isArray(c.lines)) return null;
  const lines = c.lines
    .filter((l) => l && Array.isArray(l.words) && typeof l.start === "number" && typeof l.end === "number")
    .map((l) => ({ id: typeof l.id === "string" ? l.id : newLineId(), start: l.start, end: l.end, words: l.words.filter((w) => w && typeof w.text === "string") }));
  return { version: 1, lang: c.lang === "es" ? "es" : "en", lines };
}
