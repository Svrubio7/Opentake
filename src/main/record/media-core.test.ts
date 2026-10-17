import { describe, expect, it } from "vitest";
import { mediaUrl, mimeFor, parseMediaUrl, parseRange } from "./media-core";

describe("media protocol", () => {
  it("round-trips a take URL", () => {
    const u = mediaUrl("2026-10-16 09.05.03 (2)", "preview.webm");
    expect(parseMediaUrl(u)).toEqual({ takeId: "2026-10-16 09.05.03 (2)", file: "preview.webm" });
  });
  it("refuses anything that is not a take's own media", () => {
    expect(parseMediaUrl("opentake-media://take/..%2F..%2Fetc/preview.webm")).toBeNull();
    expect(parseMediaUrl("opentake-media://take/abc/take.json")).toBeNull();
    expect(parseMediaUrl("opentake-media://take/abc/..%5Csecret.webm")).toBeNull();
    expect(parseMediaUrl("opentake-media://other/abc/preview.webm")).toBeNull();
    expect(parseMediaUrl("file:///c:/x/preview.webm")).toBeNull();
    expect(parseMediaUrl("opentake-media://take/abc/take-reels.mp4")).toEqual({ takeId: "abc", file: "take-reels.mp4" });
  });
  it("reads byte ranges", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=200-", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBe("invalid");
  });
  it("names the type", () => {
    expect(mimeFor("preview.webm")).toBe("video/webm");
    expect(mimeFor("take.mp4")).toBe("video/mp4");
  });
});
