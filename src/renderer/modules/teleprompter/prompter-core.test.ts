import { describe, expect, it } from "vitest";
import {
  alignHeard, ALIGN_DEFAULTS, DEFAULT_STATE, detectLang, easeToward, endsSentence, enNumber, enYear, esNumber, isNoteLine,
  newTracker, newVad, nextSentenceStart, normalizeHeard, normalizeToken, parseScript, positionToY, prevSentenceStart,
  readingSeconds, reduceCommand, rmsDb, scriptVocabulary, similarity, stepVelocity, tokenToWord, trackHeard, vadStep,
  wordAnchors, wordToToken, yToPosition, type ParsedScript, type TrackerState,
} from "./prompter-core";

/** Speak a string through the tracker word by word, like a recognizer's growing partials. */
function speak(parsed: ParsedScript, text: string, start: TrackerState = newTracker()): TrackerState {
  let state = start;
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 1; i <= words.length; i++) state = trackHeard(parsed, state, { partial: words.slice(0, i).join(" ") });
  return trackHeard(parsed, state, { final: text });
}
const wordAt = (parsed: ParsedScript, s: TrackerState) => tokenToWord(parsed, s.cursor);
const texts = (parsed: ParsedScript) => parsed.words.map((w) => w.text);

const SCRIPT = [
  "Most people record a video ten times before they get it right.",
  "That is not a talent problem. It is a reading problem.",
  "Today I will show you how a teleprompter fixes it in five minutes.",
  "First, write the script. Second, read it once out loud. Third, record.",
].join(" ");

describe("parseScript", () => {
  it("splits words, sentences and paragraphs", () => {
    const p = parseScript("Hello there. How are you?\n\nNew paragraph here.", "en");
    expect(texts(p)).toEqual(["Hello", "there.", "How", "are", "you?", "New", "paragraph", "here."]);
    expect(p.sentences).toEqual([{ start: 0, end: 2 }, { start: 2, end: 5 }, { start: 5, end: 8 }]);
    expect(p.paragraphs).toHaveLength(2);
    expect(p.words[5].paragraph).toBe(1);
  });

  it("joins hard-wrapped lines into one paragraph", () => {
    const p = parseScript("This line wraps\nonto the next one.", "en");
    expect(p.paragraphs).toHaveLength(1);
    expect(p.sentences).toHaveLength(1);
  });

  it("does not end sentences on abbreviations or initials", () => {
    expect(endsSentence("Dr.")).toBe(false);
    expect(endsSentence("e.g.")).toBe(false);
    expect(endsSentence("J.")).toBe(false);
    expect(endsSentence("done.")).toBe(true);
    expect(endsSentence('"right?"')).toBe(true);
    expect(endsSentence("wait…")).toBe(true);
  });

  it("strips markdown and keeps headings and list items as their own sentences", () => {
    const md = "---\ntitle: x\n---\n# The **hook**\n\nThis is _really_ [a link](https://x.com) and `code`.\n\n- first item\n- second item\n\n```\nfenced text\n```";
    const p = parseScript(md, "en");
    expect(texts(p)).toEqual(["The", "hook", "This", "is", "really", "a", "link", "and", "code.", "first", "item", "second", "item", "fenced", "text"]);
    expect(p.sentences.map((s) => texts(p).slice(s.start, s.end).join(" "))).toEqual([
      "The hook", "This is really a link and code.", "first item", "second item", "fenced text",
    ]);
  });

  it("treats VISUAL: lines and bracketed lines as notes, never words", () => {
    expect(isNoteLine("VISUAL: cut to the dashboard")).toBe(true);
    expect(isNoteLine("[smile, pause]")).toBe(true);
    expect(isNoteLine("Visually it works")).toBe(false);
    const p = parseScript("Say this.\nVISUAL: b-roll of the app\n[pause]\nThen this [point at screen] and done.", "en");
    expect(texts(p)).toEqual(["Say", "this.", "Then", "this", "and", "done."]);
    const notes = p.paragraphs.flatMap((pa) => pa.items.filter((i) => i.type === "note").map((i) => (i as { text: string }).text));
    expect(notes).toEqual(["VISUAL: b-roll of the app", "[pause]", "[point at screen]"]);
    expect(p.paragraphs.filter((pa) => pa.note)).toHaveLength(2);
  });

  it("attaches a lone dash to the word before", () => {
    const p = parseScript("Fast - really fast.", "en");
    expect(texts(p)).toEqual(["Fast -", "really", "fast."]);
  });

  it("maps words and tokens both ways", () => {
    const p = parseScript("I have 96 videos.", "en");
    expect(p.tokens.map((t) => t.t)).toEqual(["i", "have", "ninety", "six", "videos"]);
    expect(wordToToken(p, 3)).toBe(4);
    expect(tokenToWord(p, 3)).toBe(2);
    expect(tokenToWord(p, 99)).toBe(4);
    expect(scriptVocabulary(parseScript("the cat and the dog", "en"))).toEqual(["the", "cat", "and", "dog"]);
  });

  it("detects Spanish scripts", () => {
    expect(detectLang("Hoy te voy a enseñar cómo grabar un vídeo con el guion y la cámara.")).toBe("es");
    expect(detectLang("Today I will show you how to record a video with the script.")).toBe("en");
  });
});

