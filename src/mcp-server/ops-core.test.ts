import { describe, expect, it } from "vitest";
import type { CaptionLine } from "../shared/types";
import {
  applyCaptionOps, clickBursts, fillerCuts, findFillers, intersectRanges, parseSilences, rangeFromSeconds, silenceCuts, silenceFilter,
  subtractRanges, transcriptText,
} from "./ops-core";

const line = (id: string, words: [string, number, number][]): CaptionLine => ({ id, start: words[0][1], end: words[words.length - 1][2], words: words.map(([text, start, end]) => ({ text, start, end })) });

describe("cuts", () => {
  it("takes ranges out of the kept stretches", () => {
    expect(subtractRanges([{ start: 0, end: 10_000 }], [{ start: 2000, end: 3000 }, { start: 9000, end: 12_000 }], 10_000)).toEqual([{ start: 0, end: 2000 }, { start: 3000, end: 9000 }]);
    // a cut across a split takes from both sides
    expect(subtractRanges([{ start: 0, end: 5000 }, { start: 5000, end: 10_000 }], [{ start: 4000, end: 6000 }], 10_000)).toEqual([{ start: 0, end: 4000 }, { start: 6000, end: 10_000 }]);
    // slivers do not survive
    expect(subtractRanges([{ start: 0, end: 1000 }], [{ start: 10, end: 1000 }], 1000)).toEqual([]);
  });

  it("keeps only what is asked for, inside what was kept", () => {
    expect(intersectRanges([{ start: 0, end: 4000 }, { start: 6000, end: 10_000 }], [{ start: 3000, end: 7000 }], 10_000)).toEqual([{ start: 3000, end: 4000 }, { start: 6000, end: 7000 }]);
  });

  it("reads seconds and refuses empty or outside ranges", () => {
    expect(rangeFromSeconds({ start: 1.5, end: 99 }, 10_000)).toEqual({ start: 1500, end: 10_000 });
    expect(() => rangeFromSeconds({ start: 12, end: 15 }, 10_000)).toThrow(/outside the take/);
  });
});

describe("silence", () => {
  const stderr = [
    "[silencedetect @ 0x1] silence_start: 1.2",
    "[silencedetect @ 0x1] silence_end: 3.5 | silence_duration: 2.3",
    "[silencedetect @ 0x1] silence_start: -0.01",
    "[silencedetect @ 0x1] silence_end: 0.4 | silence_duration: 0.41",
    "[silencedetect @ 0x1] silence_start: 8.75",
  ].join("\n");

  it("parses silencedetect, an open silence runs to the end", () => {
    expect(parseSilences(stderr, 10_000)).toEqual([{ start: 1200, end: 3500 }, { start: 0, end: 400 }, { start: 8750, end: 10_000 }]);
  });

  it("cuts long silences but leaves a short pause", () => {
    expect(silenceCuts([{ start: 1200, end: 3500 }, { start: 5000, end: 5300 }], { minMs: 700, keepMs: 300 })).toEqual([{ start: 1350, end: 3350 }]);
  });

  it("builds a bounded filter", () => {
    expect(silenceFilter(-35, 700)).toBe("silencedetect=noise=-35dB:d=0.70");
    expect(silenceFilter(-200, 10)).toBe("silencedetect=noise=-90dB:d=0.10");
  });
});

describe("fillers", () => {
  const en = [line("a", [["So", 0, 200], ["um", 300, 500], ["this", 700, 900], ["is,", 900, 1000], ["uh", 1100, 1300]]), line("b", [["you", 2000, 2100], ["know", 2100, 2300], ["what", 2400, 2600]])];

  it("finds sure fillers and leaves real words alone", () => {
    expect(findFillers(en, "en").map((f) => f.text)).toEqual(["um", "uh"]);
    expect(findFillers(en, "en", { maybe: true }).map((f) => [f.text, f.sure])).toEqual([["So", false], ["um", true], ["uh", true], ["you know", false]]);
    expect(findFillers(en, "en", { extra: ["THIS"] }).map((f) => f.text)).toEqual(["um", "this", "uh"]);
  });

  it("only takes Spanish 'este' when it is not part of a phrase", () => {
    const es = [line("a", [["este", 0, 300], ["vídeo", 320, 700]]), line("b", [["este,", 1000, 1300], ["bueno", 1800, 2000]]), line("c", [["o", 3000, 3100], ["sea", 3100, 3300], ["mira", 3500, 3700]])];
    expect(findFillers(es, "es").map((f) => f.text)).toEqual(["este,", "o sea"]);
  });

  it("pads each cut but never into the next word", () => {
    expect(fillerCuts(findFillers(en, "en"), en, 150)).toEqual([{ start: 200, end: 650 }, { start: 1000, end: 1450 }]);
  });
});

describe("clicks", () => {
  it("groups close clicks into bursts", () => {
    expect(clickBursts([{ t: 0 }, { t: 500 }, { t: 900 }, { t: 5000 }, { t: 9000 }, { t: 9100 }, { t: 9300 }, { t: 9400 }])).toEqual([{ start: 0, end: 900, clicks: 3 }, { start: 9000, end: 9400, clicks: 4 }]);
  });
});

describe("caption fixes", () => {
  const lines = [line("a", [["Hello", 0, 400], ["wrld", 400, 800]]), line("b", [["open", 1000, 1200], ["take", 1200, 1500], ["is", 1500, 1600], ["free", 1600, 1900]])];

  it("replaces text, finds and replaces across lines, splits, merges, retimes, deletes", () => {
    const r = applyCaptionOps(lines, [
      { op: "replace_text", line_id: "a", text: "Hello world" },
      { op: "find_replace", find: "open take", replace: "OpenTake" },
      { op: "split", line_id: "b", before_word: 1 },
      { op: "retime", line_id: "a", shift: 0.1 },
    ]);
    expect(r.problems).toEqual([]);
    expect(r.applied).toBe(4);
    expect(r.lines.map((l) => [l.words.map((w) => w.text).join(" "), l.start])).toEqual([["Hello world", 100], ["OpenTake", 1000], ["is free", 1500]]);
    const m = applyCaptionOps(r.lines, [{ op: "merge_with_next", line_id: r.lines[1].id }, { op: "delete", line_id: "a" }]);
    expect(m.lines.map((l) => l.words.map((w) => w.text).join(" "))).toEqual(["OpenTake is free"]);
  });

  it("reports what it could not do instead of guessing", () => {
    const r = applyCaptionOps(lines, [{ op: "replace_text", line_id: "zz", text: "x" }, { op: "find_replace", find: "nope", replace: "x" }, { op: "split", line_id: "a", before_word: 5 }]);
    expect(r.applied).toBe(0);
    expect(r.problems).toHaveLength(3);
  });

  it("does not match inside a word unless asked", () => {
    expect(applyCaptionOps(lines, [{ op: "find_replace", find: "is", replace: "IS" }]).lines[1].words.map((w) => w.text)).toEqual(["open", "take", "IS", "free"]);
  });

  it("prints a transcript with ids and times", () => {
    expect(transcriptText(lines)).toBe("[a 0.00-0.80] Hello wrld\n[b 1.00-1.90] open take is free");
  });
});
