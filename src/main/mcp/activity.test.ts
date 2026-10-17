import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readActivity, record, snapshot, TITLE, undo } from "./activity";
import { allowed } from "./bridge-server";
import { setLang } from "../../shared/i18n";

let base: string, userData: string, take: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "ot-activity-"));
  userData = join(base, "ud");
  take = join(base, "rec", "2026-10-17 10.00.00");
  mkdirSync(take, { recursive: true });
  writeFileSync(join(take, "take.json"), JSON.stringify({ id: "t", title: "Old", exports: ["a.mp4"] }));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe("activity and undo", () => {
  it("logs calls newest first and undoes an edit", async () => {
    writeFileSync(join(take, "edit.json"), "before");
    await record(userData, { tool: "list_takes", summary: "Listed", ok: true });
    const snap = await snapshot("t", take, ["edit.json"]);
    writeFileSync(join(take, "edit.json"), "after");
    const e = await record(userData, { tool: "cut_ranges", takeId: "t", summary: "Cut 1", ok: true }, snap);
    const list = await readActivity(userData);
    expect(list.map((x) => x.tool)).toEqual(["cut_ranges", "list_takes"]);
    expect(list[0].undoable).toBe(true);
    expect((await undo(userData, e.id)).ok).toBe(true);
    expect(readFileSync(join(take, "edit.json"), "utf8")).toBe("before");
    expect((await readActivity(userData))[0].undoneAt).toBeTruthy();
    expect((await undo(userData, e.id)).message).toMatch(/already undone/);
  });

  it("refuses when the file changed again since, so hand edits survive", async () => {
    const snap = await snapshot("t", take, ["captions.json"]);
    writeFileSync(join(take, "captions.json"), "assistant");
    const e = await record(userData, { tool: "edit_captions", takeId: "t", summary: "x", ok: true }, snap);
    writeFileSync(join(take, "captions.json"), "by hand");
    const r = await undo(userData, e.id);
    expect(r.ok).toBe(false);
    expect(readFileSync(join(take, "captions.json"), "utf8")).toBe("by hand");
  });

  it("moves a file the edit created aside instead of deleting it", async () => {
    const snap = await snapshot("t", take, ["chapters.json"]);
    writeFileSync(join(take, "chapters.json"), "new");
    const e = await record(userData, { tool: "add_chapters", takeId: "t", summary: "x", ok: true }, snap);
    expect((await undo(userData, e.id)).ok).toBe(true);
    expect(existsSync(join(take, "chapters.json"))).toBe(false);
    expect(readdirSync(join(take, ".assistant"))).toEqual([`undone-${e.id}-chapters.json`]);
  });

  it("undoes a title without touching the rest of take.json", async () => {
    const snap = await snapshot("t", take, [TITLE]);
    writeFileSync(join(take, "take.json"), JSON.stringify({ id: "t", title: "New", exports: ["a.mp4"] }));
    const e = await record(userData, { tool: "set_title", takeId: "t", summary: "x", ok: true }, snap);
    // an export lands meanwhile: the title can still be undone
    writeFileSync(join(take, "take.json"), JSON.stringify({ id: "t", title: "New", exports: ["b.mp4", "a.mp4"] }));
    expect((await undo(userData, e.id)).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(take, "take.json"), "utf8"))).toEqual({ id: "t", title: "Old", exports: ["b.mp4", "a.mp4"] });
  });

  it("an edit that changed nothing is not undoable", async () => {
    const snap = await snapshot("t", take, ["edit.json"]);
    const e = await record(userData, { tool: "cut_ranges", takeId: "t", summary: "x", ok: true }, snap);
    expect(e.undoable).toBe(false);
  });

  it("rejects ids that are not ours, in the app's language", async () => {
    expect((await undo(userData, "../../x")).message).toBe("That is not a change OpenTake knows.");
    setLang("es");
    try { expect((await undo(userData, "../../x")).message).toBe("OpenTake no conoce ese cambio."); } finally { setLang("en"); }
  });
});

describe("bridge gate", () => {
  const token = "a".repeat(64);
  const h = (o: Record<string, string>) => ({ host: "127.0.0.1:5000", "x-opentake-token": token, ...o });
  it("lets in the right token from this machine only", () => {
    expect(allowed(h({}), token, 5000)).toEqual({ ok: true });
    expect(allowed(h({ "x-opentake-token": "b".repeat(64) }), token, 5000)).toMatchObject({ ok: false, status: 401 });
    expect(allowed(h({ "x-opentake-token": "short" }), token, 5000)).toMatchObject({ ok: false, status: 401 });
    expect(allowed(h({ host: "evil.example:5000" }), token, 5000)).toMatchObject({ ok: false, status: 403 });
    expect(allowed(h({ origin: "https://evil.example" }), token, 5000)).toMatchObject({ ok: false, status: 403 });
    expect(allowed(h({ "sec-fetch-site": "cross-site" }), token, 5000)).toMatchObject({ ok: false, status: 403 });
  });
});
