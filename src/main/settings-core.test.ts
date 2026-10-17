import { describe, expect, it } from "vitest";
import {
  DEFAULT_NAME_TEMPLATE, DEFAULT_SETTINGS, cleanTitle, friendlyExportError, isInside, lastStatsTimeMs, mountRoot, presetWords, renderName,
  sanitizeFileName, sanitizeSettings, shortPath, uniqueName, withPastDir,
} from "./settings-core";

const at = new Date(2026, 9, 17, 14, 5, 9).getTime();

describe("sanitizeSettings", () => {
  it("falls back to the defaults for anything missing or malformed", () => {
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ exportDestination: "cloud", afterExport: 3, nameTemplate: "  ", recordingsDir: "" })).toEqual(DEFAULT_SETTINGS);
  });
  it("keeps valid choices and drops a NUL path", () => {
    const s = sanitizeSettings({ recordingsDir: "E:\\Takes", exportDestination: "ask", exportDir: "bad\0path", afterExport: "open", nameTemplate: "{title}\n{date}" });
    expect(s).toMatchObject({ recordingsDir: "E:\\Takes", exportDestination: "ask", exportDir: null, afterExport: "open", nameTemplate: "{title} {date}" });
  });
  it("keeps at most five past folders", () => {
    expect(sanitizeSettings({ pastRecordingsDirs: ["a", "b", "c", "d", "e", "f", 7] }).pastRecordingsDirs).toEqual(["a", "b", "c", "d", "e"]);
  });
});

describe("withPastDir", () => {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  it("puts the previous folder first, without repeats or the new folder", () => {
    expect(withPastDir(["D:\\old", "C:\\x"], "C:\\X", "D:\\OLD", same)).toEqual(["C:\\X"]);
    expect(withPastDir([], "C:\\a", "C:\\b", same)).toEqual(["C:\\a"]);
  });
});

describe("sanitizeFileName", () => {
  it("keeps accents, other scripts and emoji", () => {
    expect(sanitizeFileName("Mis cosillas: demo ñandú 日本 🎬")).toBe("Mis cosillas- demo ñandú 日本 🎬");
  });
  it("replaces characters Windows refuses and trims dots and spaces at the end", () => {
    expect(sanitizeFileName('a<b>c"d/e\\f|g?h*i. ')).toBe("a-b-c-d-e-f-g-h-i");
    expect(sanitizeFileName("...")).toBe("OpenTake take");
  });
  it("never yields a reserved device name", () => {
    expect(sanitizeFileName("CON")).toBe("CON_");
    expect(sanitizeFileName("lpt1.mp4")).toBe("lpt1.mp4_");
    expect(sanitizeFileName("Console")).toBe("Console");
  });
  it("cuts long names by whole characters", () => {
    const s = sanitizeFileName("é".repeat(119) + "🎬🎬");
    expect(Array.from(s)).toHaveLength(120);
    expect(s.endsWith("🎬")).toBe(true);
  });
  it("composes decomposed accents", () => {
    expect(sanitizeFileName("Jose\u0301")).toBe("José");
  });
});

describe("cleanTitle", () => {
  it("is one tidy line of at most 80 characters", () => {
    expect(cleanTitle("  Product\n demo\t v2 ")).toBe("Product demo v2");
    expect(cleanTitle("x".repeat(100))).toHaveLength(80);
    expect(cleanTitle(42)).toBe("");
  });
});

describe("renderName", () => {
  it("fills the default template", () => {
    expect(renderName(DEFAULT_NAME_TEMPLATE, { createdAt: at, title: "Demo", preset: "reels" })).toBe("2026-10-17 14.05 Demo reels");
  });
  it("drops the gaps an empty title or preset leave", () => {
    expect(renderName(DEFAULT_NAME_TEMPLATE, { createdAt: at })).toBe("2026-10-17 14.05");
    expect(renderName("{title} - {date} - {preset}", { createdAt: at, title: "" })).toBe("2026-10-17");
    expect(renderName("{date} - {title} - {preset}", { createdAt: at, preset: "square" })).toBe("2026-10-17 - square");
  });
  it("keeps unknown words and makes the result a safe name", () => {
    expect(renderName("{client}: {TITLE}", { createdAt: at, title: "Año nuevo / v2" })).toBe("{client}- Año nuevo - v2");
  });
  it("falls back to a dated name when everything is empty", () => {
    expect(renderName("{title}", { createdAt: at })).toBe("OpenTake 2026-10-17 14.05");
  });
});

