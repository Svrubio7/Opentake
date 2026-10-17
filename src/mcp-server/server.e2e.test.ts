// End to end: the built MCP server (out/mcp/opentake-mcp.cjs) is started over stdio exactly as Claude
// starts it (Electron's own binary in Node mode), against a take made with ffmpeg in a temp folder.
// The app's side is the real bridge server with stand-in handlers: the export handler runs a real
// ffmpeg export through the same argument builder the app's editor export uses.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import ffmpegStatic from "ffmpeg-static";
import type { ExportOptions } from "../shared/types";
import { editExportArgs } from "../main/record/export-core";
import { runWatched } from "../main/record/ffmpeg-run";
import { Jobs, startBridge, type BridgeHandle } from "../main/mcp/bridge-server";
import { readActivity } from "../main/mcp/activity";
import { FIXTURE_TAKE, makeFixtureTake } from "./test-fixture";

const ROOT = resolve(__dirname, "../..");
const BUNDLE = join(ROOT, "out/mcp/opentake-mcp.cjs");
const FFMPEG = ffmpegStatic as unknown as string;
const electronBin = (() => { try { return execFileSync(process.execPath, ["-e", "process.stdout.write(require('electron'))"], { cwd: ROOT, encoding: "utf8" }); } catch { return ""; } })();

let tmp: string, userData: string, recordings: string, takeDir: string;
let client: Client;
let bridge: BridgeHandle;
const changed: string[] = [];

type Result = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
const text = (r: Result) => r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
const json = (r: Result) => { const t = text(r); return JSON.parse(t.slice(t.indexOf("\n\n") + 2)); };

beforeAll(async () => {
  execFileSync(process.execPath, [join(ROOT, "scripts/build-mcp.mjs")], { cwd: ROOT, stdio: "ignore" });
  tmp = mkdtempSync(join(tmpdir(), "ot-mcp-e2e-"));
  userData = join(tmp, "user data");
  recordings = join(tmp, "Grabaciones de prueba");
  takeDir = makeFixtureTake(FFMPEG, recordings);
  writeFileSync(join(tmp, "settings.json"), "");
  execFileSync(process.execPath, ["-e", `require('fs').mkdirSync(${JSON.stringify(userData)},{recursive:true})`]);
  writeFileSync(join(userData, "settings.json"), JSON.stringify({ version: 1, recordingsDir: recordings, exportDestination: "take", exportDir: null, nameTemplate: "{date} {time} {title} {preset}", afterExport: "nothing", pastRecordingsDirs: [] }));

  const jobs = new Jobs();
  bridge = await startBridge({
    userData, version: "test",
    handlers: {
      ping: () => ({ version: "test" }),
      changed: (p) => { changed.push(String(p.takeId)); return true; },
      job: (p) => { const j = jobs.get(String(p.id)); if (!j) throw new Error("no such job"); return j; },
      export: (p) => {
        const o = p.options as ExportOptions;
        const job = jobs.start("export", o.takeId);
        const out = join(recordings, o.takeId, `export-${job.id}.mp4`);
        const keep = JSON.parse(readFileSync(join(recordings, o.takeId, "edit.json"), "utf8")).keep;
        const args = editExportArgs({ source: { kind: "composite", input: join(recordings, o.takeId, "composite.webm"), fps: 30 }, srcSize: { width: 1280, height: 720 }, audio: true, keep, loudness: null, output: o.output!, burn: null, out, limitSec: null });
        void runWatched(FFMPEG, args, { cwd: join(recordings, o.takeId) }).then((r) => jobs.finish(job, r.code === 0 ? { output: [out] } : { error: r.stderr.slice(-300) }));
        return job;
      },
    },
  });

  client = new Client({ name: "opentake-e2e", version: "1.0.0" });
  const runtime = electronBin && existsSync(electronBin) ? electronBin : process.execPath;
  await client.connect(new StdioClientTransport({
    command: runtime,
    args: [BUNDLE],
    env: { ...(process.env as Record<string, string>), ELECTRON_RUN_AS_NODE: "1", OPENTAKE_USER_DATA: userData, OPENTAKE_FFMPEG: FFMPEG, OPENTAKE_NO_LAUNCH: "1" },
    stderr: "pipe",
  }));
}, 120_000);

