// Pure teleprompter logic: script parsing, spoken-form normalisation, voice alignment, pacing,
// scroll geometry and the command reducer. No DOM, no Electron: everything here is unit tested.
import type { PrompterState } from "@shared/types";

export type Lang = "en" | "es";

// ---------------------------------------------------------------------------------------------
// Script parsing
// ---------------------------------------------------------------------------------------------

export type Item = { type: "word"; i: number } | { type: "note"; text: string };
export interface Paragraph { note: boolean; items: Item[] }
export interface ScriptWord { text: string; sentence: number; paragraph: number; tokens: string[] }
export interface Sentence { start: number; end: number }
/** One spoken token (a script word can expand to several, "96" is "ninety six"). */
export interface Token { t: string; w: number; stop: boolean }
export interface ParsedScript {
  lang: Lang;
  paragraphs: Paragraph[];
  words: ScriptWord[];
  /** word ranges [start, end) */
  sentences: Sentence[];
  tokens: Token[];
  /** first token of each word (tokens.length for a word with none) */
  wordToken: number[];
}

const NOTE_PREFIX = /^\s*(visual|b-?roll|on screen|on-screen|sfx|shot|cut to|note)\s*:/i;
const WHOLE_BRACKET = /^\s*\[[^\]]*\]\s*$/;

/** A line that is a direction for the person recording, never read aloud. */
export function isNoteLine(line: string): boolean {
  return NOTE_PREFIX.test(line) || WHOLE_BRACKET.test(line);
}

