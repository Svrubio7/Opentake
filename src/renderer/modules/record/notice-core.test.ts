import { describe, expect, it } from "vitest";
import { NAME_CARD_NOTICE, PICK_NOTICE, SAVED_NOTICE, WINDOW_CLOSED_NOTICE, isStale, noticeLifetimeMs, type MessageState } from "./notice-core";

const s: MessageState = { mode: "screen-camera", sourceId: null, status: "idle", folderOk: true, nameCard: false };

describe("isStale", () => {
  it("drops the ask for a screen once one is picked or the scene needs none", () => {
    expect(isStale(PICK_NOTICE, s)).toBe(false);
    expect(isStale(PICK_NOTICE, { ...s, mode: "camera" })).toBe(true);
    expect(isStale(PICK_NOTICE, { ...s, sourceId: "screen:1" })).toBe(true);
    expect(isStale(WINDOW_CLOSED_NOTICE, { ...s, sourceId: "window:2" })).toBe(true);
    expect(isStale("Could not capture Chrome: denied", { ...s, sourceId: "screen:1" })).toBe(true);
  });
  it("drops a folder problem once the folder works", () => {
    const m = "The recordings folder Q:\\Takes is not available. Is its drive plugged in? Choose another folder in Settings.";
    expect(isStale(m, { ...s, folderOk: false })).toBe(false);
    expect(isStale(m, { ...s, folderOk: null })).toBe(false);
    expect(isStale(m, s)).toBe(true);
    expect(isStale("OpenTake cannot write to the recordings folder X. Choose another folder in Settings.", s)).toBe(true);
  });
  it("drops messages about a take once it has ended", () => {
    for (const m of ["Recording without computer sound.", "The recordings drive is almost full: about 3 minutes left.", "Only 1.2 GB free on the recordings drive. The take may stop early."]) {
      expect(isStale(m, { ...s, status: "recording" })).toBe(false);
      expect(isStale(m, s)).toBe(true);
    }
  });
  it("drops the name card hint once it is on, and keeps what it does not know", () => {
    expect(isStale(NAME_CARD_NOTICE, { ...s, nameCard: true })).toBe(true);
    expect(isStale("The recordings folder stopped answering (was a drive unplugged?).", s)).toBe(false);
    expect(isStale(SAVED_NOTICE, s)).toBe(false);
  });
});

describe("noticeLifetimeMs", () => {
  it("lets information go by itself, never errors", () => {
    expect(noticeLifetimeMs(SAVED_NOTICE)).toBe(12_000);
    expect(noticeLifetimeMs("A take was still recording when OpenTake closed. It was recovered and is in Takes.")).toBe(20_000);
    expect(noticeLifetimeMs("2 takes were still recording when OpenTake closed. They were recovered and are in Takes.")).toBe(20_000);
    expect(noticeLifetimeMs("Could not delete: busy")).toBeNull();
  });
});