afterAll(async () => {
  await client?.close();
  await bridge?.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("OpenTake MCP server over stdio", () => {
  it("lists its tools and prompts", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["add_chapters", "cut_ranges", "edit_captions", "export_take", "export_timeline", "find_moments", "get_frame", "get_job", "get_take", "get_transcript",
      "import_video", "keep_ranges", "list_takes", "remove_filler_words", "remove_silences", "set_caption_style", "set_cuts", "set_title", "undo_change"]);
    expect(tools.find((t) => t.name === "list_takes")?.annotations?.readOnlyHint).toBe(true);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(["clean_up_ums_and_pauses", "tighten_last_take", "vertical_60s_with_captions"]);
  });

  it("list_takes and get_take read the take", async () => {
    const takes = json(await call("list_takes"));
    expect(takes).toHaveLength(1);
    expect(takes[0]).toMatchObject({ id: FIXTURE_TAKE, length_s: 12, mode: "screen-camera", frame: "1280x720", has: { cuts: false, captions: false, separate_tracks: true } });
    const t = json(await call("get_take", { take: "latest" }));
    expect(t.clicks.count).toBe(5);
    expect(t.scene_switches).toEqual([{ at_s: 6, scene: "screen" }]);
    expect(t.tracks).toEqual({ composite: true, screen: true, camera: true, system_sound: true });
  });

  it("get_frame returns a PNG the model can see", async () => {
    const r = await call("get_frame", { take: FIXTURE_TAKE, at: 3.2, width: 640 });
    expect(r.isError).toBeFalsy();
    const img = r.content.find((c) => c.type === "image") as { data: string; mimeType: string };
    expect(img.mimeType).toBe("image/png");
    const png = Buffer.from(img.data, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(640); // IHDR width
    expect(png.readUInt32BE(20)).toBe(360);
  });

  it("find_moments finds the silences, scene switch and click burst", async () => {
    const m = json(await call("find_moments", { take: FIXTURE_TAKE }));
    expect(m.silences).toHaveLength(2);
    expect(m.silences[0].start).toBeCloseTo(2, 0);
    expect(m.silences[0].end).toBeCloseTo(4.5, 0);
    expect(m.silences[1].start).toBeCloseTo(7, 0);
    expect(m.scene_switches).toEqual([{ at: 6, scene: "screen" }]);
    expect(m.click_bursts).toEqual([{ start: 1, end: 1.6, clicks: 3 }]);
  });

  it("cut_ranges writes edit.json, tells the app, and refuses a bad take id", async () => {
    const r = json(await call("cut_ranges", { take: FIXTURE_TAKE, ranges: [{ start: 2.2, end: 4.3 }] }));
    expect(r.edited_length_s).toBeCloseTo(9.9, 1);
    const edit = JSON.parse(readFileSync(join(takeDir, "edit.json"), "utf8"));
    expect(edit.keep).toEqual([{ start: 0, end: 2200 }, { start: 4300, end: 12000 }]);
    expect(changed).toContain(FIXTURE_TAKE);
    const bad = await call("cut_ranges", { take: "../../Windows", ranges: [{ start: 0, end: 1 }] });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toMatch(/not a take id/);
  });

  it("remove_silences dry run saves nothing; undo puts the cuts back", async () => {
    const before = readFileSync(join(takeDir, "edit.json"), "utf8");
    const dry = await call("remove_silences", { take: FIXTURE_TAKE, dry_run: true });
    expect(text(dry)).toMatch(/Not saved/);
    expect(readFileSync(join(takeDir, "edit.json"), "utf8")).toBe(before);
    await call("remove_silences", { take: FIXTURE_TAKE, min_silence_s: 1 });
    expect(readFileSync(join(takeDir, "edit.json"), "utf8")).not.toBe(before);
    const u = await call("undo_change");
    expect(u.isError).toBeFalsy();
    expect(readFileSync(join(takeDir, "edit.json"), "utf8")).toBe(before);
    const log = await readActivity(userData);
    expect(log.find((e) => e.tool === "remove_silences" && e.undoable)?.undoneAt).toBeTruthy();
  });

  it("set_title and add_chapters", async () => {
    await call("set_title", { take: FIXTURE_TAKE, title: "Demo de corte" });
    expect(JSON.parse(readFileSync(join(takeDir, "take.json"), "utf8")).title).toBe("Demo de corte");
    const r = await call("add_chapters", { take: FIXTURE_TAKE, chapters: [{ at: 0, title: "Intro" }, { at: 5, title: "Second part" }, { at: 3, title: "Cut away" }] });
    // the chapter at 3 s is in the cut stretch: on file, but not in the edited list
    expect(text(r)).toContain("0:00 Intro");
    expect(text(r)).toContain("0:03 Second part");
    expect(text(r)).not.toContain("Cut away\n");
  });

  it("export_timeline writes OTIO, FCPXML and media an editor can seek", async () => {
    const r = await call("export_timeline", { take: FIXTURE_TAKE, layout: "separate", fcpxml: true });
    expect(r.isError).toBeFalsy();
    const files = readdirSync(takeDir);
    const otioName = files.find((f) => f.endsWith(".otio"))!;
    expect(otioName).toBe("2026-10-17 10.00 Demo de corte timeline.otio");
    expect(files).toContain("2026-10-17 10.00 Demo de corte timeline.fcpxml");
    const otio = JSON.parse(readFileSync(join(takeDir, otioName), "utf8"));
    expect(otio.tracks.children.map((t: { name: string; kind: string }) => `${t.name}:${t.kind}`)).toEqual(["V1:Video", "V2:Video", "A1:Audio", "A2:Audio"]);
    const v1 = otio.tracks.children[0].children;
    expect(v1.map((c: { source_range: { start_time: { value: number }; duration: { value: number } } }) => [c.source_range.start_time.value, c.source_range.duration.value])).toEqual([[0, 66], [129, 231]]);
    // the system sound is 2 s shorter than the take: a gap closes the track
    expect(otio.tracks.children[3].children.map((c: { OTIO_SCHEMA: string }) => c.OTIO_SCHEMA)).toEqual(["Clip.2", "Clip.2", "Gap.1"]);
    const names = otio.tracks.markers.map((m: { name: string }) => m.name);
    expect(names).toEqual(expect.arrayContaining(["Click", "Scene: Screen", "Intro", "Second part"]));
    expect(names).not.toContain("Cut away");
    // exported a second time: a new name, nothing overwritten
    await call("export_timeline", { take: FIXTURE_TAKE });
    expect(readdirSync(takeDir)).toContain("2026-10-17 10.00 Demo de corte timeline (2).otio");
    // the composite has no index (a live WebM, like MediaRecorder's): the editor-friendly copy was made
    expect(existsSync(join(takeDir, "preview.webm"))).toBe(true);
  });

  it("export_take runs in the app and get_job follows it", async () => {
    const r = await call("export_take", { take: FIXTURE_TAKE, preset: "vertical", crf: 30, loudness: "off", wait_s: 0 });
    expect(r.isError).toBeFalsy();
    const job = json(r);
    expect(job.job_id).toMatch(/^app-/);
    const done = json(await call("get_job", { job_id: job.job_id, wait_s: 45 }));
    expect(done.done).toBe(true);
    expect(done.error).toBeNull();
    expect(existsSync(done.files[0])).toBe(true);
  }, 90_000);

  it("refuses to make captions with the app closed, plainly", async () => {
    await bridge.close();
    const r = await call("get_transcript", { take: FIXTURE_TAKE });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/OpenTake is not running/);
  });

  it("import_video copies a file in as a new take and leaves the original", async () => {
    const src = join(tmp, "clip à importer.mov");
    execFileSync(FFMPEG, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", src]);
    const before = readFileSync(src);
    const r = await call("import_video", { path: src, title: "Clip" });
    expect(r.isError).toBeFalsy();
    const takes = json(await call("list_takes"));
    const imported = takes.find((t: { title: string }) => t.title === "Clip");
    expect(imported).toMatchObject({ length_s: 3, frame: "640x360", imported: true });
    expect(readFileSync(src).equals(before)).toBe(true);
    expect(text(await call("import_video", { path: "relative.mp4" }))).toMatch(/full path/);
    expect(text(await call("import_video", { path: join(tmp, "nope.mp4") }))).toMatch(/no file/);
  });

  it("logs every call to the activity list", async () => {
    const log = await readActivity(userData, 500);
    expect(log.length).toBeGreaterThan(10);
    expect(log.some((e) => e.tool === "cut_ranges" && e.ok && e.undoable)).toBe(true);
    expect(log.some((e) => e.tool === "get_transcript" && !e.ok)).toBe(true);
  });
});