/** Markdown inline syntax out, [bracket] notes kept. */
export function stripInlineMarkdown(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/`+/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,!?:;]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\*+/g, "");
}

interface Line { text: string; kind: "text" | "note" | "own" | "break" }

/** Markdown and plain text to lines: blank lines break paragraphs, headings and list items stand alone. */
export function scriptLines(raw: string): Line[] {
  const out: Line[] = [];
  let inFence = false;
  let frontmatter = false;
  const src = raw.replace(/\r\n?/g, "\n").split("\n");
  src.forEach((rawLine, n) => {
    let line = rawLine;
    if (n === 0 && /^---\s*$/.test(line)) { frontmatter = true; return; }
    if (frontmatter) { if (/^---\s*$/.test(line)) frontmatter = false; return; }
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return; }
    if (!inFence && /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push({ text: "", kind: "break" }); return; }
    if (!line.trim()) { out.push({ text: "", kind: "break" }); return; }
    if (inFence) { out.push({ text: line.trim(), kind: "text" }); return; }
    let own = false;
    const heading = line.match(/^\s*#{1,6}\s+(.*?)\s*#*\s*$/);
    if (heading) { line = heading[1]; own = true; }
    line = line.replace(/^\s*>\s?/, "");
    const list = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (list) { line = list[1]; own = true; }
    if (isNoteLine(line)) { out.push({ text: line.trim(), kind: "note" }); return; }
    const text = stripInlineMarkdown(line).trim();
    if (!text) return;
    out.push({ text, kind: own ? "own" : "text" });
  });
  return out;
}

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "st", "vs", "etc", "eg", "ie", "jr", "sr", "sra", "srta", "no", "approx", "inc", "ltd", "co", "fig", "dept", "ud", "uds", "pág", "aprox",
]);

/** Does this displayed word close a sentence? */
export function endsSentence(word: string): boolean {
  if (!/[.!?…]["'”’»)\]]*$/.test(word)) return false;
  if (/[!?…]/.test(word)) return true;
  const bare = word.toLowerCase().replace(/["'“”‘’«»()[\]]/g, "").replace(/\.+$/, "").replace(/\./g, "");
  if (ABBREVIATIONS.has(bare)) return false;
  if (/^[a-z]$/i.test(bare)) return false; // an initial: "J."
  return true;
}

const STOP: Record<Lang, Set<string>> = {
  en: new Set("a an the and or but of to in on at for with by is are was were be been it its this that i you we he she they me my our your his her their as so if not do does did have has had from up out about what which who just like can will would there then than um uh".split(" ")),
  es: new Set("el la los las un una unos unas y o pero de del a al en con por para es son fue era ser lo le les se que mi mis tu tus su sus nos me te yo tu el ella ellos nosotros como si no ya muy mas este esta esto ese esa eso hay eh".split(" ")),
};

/** Guess the script language from its common words. */
export function detectLang(text: string): Lang {
  const words = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-zñ]+/g) ?? [];
  let en = 0, es = 0;
  const EN = new Set(["the", "and", "is", "you", "that", "it", "of", "to", "with", "this", "are", "we"]);
  const ES = new Set(["el", "la", "que", "y", "de", "los", "las", "es", "con", "por", "para", "una", "no", "se"]);
  for (const w of words) { if (EN.has(w)) en++; if (ES.has(w)) es++; }
  return es > en ? "es" : "en";
}

/** Plain text or markdown in, words, sentences and spoken tokens out. */
export function parseScript(raw: string, lang: Lang = detectLang(raw)): ParsedScript {
  const paragraphs: Paragraph[] = [];
  const words: ScriptWord[] = [];
  const sentences: Sentence[] = [];
  let sentenceStart = 0;
  let current: Paragraph | null = null;

  const closeSentence = () => {
    if (words.length > sentenceStart) { sentences.push({ start: sentenceStart, end: words.length }); sentenceStart = words.length; }
  };
  const closeParagraph = () => {
    closeSentence();
    if (current && current.items.length) paragraphs.push(current);
    current = null;
  };
  const addWord = (text: string) => {
    if (!current) current = { note: false, items: [] };
    const i = words.length;
    words.push({ text, sentence: sentences.length, paragraph: paragraphs.length, tokens: normalizeToken(text, lang) });
    current.items.push({ type: "word", i });
    if (endsSentence(text)) closeSentence();
  };

  for (const line of scriptLines(raw)) {
    if (line.kind === "break") { closeParagraph(); continue; }
    if (line.kind === "note") {
      closeParagraph();
      paragraphs.push({ note: true, items: [{ type: "note", text: line.text }] });
      continue;
    }
    if (line.kind === "own") closeParagraph();
    // inline [notes] stay in the paragraph but are never words
    for (const part of line.text.split(/(\[[^\]]*\])/)) {
      if (!part) continue;
      if (/^\[[^\]]*\]$/.test(part)) {
        if (!current) current = { note: false, items: [] };
        current.items.push({ type: "note", text: part });
        continue;
      }
      for (const w of part.split(/\s+/)) {
        if (!w) continue;
        if (/[\p{L}\p{N}]/u.test(w)) { addWord(w); continue; }
        // a lone dash or symbol joins the previous word for display
        const p = current as Paragraph | null;
        const last = p?.items[p.items.length - 1];
        if (last?.type === "word") words[last.i].text += " " + w;
      }
    }
    if (line.kind === "own") closeParagraph();
  }
  closeParagraph();

  const tokens: Token[] = [];
  const wordToken: number[] = [];
  words.forEach((w, i) => {
    wordToken.push(tokens.length);
    for (const t of w.tokens) tokens.push({ t, w: i, stop: STOP[lang].has(t) });
  });
  return { lang, paragraphs, words, sentences, tokens, wordToken };
}

/** Every distinct spoken token, for constraining the recognizer to the script's vocabulary. */
export function scriptVocabulary(parsed: ParsedScript): string[] {
  return [...new Set(parsed.tokens.map((t) => t.t))];
}

// ---------------------------------------------------------------------------------------------
// Spoken forms: "96" is "ninety six", "$5" is "five dollars", "2024" is "twenty twenty four"
// ---------------------------------------------------------------------------------------------

const EN_ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const EN_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const EN_SCALES: [number, string][] = [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];

export function enNumber(n: number): string[] {
  if (n < 20) return [EN_ONES[n]];
  if (n < 100) return n % 10 ? [EN_TENS[Math.floor(n / 10)], EN_ONES[n % 10]] : [EN_TENS[n / 10]];
  if (n < 1000) return [EN_ONES[Math.floor(n / 100)], "hundred", ...(n % 100 ? enNumber(n % 100) : [])];
  for (const [value, name] of EN_SCALES) {
    if (n >= value) {
      const rest = n % value;
      return [...enNumber(Math.floor(n / value)), name, ...(rest ? enNumber(rest) : [])];
    }
  }
  return [String(n)];
}

/** How people read a four-digit year aloud. */
export function enYear(n: number): string[] {
  if (n >= 2000 && n < 2010) return enNumber(n);
  if (n % 100 === 0) return [...enNumber(n / 100), "hundred"];
  const hi = Math.floor(n / 100), lo = n % 100;
  return [...enNumber(hi), ...(lo < 10 ? ["oh", EN_ONES[lo]] : enNumber(lo))];
}

const EN_ORDINAL: Record<string, string> = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };
function enOrdinal(n: number): string[] {
  const words = enNumber(n);
  const last = words[words.length - 1];
  words[words.length - 1] = EN_ORDINAL[last] ?? (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th");
  return words;
}

const ES_UNITS = "cero uno dos tres cuatro cinco seis siete ocho nueve diez once doce trece catorce quince dieciseis diecisiete dieciocho diecinueve veinte veintiuno veintidos veintitres veinticuatro veinticinco veintiseis veintisiete veintiocho veintinueve".split(" ");
const ES_TENS = "_ _ _ treinta cuarenta cincuenta sesenta setenta ochenta noventa".split(" ");
const ES_HUNDREDS = "_ ciento doscientos trescientos cuatrocientos quinientos seiscientos setecientos ochocientos novecientos".split(" ");

/** Spanish cardinals (accents dropped, as the matcher compares without them). */
export function esNumber(n: number): string[] {
  if (n < 30) return [ES_UNITS[n]];
  if (n < 100) return n % 10 ? [ES_TENS[Math.floor(n / 10)], "y", ES_UNITS[n % 10]] : [ES_TENS[n / 10]];
  if (n === 100) return ["cien"];
  if (n < 1000) return [ES_HUNDREDS[Math.floor(n / 100)], ...(n % 100 ? esNumber(n % 100) : [])];
  const apocope = (w: string[]) => w.map((x, i) => (i === w.length - 1 && x === "uno" ? "un" : x === "veintiuno" && i === w.length - 1 ? "veintiun" : x));
  if (n < 1e6) {
    const k = Math.floor(n / 1000), rest = n % 1000;
    return [...(k === 1 ? [] : apocope(esNumber(k))), "mil", ...(rest ? esNumber(rest) : [])];
  }
  if (n < 1e12) {
    const m = Math.floor(n / 1e6), rest = n % 1e6;
    return [...(m === 1 ? ["un", "millon"] : [...apocope(esNumber(m)), "millones"]), ...(rest ? esNumber(rest) : [])];
  }
  return [String(n)];
}

const intWords = (n: number, lang: Lang) => (lang === "es" ? esNumber(n) : enNumber(n));
const digitWords = (digits: string, lang: Lang) => [...digits].map((d) => intWords(Number(d), lang)[0]);

/** A numeric string read aloud, in the script's convention for separators. */
function numberWords(s: string, lang: Lang): string[] | null {
  const thousands = lang === "es" ? "." : ",";
  const re = lang === "es" ? /^(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d+))?$/ : /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?$/;
  const m = s.match(re);
  if (!m) {
    // tolerate the other convention's decimal point ("3.5" in a Spanish script)
    const loose = s.match(/^(\d+)[.,](\d+)$/);
    if (!loose) return null;
    return [...intWords(Number(loose[1]), lang), lang === "es" ? "coma" : "point", ...digitWords(loose[2], lang)];
  }
  const intPart = m[1].split(thousands).join("");
  if (intPart.length > 13) return digitWords(intPart, lang);
  const n = Number(intPart);
  const isYear = lang === "en" && !m[2] && /^\d{4}$/.test(m[1]) && n >= 1100 && n < 2100;
  const head = isYear ? enYear(n) : intWords(n, lang);
  return m[2] ? [...head, lang === "es" ? "coma" : "point", ...digitWords(m[2], lang)] : head;
}

const CURRENCY: Record<string, Record<Lang, string>> = {
  $: { en: "dollars", es: "dolares" }, "€": { en: "euros", es: "euros" }, "£": { en: "pounds", es: "libras" },
};

/** A written word to the tokens a speaker says for it: lowercase, no accents, no punctuation. */
export function normalizeToken(raw: string, lang: Lang): string[] {
  let s = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[’‘`´]/g, "'");
  s = s.replace(/^[^\p{L}\p{N}$€£]+|[^\p{L}\p{N}%$€£]+$/gu, "");
  if (!s) return [];
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^([$€£])(\d[\d.,]*)$/))) {
    const n = numberWords(m[2], lang);
    if (n) return [...n, CURRENCY[m[1]][lang]];
  }
  if ((m = s.match(/^(\d[\d.,]*)([$€£])$/))) {
    const n = numberWords(m[1], lang);
    if (n) return [...n, CURRENCY[m[2]][lang]];
  }
  if ((m = s.match(/^(\d[\d.,]*)%$/))) {
    const n = numberWords(m[1], lang);
    if (n) return [...n, ...(lang === "es" ? ["por", "ciento"] : ["percent"])];
  }
  if (lang === "en" && (m = s.match(/^(\d+)(st|nd|rd|th)$/))) return enOrdinal(Number(m[1]));
  if ((m = s.match(/^(\d+)(o|a|º|ª)$/)) && lang === "es") return intWords(Number(m[1]), lang);
  if ((m = s.match(/^(\d{1,2}):(\d{2})$/))) {
    const min = Number(m[2]);
    const hour = intWords(Number(m[1]), lang);
    if (min === 0) return hour;
    if (lang === "es") return [...hour, "y", ...intWords(min, lang)];
    return [...hour, ...(min < 10 ? ["oh"] : []), ...intWords(min, lang)];
  }
  if (/^\d/.test(s)) {
    const n = numberWords(s, lang);
    if (n) return n;
  }
  const out: string[] = [];
  for (const part of s.split(/[-–—/_.,:;!?"()[\]{}«»“”+=*#]+/)) {
    if (!part) continue;
    if (part === "&") { out.push(lang === "es" ? "y" : "and"); continue; }
    // "3d", "mp4": letters and digits apart
    for (const piece of part.match(/\p{L}[\p{L}']*|\d+/gu) ?? []) {
      if (/^\d+$/.test(piece)) out.push(...(numberWords(piece, lang) ?? []));
      else {
        const word = piece.replace(/'/g, "");
        if (word) out.push(word);
      }
    }
  }
  return out;
}

/** Recognizer text to comparable tokens. */
export function normalizeHeard(text: string, lang: Lang): string[] {
  return text.split(/\s+/).filter((w) => w && w !== "[unk]").flatMap((w) => normalizeToken(w, lang));
}

// ---------------------------------------------------------------------------------------------
// Voice tracking: where in the script is the reader?
// ---------------------------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 0..1, how alike a heard token and a script token are. Short words must match exactly. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const len = Math.max(a.length, b.length);
  if (Math.min(a.length, b.length) < 4) return 0;
  const sim = 1 - levenshtein(a, b) / len;
  if (sim >= 0.75) return sim;
  // a shared stem of 5+ letters: "record" heard for "recording"
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  return short.length >= 5 && long.startsWith(short) ? 0.8 : 0;
}

export interface AlignOptions {
  /** heard tokens considered, newest last */
  tail: number;
  /** script tokens searched past the cursor */
  ahead: number;
  /** a jump forward this far (tokens) needs 3 matched words */
  bigJump: number;
  /** may the reader be moved back (a re-read)? */
  allowBack?: boolean;
}
export const ALIGN_DEFAULTS: AlignOptions = { tail: 10, ahead: 80, bigJump: 15 };

const MATCH_MIN = 0.75;

/** Earliest token the reader may be moved back to: the start of the sentence before the cursor. */
export function backLimit(parsed: ParsedScript, cursor: number): number {
  if (!parsed.tokens.length) return 0;
  const prevToken = Math.max(0, Math.min(cursor, parsed.tokens.length) - 1);
  const sentence = parsed.words[parsed.tokens[prevToken].w].sentence;
  return parsed.wordToken[parsed.sentences[sentence].start];
}

export interface AlignResult { cursor: number; matches: number; score: number }

/**
 * Local alignment of the newest heard tokens against the script near the cursor.
 * Returns the token after the last matched one, or null when the evidence is too thin.
 * Tolerates skipped script words, ad-libs, repeats and misread words; never moves the cursor
 * back past the start of the previous sentence, and moves back or far ahead only on 3+ matches.
 */
export function alignHeard(parsed: ParsedScript, heard: string[], cursor: number, opts: AlignOptions = ALIGN_DEFAULTS): AlignResult | null {
  const T = parsed.tokens;
  if (!T.length || !heard.length) return null;
  cursor = Math.max(0, Math.min(cursor, T.length));
  const H = heard.slice(-opts.tail);
  const lo = backLimit(parsed, cursor);
  const hi = Math.min(T.length, cursor + opts.ahead);
  const S = T.slice(lo, hi);
  const n = H.length, m = S.length;
  if (!m) return null;

  // D = score, M = matched words on the best path ending here
  const D: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  const M: Int32Array[] = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  const sims: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  let best: AlignResult & { adjusted: number } | null = null;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sim = similarity(H[i - 1], S[j - 1].t);
      sims[i][j] = sim;
      const hit = sim >= MATCH_MIN;
      const weight = S[j - 1].stop ? 1 : 2;
      const diag = D[i - 1][j - 1] + (hit ? weight * sim : -1);
      const up = D[i - 1][j] - 0.8; // a heard word that is not in the script (ad-lib, filler)
      const left = D[i][j - 1] - 0.6; // a script word the reader skipped
      let score = 0, matches = 0;
      if (diag > score) { score = diag; matches = M[i - 1][j - 1] + (hit ? 1 : 0); }
      if (up > score) { score = up; matches = M[i - 1][j]; }
      if (left > score) { score = left; matches = M[i][j - 1]; }
      D[i][j] = score;
      M[i][j] = matches;

      if (!hit || score <= 0) continue;
      const next = lo + j;
      const delta = next - cursor;
      const unmatchedTail = n - i;
      const adjusted = score - 0.5 * unmatchedTail - (delta >= 0 ? 0.02 * delta : 0.25 * -delta);
      const informative = !S[j - 1].stop && S[j - 1].t.length >= 3;
      let ok: boolean;
      // going back only when the newest words are the ones re-read (a dropped or new word is not a re-read)
      if (delta < 0 && (unmatchedTail > 0 || opts.allowBack === false)) ok = false;
      else if (matches >= 3) ok = true;
      else if (matches === 2) ok = delta >= 0 && delta <= opts.bigJump && score >= 2.5;
      else ok = informative && unmatchedTail === 0 && delta >= 1 && delta <= 3;
      if (!ok) continue;
      if (!best || adjusted > best.adjusted) best = { cursor: next, matches, score, adjusted };
    }
  }
  if (!best) return null;
  return { cursor: best.cursor, matches: best.matches, score: best.score };
}

export interface TrackerState {
  /** next script token the reader will say */
  cursor: number;
  /** tokens already final in the recognizer, newest last */
  committed: string[];
  partial: string[];
}

export const newTracker = (cursor = 0): TrackerState => ({ cursor, committed: [], partial: [] });

/** Feed a recognizer event; returns the new tracker state. */
export function trackHeard(parsed: ParsedScript, state: TrackerState, event: { partial?: string; final?: string }, opts: AlignOptions = ALIGN_DEFAULTS): TrackerState {
  let committed = state.committed;
  let partial = state.partial;
  if (event.final !== undefined) {
    committed = [...committed, ...normalizeHeard(event.final, parsed.lang)].slice(-opts.tail * 2);
    partial = [];
  } else if (event.partial !== undefined) {
    partial = normalizeHeard(event.partial, parsed.lang);
  }
  const heard = [...committed, ...partial];
  // a final that comes back shorter than its partials looks like a re-read: only partials move back
  const result = alignHeard(parsed, heard, state.cursor, { ...opts, allowBack: event.final === undefined });
  return { cursor: result ? result.cursor : state.cursor, committed, partial };
}

/** Token index to the word the reader is on (words.length at the end). */
export function tokenToWord(parsed: ParsedScript, token: number): number {
  return token >= parsed.tokens.length ? parsed.words.length : parsed.tokens[Math.max(0, token)].w;
}
/** Word index to its first token. */
export function wordToToken(parsed: ParsedScript, word: number): number {
  if (word >= parsed.words.length) return parsed.tokens.length;
  return parsed.wordToken[Math.max(0, Math.floor(word))];
}

// ---------------------------------------------------------------------------------------------
// Voice activity: is the reader talking? (voice-paced mode)
// ---------------------------------------------------------------------------------------------

export interface VadState { speaking: boolean; floor: number; above: number; below: number }
export interface VadOptions {
  /** dB over the noise floor that counts as speech */
  margin: number;
  /** ms of sound before scrolling starts */
  attack: number;
  /** ms of silence before scrolling pauses */
  release: number;
}
export const VAD_DEFAULTS: VadOptions = { margin: 12, attack: 90, release: 550 };
export const newVad = (): VadState => ({ speaking: false, floor: -60, above: 0, below: 0 });

/** One level reading (dBFS, about every 20-50 ms) through a hysteresis gate over an adaptive floor. */
export function vadStep(state: VadState, levelDb: number, dtMs: number, opts: VadOptions = VAD_DEFAULTS): VadState {
  const level = Math.max(-100, Number.isFinite(levelDb) ? levelDb : -100);
  // the floor drops quickly to quiet moments and rises only slowly (about 1.5 dB a second)
  let floor = level < state.floor ? state.floor + (level - state.floor) * Math.min(1, dtMs / 150) : state.floor + Math.min(level - state.floor, (1.5 * dtMs) / 1000);
  floor = Math.min(floor, -25);
  const threshold = Math.max(floor + opts.margin, -62);
  const loud = level > threshold;
  const above = loud ? state.above + dtMs : 0;
  const below = loud ? 0 : state.below + dtMs;
  let speaking = state.speaking;
  if (!speaking && above >= opts.attack) speaking = true;
  if (speaking && below >= opts.release) speaking = false;
  return { speaking, floor, above, below };
}

/** RMS of a sample block in dBFS. */
export function rmsDb(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

// ---------------------------------------------------------------------------------------------
// Pacing and scroll geometry
// ---------------------------------------------------------------------------------------------

/** Ease a velocity toward its target so starts and stops are smooth (tau in seconds). */
export function stepVelocity(v: number, target: number, dt: number, tau = 0.25): number {
  return v + (target - v) * (1 - Math.exp(-dt / tau));
}

/** Ease a position toward a target word (voice tracking): fast when far, gentle when close. */
export function easeToward(p: number, target: number, dt: number, tau = 0.35): number {
  const gap = target - p;
  if (Math.abs(gap) < 0.002) return target;
  // a long jump (a skipped paragraph) closes faster than a word or two
  const t = Math.abs(gap) > 12 ? tau / 2 : tau;
  return p + gap * (1 - Math.exp(-dt / t));
}

/** Words-per-minute velocity, in words per second. */
export const wordsPerSecond = (wpm: number) => wpm / 60;

export interface WordBox { top: number; height: number }

/**
 * Each word's y anchor for smooth scrolling: its line's top plus how far along the line it sits,
 * so a constant word rate becomes a constant pixel rate within a line.
 */
export function wordAnchors(boxes: WordBox[]): { y: number; h: number }[] {
  const out: { y: number; h: number }[] = new Array(boxes.length);
  let i = 0;
  while (i < boxes.length) {
    let j = i + 1;
    while (j < boxes.length && Math.abs(boxes[j].top - boxes[i].top) < Math.max(2, boxes[i].height * 0.3)) j++;
    const count = j - i;
    for (let k = i; k < j; k++) out[k] = { y: boxes[i].top + ((k - i) / count) * boxes[i].height, h: boxes[i].height };
    i = j;
  }
  return out;
}

/** Fractional word position to y (the anchor of the line the reader is on). */
export function positionToY(p: number, anchors: { y: number; h: number }[]): number {
  const n = anchors.length;
  if (!n) return 0;
  if (p <= 0) return anchors[0].y;
  if (p >= n - 1) {
    const last = anchors[n - 1];
    return last.y + Math.min(1, p - (n - 1)) * last.h;
  }
  const i = Math.floor(p), f = p - i;
  return anchors[i].y + (anchors[i + 1].y - anchors[i].y) * f;
}

/** Inverse of positionToY, for mouse-wheel scrolling. */
export function yToPosition(y: number, anchors: { y: number; h: number }[]): number {
  const n = anchors.length;
  if (!n) return 0;
  if (y <= anchors[0].y) return 0;
  const last = anchors[n - 1];
  if (y >= last.y) return Math.min(n, n - 1 + (y - last.y) / Math.max(1, last.h));
  let a = 0, b = n - 1;
  while (b - a > 1) { const mid = (a + b) >> 1; if (anchors[mid].y <= y) a = mid; else b = mid; }
  const span = anchors[b].y - anchors[a].y;
  return a + (span > 0 ? (y - anchors[a].y) / span : 0);
}

// ---------------------------------------------------------------------------------------------
// Sentences and commands
// ---------------------------------------------------------------------------------------------

export function sentenceAt(parsed: ParsedScript, word: number): number {
  if (!parsed.words.length) return 0;
  const w = Math.max(0, Math.min(parsed.words.length - 1, Math.floor(word)));
  return parsed.words[w].sentence;
}

/** Start of the next sentence after the reader's. */
export function nextSentenceStart(parsed: ParsedScript, word: number): number {
  if (!parsed.sentences.length) return 0;
  if (word >= parsed.words.length) return parsed.words.length;
  const s = sentenceAt(parsed, word);
  return s + 1 < parsed.sentences.length ? parsed.sentences[s + 1].start : parsed.words.length;
}

/** Start of the reader's sentence, or of the one before when already near its start. */
export function prevSentenceStart(parsed: ParsedScript, word: number): number {
  if (!parsed.sentences.length) return 0;
  const s = sentenceAt(parsed, Math.min(word, parsed.words.length - 1));
  const start = parsed.sentences[s].start;
  if (word - start > 1.5 || s === 0) return start;
  return parsed.sentences[s - 1].start;
}

export type PrompterCommand =
  | { type: "toggle" } | { type: "play" } | { type: "pause" }
  | { type: "faster" } | { type: "slower" }
  | { type: "next-sentence" } | { type: "prev-sentence" }
  | { type: "restart" } | { type: "seek"; word: number }
  | { type: "click-through" } | { type: "close" };

/** Prompter keys (no modifiers): the same map in the panel and in the prompter window. */
export function keyCommand(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): PrompterCommand | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  switch (e.key) {
    case " ": return { type: "toggle" };
    case "ArrowUp": return { type: "faster" };
    case "ArrowDown": return { type: "slower" };
    case "ArrowRight": return { type: "next-sentence" };
    case "ArrowLeft": return { type: "prev-sentence" };
    case "Home": return { type: "restart" };
    default: return null;
  }
}

export const WPM_MIN = 60, WPM_MAX = 300, WPM_STEP = 10;

/** Apply a transport command to the controller state. Window commands (click-through, close) pass through unchanged. */
export function reduceCommand(state: PrompterState, cmd: PrompterCommand, parsed: ParsedScript, now: number, countdownSec: number): PrompterState {
  const seek = (word: number): PrompterState => ({ ...state, position: word, target: word, seek: { word, nonce: state.seek.nonce + 1 } });
  switch (cmd.type) {
    case "play":
      if (state.playing) return state;
      return startPlaying(state, parsed, now, countdownSec);
    case "pause":
      return state.playing ? { ...state, playing: false, countdownUntil: 0 } : state;
    case "toggle":
      return state.playing ? { ...state, playing: false, countdownUntil: 0 } : startPlaying(state, parsed, now, countdownSec);
    case "faster":
      return { ...state, wpm: Math.min(WPM_MAX, state.wpm + WPM_STEP) };
    case "slower":
      return { ...state, wpm: Math.max(WPM_MIN, state.wpm - WPM_STEP) };
    case "next-sentence":
      return seek(nextSentenceStart(parsed, state.position));
    case "prev-sentence":
      return seek(prevSentenceStart(parsed, state.position));
    case "restart":
      return { ...seek(0), playing: false, countdownUntil: 0 };
    case "seek":
      return seek(Math.max(0, Math.min(parsed.words.length, Math.floor(cmd.word))));
    default:
      return state;
  }
}

function startPlaying(state: PrompterState, parsed: ParsedScript, now: number, countdownSec: number): PrompterState {
  // pressing play at the end starts over
  const atEnd = parsed.words.length > 0 && state.position >= parsed.words.length;
  const base: PrompterState = atEnd ? { ...state, position: 0, target: 0, seek: { word: 0, nonce: state.seek.nonce + 1 } } : state;
  return { ...base, playing: true, countdownUntil: countdownSec > 0 ? now + countdownSec * 1000 : 0 };
}

/** Reading time of the script at a pace. */
export function readingSeconds(parsed: ParsedScript, wpm: number): number {
  return Math.round((parsed.words.length / Math.max(1, wpm)) * 60);
}

export const DEFAULT_STATE: PrompterState = {
  script: "",
  playing: false,
  wpm: 140,
  fontSize: 56,
  mirrored: false,
  position: 0,
  mode: "manual",
  lineWidth: 80,
  guide: 0.33,
  showNotes: true,
  countdownUntil: 0,
  seek: { word: 0, nonce: 0 },
  speaking: false,
  target: 0,
  lang: "en",
};