describe("spoken forms", () => {
  it("reads English numbers", () => {
    expect(enNumber(96)).toEqual(["ninety", "six"]);
    expect(enNumber(115)).toEqual(["one", "hundred", "fifteen"]);
    expect(enNumber(2500000)).toEqual(["two", "million", "five", "hundred", "thousand"]);
    expect(enYear(1999)).toEqual(["nineteen", "ninety", "nine"]);
    expect(enYear(2024)).toEqual(["twenty", "twenty", "four"]);
    expect(enYear(2007)).toEqual(["two", "thousand", "seven"]);
    expect(enYear(1905)).toEqual(["nineteen", "oh", "five"]);
  });

  it("reads Spanish numbers", () => {
    expect(esNumber(96)).toEqual(["noventa", "y", "seis"]);
    expect(esNumber(21)).toEqual(["veintiuno"]);
    expect(esNumber(100)).toEqual(["cien"]);
    expect(esNumber(150)).toEqual(["ciento", "cincuenta"]);
    expect(esNumber(2024)).toEqual(["dos", "mil", "veinticuatro"]);
    expect(esNumber(21000)).toEqual(["veintiun", "mil"]);
    expect(esNumber(1000000)).toEqual(["un", "millon"]);
  });

  it("normalises numbers, money, percents, ordinals and punctuation", () => {
    expect(normalizeToken("96", "en")).toEqual(["ninety", "six"]);
    expect(normalizeToken("1,500", "en")).toEqual(["one", "thousand", "five", "hundred"]);
    expect(normalizeToken("3.5", "en")).toEqual(["three", "point", "five"]);
    expect(normalizeToken("$20", "en")).toEqual(["twenty", "dollars"]);
    expect(normalizeToken("50%", "en")).toEqual(["fifty", "percent"]);
    expect(normalizeToken("21st", "en")).toEqual(["twenty", "first"]);
    expect(normalizeToken("10:30", "en")).toEqual(["ten", "thirty"]);
    expect(normalizeToken("(Don't!", "en")).toEqual(["dont"]);
    expect(normalizeToken("ninety-six", "en")).toEqual(["ninety", "six"]);
    expect(normalizeToken("1.500", "es")).toEqual(["mil", "quinientos"]);
    expect(normalizeToken("3,5", "es")).toEqual(["tres", "coma", "cinco"]);
    expect(normalizeToken("20€", "es")).toEqual(["veinte", "euros"]);
    expect(normalizeToken("¿Cómo?", "es")).toEqual(["como"]);
    expect(normalizeToken("—", "en")).toEqual([]);
  });

  it("normalises recognizer output the same way", () => {
    expect(normalizeHeard("i have [unk] ninety six videos", "en")).toEqual(["i", "have", "ninety", "six", "videos"]);
  });

  it("scores near words, refuses short mismatches", () => {
    expect(similarity("recording", "recording")).toBe(1);
    expect(similarity("recordings", "recording")).toBeGreaterThan(0.75);
    expect(similarity("record", "recording")).toBeGreaterThanOrEqual(0.75);
    expect(similarity("the", "they")).toBe(0);
    expect(similarity("cat", "hat")).toBe(0);
    expect(similarity("teleprompter", "dashboard")).toBe(0);
  });
});

