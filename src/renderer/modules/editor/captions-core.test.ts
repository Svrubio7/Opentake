import { describe, expect, it } from "vitest";
import type { CaptionLine, CaptionWord } from "@shared/types";
import {
  activeLine, assColor, balanceRows, fromVosk, groupWords, lineText, mergeWithNext, parseCaptions, remapLines, retext, setLineEdge,
  shiftLine, socialChunks, splitLine, toAss, toSrt, toVtt, wordIndexAtCaret, wrapRows,
} from "./captions-core";

/** Words 300 ms long with 50 ms between them, starting at `at`. */
const say = (text: string, at = 0, gap = 50): CaptionWord[] =>
  text.split(" ").map((t, i) => ({ text: t, start: at + i * (300 + gap), end: at + i * (300 + gap) + 300 }));

describe("grouping words into lines", () => {
  it("cleans Vosk words: seconds to ms, [unk] dropped, sentence capitals and I", () => {
    const w = fromVosk([{ word: "hello", start: 0.5, end: 0.9 }, { word: "[unk]", start: 1, end: 1.1 }, { word: "i'm", start: 1.2, end: 1.4 }, { word: "back", start: 3, end: 3.4 }], "en");
    expect(w.map((x) => x.text)).toEqual(["Hello", "I'm", "Back"]);
    expect(w[0]).toEqual({ text: "Hello", start: 500, end: 900 });
  });
  it("breaks on a pause", () => {
    const words = [...say("one two three"), ...say("four five", 2000)];
    const lines = groupWords(words, "en");
    expect(lines.map(lineText)).toEqual(["One two three", "Four five"]);
  });
  it("keeps every line within two rows of 32 characters", () => {
    const words = say("this is a fairly long sentence that keeps going and going without any pause at all so it has to break somewhere sensible");
    const lines = groupWords(words, "en");
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(wrapRows(lineText(l), 32).length).toBeLessThanOrEqual(2);
    // every word survives, in order
    expect(lines.map(lineText).join(" ").toLowerCase()).toBe(words.map((w) => w.text).join(" "));
  });
  it("does not end a forced break on a leaning word", () => {
    const words = say("we built the whole thing in a weekend and then we shipped it to the people who asked for it");
    for (const l of groupWords(words, "en", { maxChars: 20, rows: 1, pauseMs: 600, minMs: 900, maxMs: 6000 }).slice(0, -1)) {
      expect(["the", "a", "and", "to", "in", "for", "who"]).not.toContain(l.words[l.words.length - 1].text);
    }
  });
  it("caps a line's length in time and holds short lines long enough to read", () => {
    const slow = say("uno dos tres cuatro cinco seis siete ocho nueve diez", 0, 600).map((w, i) => ({ ...w, start: i * 550, end: i * 550 + 500 }));
    const lines = groupWords(slow, "es", { maxChars: 60, rows: 2, pauseMs: 600, minMs: 900, maxMs: 2500 });
    for (const l of lines) expect(l.words[l.words.length - 1].end - l.words[0].start).toBeLessThanOrEqual(2500);
    const one = groupWords([{ text: "Hi", start: 0, end: 200 }], "en");
    expect(one[0].end).toBe(900);
  });
  it("balances two rows", () => {
    expect(balanceRows("one two three four five six seven eight nine", 32)).toEqual(["one two three four five", "six seven eight nine"]);
  });
});

describe("editing lines", () => {
  const line: CaptionLine = { id: "a", start: 0, end: 1000, words: [{ text: "helo", start: 0, end: 400 }, { text: "world", start: 500, end: 1000 }] };
  it("fixes a word and keeps the timing", () => {
    const r = retext(line, "hello world");
    expect(r.words[0]).toEqual({ text: "hello", start: 0, end: 400 });
  });
  it("shares out the time when the word count changes", () => {
    const r = retext(line, "hello there world");
    expect(r.words).toHaveLength(3);
    expect(r.words[0].start).toBe(0);
    expect(r.words[2].end).toBe(1000);
  });
  it("merges, splits and shifts", () => {
    const lines: CaptionLine[] = [line, { id: "b", start: 1200, end: 2000, words: [{ text: "again", start: 1200, end: 2000 }] }];
    const m = mergeWithNext(lines, 0);
    expect(m).toHaveLength(1);
    expect(lineText(m[0])).toBe("helo world again");
    expect(m[0].end).toBe(2000);
    const s = splitLine(m, 0, 2);
    expect(s.map(lineText)).toEqual(["helo world", "again"]);
    expect(s[0].end).toBe(1000);
    expect(shiftLine(line, -500).start).toBe(0); // never before 0
    expect(shiftLine(line, 250).words[1].start).toBe(750);
    expect(setLineEdge(line, "end", 700).words[1].end).toBe(700);
    expect(wordIndexAtCaret("hello big world", 6)).toBe(1);
    expect(wordIndexAtCaret("hello big world", 7)).toBe(2);
    expect(activeLine(lines, 1500)).toBe(1);
    expect(activeLine(lines, 1100)).toBe(-1);
  });
});

