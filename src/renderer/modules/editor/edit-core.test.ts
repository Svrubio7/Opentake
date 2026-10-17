import { describe, expect, it } from "vitest";
import {
  clipEdited, formatTime, gaps, history, indexAt, isWhole, keptDuration, mergeTouching, normalizeKeep, parseEdit, playableAt, push,
  redo, removeAt, restore, rulerStep, setIn, setOut, splitAt, toEdited, toSource, undo, wholeTake,
} from "./edit-core";

describe("cuts", () => {
  it("normalizes: sorted, clamped, overlaps folded, touching kept apart, slivers dropped", () => {
    expect(normalizeKeep([{ start: 5000, end: 12000 }, { start: -10, end: 2000 }, { start: 1500, end: 3000 }, { start: 3000, end: 4000 }, { start: 4500, end: 4510 }], 10000))
      .toEqual([{ start: 0, end: 3000 }, { start: 3000, end: 4000 }, { start: 5000, end: 10000 }]);
  });
  it("splits at the playhead and deletes one side", () => {
    let k = wholeTake(10000);
    k = splitAt(k, 4000);
    expect(k).toEqual([{ start: 0, end: 4000 }, { start: 4000, end: 10000 }]);
    k = splitAt(k, 6000);
    expect(indexAt(k, 5000)).toBe(1);
    k = removeAt(k, 1);
    expect(k).toEqual([{ start: 0, end: 4000 }, { start: 6000, end: 10000 }]);
    expect(keptDuration(k)).toBe(8000);
    expect(splitAt(k, 4010)).toBe(k); // too close to an edge
    expect(splitAt(k, 5000)).toBe(k); // inside a cut
  });
  it("maps times both ways around a cut", () => {
    const k = [{ start: 0, end: 4000 }, { start: 6000, end: 10000 }];
    expect(toEdited(3000, k)).toBe(3000);
    expect(toEdited(5000, k)).toBeNull();
    expect(toEdited(7000, k)).toBe(5000);
    expect(toEdited(10000, k)).toBe(8000);
    expect(toSource(5000, k)).toBe(7000);
    expect(toSource(3999, k)).toBe(3999);
    expect(toSource(99999, k)).toBe(10000);
  });
  it("skips over cuts during playback", () => {
    const k = [{ start: 1000, end: 4000 }, { start: 6000, end: 10000 }];
    expect(playableAt(0, k)).toBe(1000);
    expect(playableAt(2000, k)).toBe(2000);
    expect(playableAt(4500, k)).toBe(6000);
    expect(playableAt(10000, k)).toBeNull();
  });
  it("sets in and out points", () => {
    const k = [{ start: 0, end: 4000 }, { start: 6000, end: 10000 }];
    expect(setIn(k, 2000)).toEqual([{ start: 2000, end: 4000 }, { start: 6000, end: 10000 }]);
    expect(setIn(k, 7000)).toEqual([{ start: 7000, end: 10000 }]);
    expect(setOut(k, 8000)).toEqual([{ start: 0, end: 4000 }, { start: 6000, end: 8000 }]);
  });
  it("lists the gaps and restores one, keeping the splits", () => {
    const k = [{ start: 1000, end: 4000 }, { start: 4000, end: 5000 }, { start: 6000, end: 9000 }];
    const g = gaps(k, 10000);
    expect(g).toEqual([{ start: 0, end: 1000 }, { start: 5000, end: 6000 }, { start: 9000, end: 10000 }]);
    expect(restore(k, g[1], 10000)).toEqual([{ start: 1000, end: 4000 }, { start: 4000, end: 5000 }, { start: 5000, end: 6000 }, { start: 6000, end: 9000 }]);
    expect(mergeTouching(restore(k, g[1], 10000))).toEqual([{ start: 1000, end: 9000 }]);
  });
  it("knows a whole take", () => {
    expect(isWhole([{ start: 0, end: 5000 }, { start: 5000, end: 10000 }], 10000)).toBe(true);
    expect(isWhole([{ start: 0, end: 9000 }], 10000)).toBe(false);
  });
  it("clips the edited timeline (silence trimmed off the edited start and end)", () => {
    const k = [{ start: 0, end: 4000 }, { start: 6000, end: 10000 }];
    // 1 s in from the edited start, 1.5 s off the edited end (edited length is 8 s)
    expect(clipEdited(k, 1000, 6500)).toEqual([{ start: 1000, end: 4000 }, { start: 6000, end: 8500 }]);
    expect(clipEdited(k, 5000, null)).toEqual([{ start: 7000, end: 10000 }]);
    expect(clipEdited(wholeTake(Infinity), 500, null)[0]).toMatchObject({ start: 500 });
  });
  it("parses a saved edit and drops junk", () => {
    expect(parseEdit({ version: 1, keep: [{ start: 0, end: 1000 }, { start: "x" }] }, 5000)).toEqual({ version: 1, keep: [{ start: 0, end: 1000 }] });
    expect(parseEdit({ version: 2, keep: [] }, 5000)).toBeNull();
    expect(parseEdit(null, 5000)).toBeNull();
  });
});

describe("undo history", () => {
  it("undoes and redoes, and a new change clears redo", () => {
    let h = history(1);
    h = push(h, 2);
    h = push(h, 3);
    h = undo(h);
    expect(h.present).toBe(2);
    h = redo(h);
    expect(h.present).toBe(3);
    h = undo(undo(h));
    expect(h.present).toBe(1);
    expect(undo(h)).toBe(h);
    h = push(h, 9);
    expect(h.future).toEqual([]);
    expect(redo(h)).toBe(h);
  });
});

describe("display", () => {
  it("formats the clock and picks ruler steps", () => {
    expect(formatTime(65300)).toBe("1:05.3");
    expect(formatTime(5000, false)).toBe("0:05");
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(10)).toBe(10);
  });
});