describe("voice tracking", () => {
  const p = parseScript(SCRIPT, "en");
  const idx = (word: string, from = 0) => texts(p).findIndex((w, i) => i >= from && w.replace(/[^\w]/g, "").toLowerCase() === word);

  it("follows a straight read word by word", () => {
    const s = speak(p, "most people record a video ten times before they get it right");
    expect(wordAt(p, s)).toBe(idx("that"));
  });

  it("advances on the first informative words of a sentence", () => {
    const s = speak(p, "most people");
    expect(wordAt(p, s)).toBe(2);
  });

  it("does not move on a lone common word", () => {
    const s = speak(p, "the");
    expect(s.cursor).toBe(0);
  });

  it("tolerates ad-libs in the middle", () => {
    const s = speak(p, "most people um you know honestly record a video ten times");
    expect(wordAt(p, s)).toBe(idx("before"));
  });

  it("tolerates misread words", () => {
    const s = speak(p, "most people recorded a videos ten time before they get it right");
    expect(wordAt(p, s)).toBe(idx("that"));
  });

  it("follows a skipped sentence", () => {
    let s = speak(p, "most people record a video ten times before they get it right");
    s = speak(p, "it is a reading problem", s); // skipped "That is not a talent problem."
    expect(wordAt(p, s)).toBe(idx("today"));
  });

  it("follows skipped words inside a sentence", () => {
    const s = speak(p, "most people record ten times before they get it right");
    expect(wordAt(p, s)).toBe(idx("that"));
  });

  it("stays put when the reader repeats a phrase", () => {
    let s = speak(p, "most people record a video ten times");
    const before = s.cursor;
    s = speak(p, "ten times", s);
    expect(s.cursor).toBe(before);
    s = speak(p, "ten times before they", s);
    expect(wordAt(p, s)).toBe(idx("get"));
  });

  it("goes back within the sentence when the reader restarts it", () => {
    let s = speak(p, "today i will show you how a teleprompter fixes it");
    const ahead = s.cursor;
    s = speak(p, "today i will show you", s);
    expect(s.cursor).toBeLessThan(ahead);
    expect(wordAt(p, s)).toBe(idx("how", idx("today")));
  });

  it("does not slide back when the recognizer's final drops words it showed as partials", () => {
    // seen live: partials reached "... fixes it in five minutes", the final came back shorter,
    // then a new utterance started with an unmatched word
    let s = trackHeard(p, newTracker(wordToToken(p, idx("today"))), { partial: "today i will show you how a teleprompter fixes it in five minutes" });
    const end = s.cursor;
    expect(tokenToWord(p, end)).toBe(idx("first"));
    s = trackHeard(p, s, { final: "how a teleprompter fixes" });
    expect(s.cursor).toBe(end);
    s = trackHeard(p, s, { partial: "minutes" });
    expect(s.cursor).toBe(end);
  });

  it("never jumps back more than a sentence", () => {
    // reader is in the last sentence; the first sentence is said again
    const start = newTracker(wordToToken(p, idx("second")));
    const s = speak(p, "most people record a video ten times before they get it right", start);
    expect(s.cursor).toBeGreaterThanOrEqual(start.cursor - 20);
    expect(wordAt(p, s)).toBeGreaterThanOrEqual(idx("first"));
  });

  it("matches numbers written as digits", () => {
    const q = parseScript("We tested 96 videos in 2024 and kept 3.", "en");
    const s = speak(q, "we tested ninety six videos in twenty twenty four and kept three");
    expect(tokenToWord(q, s.cursor)).toBe(q.words.length);
  });

  it("matches digits heard for spelled numbers", () => {
    const q = parseScript("We tested ninety-six videos last week.", "en");
    const s = speak(q, "we tested 96 videos");
    expect(tokenToWord(q, s.cursor)).toBe(4);
  });

  it("ignores a long ad-lib, then picks up again", () => {
    let s = speak(p, "most people record a video ten times");
    const before = s.cursor;
    s = speak(p, "and honestly i used to be one of them it was terrible every single day", s);
    expect(s.cursor - before).toBeLessThanOrEqual(3);
    s = speak(p, "before they get it right", s);
    expect(wordAt(p, s)).toBe(idx("that"));
  });

  it("needs strong evidence to jump far ahead", () => {
    // two common-ish words that also appear far ahead do not drag the reader there
    const s0 = newTracker();
    const r = alignHeard(p, normalizeHeard("five minutes", "en"), s0.cursor, ALIGN_DEFAULTS);
    expect(r).toBeNull();
    const r2 = alignHeard(p, normalizeHeard("how a teleprompter fixes it in five minutes", "en"), s0.cursor, { ...ALIGN_DEFAULTS, ahead: 200 });
    expect(r2 && tokenToWord(p, r2.cursor)).toBe(idx("first"));
  });

  it("follows a Spanish read with numbers", () => {
    const q = parseScript("Grabé 21 vídeos en una semana. Ahora te enseño cómo.", "es");
    let s = speak(q, "grabe veintiuno videos en una semana");
    expect(tokenToWord(q, s.cursor)).toBe(6);
    s = speak(q, "ahora te enseño como", s);
    expect(tokenToWord(q, s.cursor)).toBe(q.words.length);
  });

  it("handles an empty script and empty speech", () => {
    const e = parseScript("", "en");
    expect(speak(e, "hello there").cursor).toBe(0);
    expect(alignHeard(p, [], 0)).toBeNull();
  });
});