describe("captions follow the cuts", () => {
  it("drops cut words, moves the rest, and never overlaps", () => {
    const lines = groupWords([...say("keep these words"), ...say("cut this part", 4000), ...say("and the end", 8000)], "en");
    const keep = [{ start: 0, end: 3000 }, { start: 7000, end: 10000 }];
    const r = remapLines(lines, keep);
    expect(r.map(lineText)).toEqual(["Keep these words", "And the end"]);
    expect(r[1].start).toBe(3000 + 1000); // 8000 - 7000 + 3000
    for (let i = 0; i < r.length - 1; i++) expect(r[i].end).toBeLessThanOrEqual(r[i + 1].start);
  });
  it("keeps half a line when the cut runs through it", () => {
    const lines: CaptionLine[] = [{ id: "a", start: 0, end: 2000, words: say("one two three four five six") }];
    const r = remapLines(lines, [{ start: 0, end: 1000 }]);
    expect(lineText(r[0])).toBe("one two three");
    expect(r[0].end).toBeLessThanOrEqual(1000);
  });
});

describe("caption files", () => {
  const lines: CaptionLine[] = [{ id: "a", start: 1500, end: 3250, words: say("hello there", 1500) }, { id: "b", start: 3661001, end: 3662000, words: [{ text: "late", start: 3661001, end: 3662000 }] }];
  it("writes SRT", () => {
    expect(toSrt(lines)).toBe("1\n00:00:01,500 --> 00:00:03,250\nhello there\n\n2\n01:01:01,001 --> 01:01:02,000\nlate\n");
  });
  it("writes VTT", () => {
    expect(toVtt(lines).startsWith("WEBVTT\n\n00:00:01.500 --> 00:00:03.250\nhello there\n")).toBe(true);
  });
  it("writes an ASS script for each style", () => {
    expect(assColor("#FFD60A")).toBe("&H000AD6FF");
    const clean = toAss(lines, { style: "clean", position: "bottom", margin: 0.08 }, 1920, 1080);
    expect(clean).toContain("PlayResX: 1920");
    expect(clean).toContain("Dialogue: 0,0:00:01.50,0:00:03.25,Default,,0,0,0,,hello there");
    expect(clean).toMatch(/Style: Default,Geist,54,.*,1,\d+,\d+,2,115,115,86,1/);
    const top = toAss(lines, { style: "boxed", position: "top", margin: 0.05 }, 1080, 1920);
    expect(top).toMatch(/,3,\d+,0,8,/); // opaque box, top centre
    const social = toAss(lines, { style: "social", position: "bottom", margin: 0.2 }, 1080, 1920);
    // one event per word, the spoken word highlighted
    expect(social.match(/^Dialogue/gm)).toHaveLength(3);
    expect(social).toContain("{\\c&H0AD6FF&}HELLO{\\c&HFFFFFF&} THERE");
  });
  it("chunks social captions to a few words", () => {
    const c = socialChunks([{ id: "a", start: 0, end: 3000, words: say("one two three four five six seven") }]);
    expect(c.map(lineText)).toEqual(["one two three", "four five six", "seven"]);
  });
  it("parses saved captions", () => {
    expect(parseCaptions({ version: 1, lang: "es", lines: [{ id: "x", start: 0, end: 1, words: [{ text: "hola", start: 0, end: 1 }] }, { nope: 1 }] })?.lines).toHaveLength(1);
    expect(parseCaptions({ version: 3 })).toBeNull();
  });
});

describe("capitals", () => {
  it("starts a line after a pause with a capital, not a line broken for length", () => {
    const words = [...say("first we record"), ...say("then we cut it", 2000)];
    expect(groupWords(words, "en").map(lineText)).toEqual(["First we record", "Then we cut it"]);
    const long = groupWords(say("one two three four five six seven eight nine ten eleven twelve"), "en", { maxChars: 16, rows: 1, pauseMs: 600, minMs: 900, maxMs: 6000 });
    expect(long[0].words[0].text).toBe("One");
    expect(long[1].words[0].text).toMatch(/^[a-z]/);
  });
});