describe("presetWords", () => {
  it("turns the old file names into words", () => {
    expect(presetWords("take.mp4")).toBe("");
    expect(presetWords("take-reels.mp4")).toBe("reels");
    expect(presetWords("take-hires-square-captions.webm")).toBe("hires square captions");
    expect(presetWords("take-800x600.gif")).toBe("800x600");
  });
});

describe("uniqueName", () => {
  it("adds a number instead of overwriting", () => {
    const taken = new Set(["Demo.mp4", "Demo (2).mp4"]);
    expect(uniqueName("Demo", "mp4", (n) => taken.has(n))).toBe("Demo (3).mp4");
    expect(uniqueName("Other", "mp4", (n) => taken.has(n))).toBe("Other.mp4");
  });
  it("also keeps the captions files beside it free", () => {
    const taken = new Set(["Demo.srt"]);
    expect(uniqueName("Demo", "mp4", (n) => taken.has(n), ["srt", "vtt"])).toBe("Demo (2).mp4");
  });
});

describe("friendlyExportError", () => {
  it("says what to do about a full drive or a folder it cannot write", () => {
    expect(friendlyExportError("ffmpeg failed: av_interleaved_write_frame(): No space left on device")).toMatch(/drive is full/);
    expect(friendlyExportError("EACCES: permission denied, open 'X'")).toMatch(/cannot write/);
    expect(friendlyExportError("Something else")).toBe("Something else");
  });
});

describe("lastStatsTimeMs", () => {
  it("reads the last time= ffmpeg printed", () => {
    expect(lastStatsTimeMs("frame=1 time=00:00:01.00 bitrate\nframe=9 time=00:01:02.50 bitrate")).toBe(62500);
    expect(lastStatsTimeMs("no stats")).toBeNull();
  });
});

describe("isInside", () => {
  it("compares paths without case on Windows only", () => {
    expect(isInside("C:\\Users\\Me\\Takes\\a.mp4", "c:/users/me/takes", true)).toBe(true);
    expect(isInside("C:\\Users\\Me\\Takes2\\a.mp4", "C:\\Users\\Me\\Takes", true)).toBe(false);
    expect(isInside("/home/me/Takes/a", "/home/me/takes", false)).toBe(false);
    expect(isInside("/home/me/Takes", "/home/me/Takes/", false)).toBe(true);
  });
});

describe("mountRoot", () => {
  it("finds the drive, share or removable volume a path needs", () => {
    expect(mountRoot("E:\\Takes\\OpenTake", "win32")).toBe("E:\\");
    expect(mountRoot("\\\\nas\\video\\Takes", "win32")).toBe("\\\\nas\\video\\");
    expect(mountRoot("/Volumes/USB Drive/Takes", "darwin")).toBe("/Volumes/USB Drive");
    expect(mountRoot("/Users/me/Movies/Takes", "darwin")).toBe("/");
    expect(mountRoot("/media/me/disk/Takes", "linux")).toBe("/media/me/disk");
    expect(mountRoot("/run/media/me/disk/Takes", "linux")).toBe("/run/media/me/disk");
    expect(mountRoot("/mnt/data/Takes", "linux")).toBe("/mnt/data");
  });
});

describe("shortPath", () => {
  it("keeps short paths and cuts long ones from the left at a folder", () => {
    expect(shortPath("C:\\Takes")).toBe("C:\\Takes");
    expect(shortPath("C:\\Users\\svrub\\Documents\\Mis cosillas\\Vídeos\\OpenTake recordings", 44)).toBe("…\\Mis cosillas\\Vídeos\\OpenTake recordings");
    expect(shortPath("C:\\Users\\svrub\\Documents\\Mis cosillas\\Vídeos\\OpenTake recordings", 30)).toBe("…\\Vídeos\\OpenTake recordings");
    expect(shortPath("/home/me/a/very/long/path/to/OpenTake recordings", 30)).toBe("…/path/to/OpenTake recordings");
    expect(shortPath("/x/" + "a".repeat(60), 20).length).toBe(20);
  });
});

describe("theme setting", () => {
  it("keeps light and dark, and reads anything else as the system's", () => {
    expect(sanitizeSettings({ theme: "light" }).theme).toBe("light");
    expect(sanitizeSettings({ theme: "dark" }).theme).toBe("dark");
    expect(sanitizeSettings({ theme: "neon" }).theme).toBe("system");
    expect(sanitizeSettings({}).theme).toBe("system");
  });
});