describe("voice activity", () => {
  const run = (levels: number[], step = 30) => {
    let s = newVad();
    const out: boolean[] = [];
    for (const l of levels) { s = vadStep(s, l, step); out.push(s.speaking); }
    return { s, out };
  };

  it("starts after the attack and stops after the release", () => {
    const quiet = Array(40).fill(-70);
    const loud = Array(20).fill(-25);
    const { out } = run([...quiet, ...loud, ...quiet]);
    expect(out[39]).toBe(false);
    expect(out[40]).toBe(false); // one frame is not speech yet
    expect(out[45]).toBe(true);
    expect(out[60]).toBe(true); // short pause keeps scrolling
    expect(out[60 + 25]).toBe(false);
  });

  it("ignores a single click", () => {
    const { out } = run([...Array(30).fill(-70), -20, ...Array(30).fill(-70)]);
    expect(out.some(Boolean)).toBe(false);
  });

  it("adapts to a noisy room", () => {
    const { s } = run(Array(400).fill(-45));
    expect(s.speaking).toBe(false);
    expect(s.floor).toBeGreaterThan(-50);
    const after = run([...Array(400).fill(-45), ...Array(10).fill(-25)]);
    expect(after.s.speaking).toBe(true);
  });

  it("measures dBFS", () => {
    expect(rmsDb(new Float32Array(128).fill(1))).toBeCloseTo(0, 5);
    expect(rmsDb(new Float32Array(128).fill(0.1))).toBeCloseTo(-20, 3);
    expect(rmsDb(new Float32Array(128))).toBe(-100);
  });
});

describe("pacing and geometry", () => {
  it("eases velocity and position", () => {
    expect(stepVelocity(0, 2, 10)).toBeCloseTo(2, 3);
    expect(stepVelocity(0, 2, 0.05)).toBeGreaterThan(0);
    expect(stepVelocity(0, 2, 0.05)).toBeLessThan(1);
    expect(easeToward(10, 10.001, 0.016)).toBe(10.001);
    const near = easeToward(0, 2, 0.1) / 2;
    const far = easeToward(0, 40, 0.1) / 40;
    expect(far).toBeGreaterThan(near);
  });

  const boxes = [
    { top: 0, height: 60 }, { top: 0, height: 60 }, { top: 0, height: 60 }, { top: 0, height: 60 },
    { top: 60, height: 60 }, { top: 60, height: 60 },
    { top: 200, height: 60 },
  ];
  const anchors = wordAnchors(boxes);

  it("spreads words along their line", () => {
    expect(anchors.map((a) => a.y)).toEqual([0, 15, 30, 45, 60, 90, 200]);
  });

  it("maps positions to y and back", () => {
    expect(positionToY(0, anchors)).toBe(0);
    expect(positionToY(1.5, anchors)).toBe(22.5);
    expect(positionToY(5.5, anchors)).toBe(145);
    expect(positionToY(7, anchors)).toBe(260);
    expect(positionToY(-3, anchors)).toBe(0);
    for (const pos of [0, 0.25, 2, 3.7, 4.5, 5.9, 6.5]) expect(yToPosition(positionToY(pos, anchors), anchors)).toBeCloseTo(pos, 6);
  });

  it("estimates reading time", () => {
    expect(readingSeconds(parseScript("one two three four five six", "en"), 120)).toBe(3);
  });
});

describe("commands", () => {
  const p = parseScript(SCRIPT, "en");
  const state = { ...DEFAULT_STATE, script: SCRIPT };

  it("plays with a countdown and pauses", () => {
    const playing = reduceCommand(state, { type: "toggle" }, p, 1000, 3);
    expect(playing.playing).toBe(true);
    expect(playing.countdownUntil).toBe(4000);
    const paused = reduceCommand(playing, { type: "toggle" }, p, 2000, 3);
    expect(paused.playing).toBe(false);
    expect(paused.countdownUntil).toBe(0);
    expect(reduceCommand(state, { type: "play" }, p, 0, 0).countdownUntil).toBe(0);
  });

  it("restarts from the top when played at the end", () => {
    const end = { ...state, position: p.words.length };
    const next = reduceCommand(end, { type: "play" }, p, 0, 0);
    expect(next.position).toBe(0);
    expect(next.seek.nonce).toBe(1);
  });

  it("changes speed within bounds", () => {
    expect(reduceCommand(state, { type: "faster" }, p, 0, 0).wpm).toBe(150);
    expect(reduceCommand({ ...state, wpm: 60 }, { type: "slower" }, p, 0, 0).wpm).toBe(60);
    expect(reduceCommand({ ...state, wpm: 300 }, { type: "faster" }, p, 0, 0).wpm).toBe(300);
  });

  it("jumps by sentence", () => {
    const s1 = reduceCommand(state, { type: "next-sentence" }, p, 0, 0);
    expect(s1.seek).toEqual({ word: p.sentences[1].start, nonce: 1 });
    expect(s1.target).toBe(p.sentences[1].start);
    const mid = { ...state, position: p.sentences[2].start + 3 };
    expect(reduceCommand(mid, { type: "prev-sentence" }, p, 0, 0).seek.word).toBe(p.sentences[2].start);
    const atStart = { ...state, position: p.sentences[2].start };
    expect(reduceCommand(atStart, { type: "prev-sentence" }, p, 0, 0).seek.word).toBe(p.sentences[1].start);
    expect(nextSentenceStart(p, p.words.length)).toBe(p.words.length);
    expect(prevSentenceStart(p, 0)).toBe(0);
  });

  it("restarts and seeks", () => {
    const r = reduceCommand({ ...state, playing: true, position: 20 }, { type: "restart" }, p, 0, 0);
    expect(r.playing).toBe(false);
    expect(r.seek.word).toBe(0);
    expect(reduceCommand(state, { type: "seek", word: 9999 }, p, 0, 0).seek.word).toBe(p.words.length);
  });
});
