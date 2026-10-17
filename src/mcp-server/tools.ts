// The OpenTake MCP server's tools and prompts. Reads and edits work on the take folders directly (the
// same edit.json and captions.json the editor uses, so the editor shows every change and it can be
// undone); captions and video exports run in the app, through its local bridge. Every call is logged to
// the activity list Settings shows. Nothing is ever deleted or overwritten.
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { constants as fsc } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { t as tr } from "../shared/i18n";
import type { AssistantJob } from "../shared/assistant";
import type { CaptionBurn, CaptionLang, ExportOptions, ExportOutput, TimeRange } from "../shared/types";
import { keptDuration, mergeTouching, toEdited, toSource, wholeTake, isWhole } from "../renderer/modules/editor/edit-core";
import { isInside } from "../main/settings-core";
import { takeFolderName } from "../main/record/ffmpeg-core";
import { cleanChapters, parseCaptionStyle } from "../main/record/take-extras";
import { exportTimeline, type TimelineTake } from "../main/record/timeline-export";
import { readActivity, record, snapshot, TITLE, undo } from "../main/mcp/activity";
import { AppNotRunning, Bridge } from "./bridge-client";
import { Ff } from "./ff";
import {
  applyCaptionOps, clickBursts, fillerCuts, findFillers, intersectRanges, parseSilences, rangeFromSeconds, silenceCuts, silenceFilter,
  subtractRanges, transcriptText, type CaptionOp,
} from "./ops-core";
import { readSettings } from "./paths";
import { atomicWrite, Store, type Meta } from "./store";

export interface Context {
  userData: string;
  store: () => Store;
  ff: Ff;
  bridge: Bridge;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface Done { text: string; data?: unknown; image?: Buffer; summary: string; takeId?: string; snap?: Awaited<ReturnType<typeof snapshot>> }

const MAX_TEXT = 100_000;
/** the longest one call waits: assistants give up on a tool call after about a minute */
const CALL_BUDGET_MS = 50_000;
const sec = (ms: number) => Math.round(ms / 10) / 100;
const fmt = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const ranges = (rs: TimeRange[]) => rs.map((r) => ({ start: sec(r.start), end: sec(r.end) }));
const cap = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n... (cut at ${MAX_TEXT} characters; ask for a smaller part)` : s);

const takeArg = z.string().default("latest").describe('The take id from list_takes, or "latest" for the newest take.');
const rangeArg = z.object({ start: z.number().describe("seconds on the take's own clock"), end: z.number().describe("seconds") });

/** Jobs this server runs itself (timeline exports with media copies, big imports). */
const localJobs = new Map<string, AssistantJob>();
/** caption jobs whose undo snapshot is written once they finish */
const pendingCaptions = new Map<string, Awaited<ReturnType<typeof snapshot>>>();

async function duration(ctx: Context, id: string, m: Meta): Promise<number> {
  if (m.durationMs && m.durationMs > 0) return m.durationMs;
  const f = ctx.store().track(id, m, "composite");
  const p = f ? await ctx.ff.probe(f) : null;
  if (p?.durationMs) return p.durationMs;
  throw new Error("This take's length is not known yet. Open it in OpenTake's editor once.");
}

/** The app reloads the take (its list and an open editor) if it is running. Never starts it. */
async function tellApp(ctx: Context, takeId: string) {
  await ctx.bridge.call("changed", { takeId }, 3000).catch(() => {});
}

function summaryOfCuts(keep: TimeRange[], durationMs: number) {
  const whole = isWhole(keep, durationMs);
  return { cut: !whole, kept: ranges(mergeTouching(keep)), length_s: sec(durationMs), edited_length_s: sec(keptDuration(keep)), removed_s: sec(durationMs - keptDuration(keep)) };
}

export function registerTools(server: McpServer, ctx: Context) {
  const tool = <S extends z.ZodRawShape>(name: string, o: { title: string; description: string; input: S; readOnly?: boolean; openWorld?: boolean }, fn: (a: z.infer<z.ZodObject<S>>) => Promise<Done>) => {
    server.registerTool(name, {
      title: o.title,
      description: o.description,
      inputSchema: o.input,
      annotations: { title: o.title, readOnlyHint: !!o.readOnly, destructiveHint: false, idempotentHint: !!o.readOnly, openWorldHint: !!o.openWorld },
    }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        const d = await fn(args);
        await record(ctx.userData, { tool: name, takeId: d.takeId, summary: d.summary, ok: true }, d.snap).catch(() => {});
        const content: Content[] = [];
        if (d.image) content.push({ type: "image", data: d.image.toString("base64"), mimeType: "image/png" });
        content.push({ type: "text", text: cap(d.data !== undefined ? `${d.text}\n\n${JSON.stringify(d.data, null, 1)}` : d.text) });
        return { content };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await record(ctx.userData, { tool: name, summary: tr("sum.failed", { detail: msg }).slice(0, 300), ok: false, takeId: typeof (args as { take?: unknown }).take === "string" ? String((args as { take: string }).take) : undefined }).catch(() => {});
        return { content: [{ type: "text" as const, text: msg }], isError: true };
      }
    }) as never);
  };

  /** A take id resolved, with its folder, meta and length. */
  const open = async (take: string) => {
    const s = ctx.store();
    const id = await s.resolve(take);
    const meta = await s.meta(id);
    return { s, id, dir: s.dir(id), meta, durationMs: await duration(ctx, id, meta) };
  };

  // ---------------- read ----------------

  tool("list_takes", {
    title: "List takes",
    description: "Lists the person's OpenTake recordings, newest first: id, title, when, length, mode (camera, screen, screen-camera), frame, and whether each has cuts, captions, chapters and exports. Start here; other tools take the id (or \"latest\").",
    input: { limit: z.number().int().min(1).max(200).default(30), search: z.string().optional().describe("only takes whose title or id contains this") },
    readOnly: true,
  }, async ({ limit, search }) => {
    const s = ctx.store();
    const out = [];
    for (const id of await s.ids()) {
      const m = await s.meta(id).catch(() => null);
      if (!m) continue;
      if (search && !`${m.title ?? ""} ${id}`.toLowerCase().includes(search.toLowerCase())) continue;
      const edit = await s.edit(id, m.durationMs);
      const caps = await s.captions(id);
      out.push({
        id, title: m.title ?? null, recorded: new Date(m.createdAt).toLocaleString(), length_s: m.durationMs != null ? sec(m.durationMs) : null,
        edited_length_s: edit && m.durationMs != null && !isWhole(edit.keep, m.durationMs) ? sec(keptDuration(edit.keep)) : null,
        mode: m.mode, frame: m.frame ? `${m.frame.width}x${m.frame.height}` : null, status: m.status,
        has: { cuts: !!edit && m.durationMs != null && !isWhole(edit.keep, m.durationMs), captions: (caps?.lines.length ?? 0) > 0, chapters: existsSync(s.file(id, "chapters.json")), separate_tracks: !!(m.containers.screen || m.containers.camera) },
        exports: (m.exports ?? []).filter((f) => existsSync(f)).length,
        ...(m.imported ? { imported: true } : {}),
      });
      if (out.length >= limit) break;
    }
    return { text: out.length ? `${out.length} take(s) in ${s.root}.` : `No takes in ${s.root} yet.`, data: out, summary: tr("sum.listed", { count: out.length }) };
  });

  tool("get_take", {
    title: "Get a take",
    description: "Everything about one take: files and sizes, frame, frame rate, length, clicks, scene switches, overlays drawn in, the current cuts (kept stretches in seconds on the take's own clock), the captions in short, chapters and exports. All times in OpenTake tools are seconds on the take's own recording clock unless a tool says otherwise.",
    input: { take: takeArg },
    readOnly: true,
  }, async ({ take }) => {
    const { s, id, dir, meta, durationMs } = await open(take);
    const tl = await s.timeline(id);
    const keep = await s.keep(id, durationMs);
    const caps = await s.captions(id);
    const words = caps?.lines.reduce((a, l) => a + l.words.length, 0) ?? 0;
    const files = await s.files(id);
    const data = {
      id, title: meta.title ?? null, folder: dir, recorded: new Date(meta.createdAt).toLocaleString(), status: meta.status, recovered: !!meta.recovered,
      mode: meta.mode, frame: meta.frame ?? null, fps: meta.fps, length_s: sec(durationMs),
      files: files.map((f) => ({ name: f.name, mb: Math.round(f.bytes / 1e4) / 100 })), size_mb: Math.round(files.reduce((a, f) => a + f.bytes, 0) / 1e4) / 100,
      tracks: { composite: !!s.track(id, meta, "composite"), screen: !!s.track(id, meta, "screen"), camera: !!s.track(id, meta, "camera"), system_sound: !!s.track(id, meta, "system") },
      clicks: { count: tl?.clicks.length ?? 0, real_clicks: tl?.hooks ?? false, first: (tl?.clicks ?? []).slice(0, 50).map((c) => sec(c.t)) },
      scene_switches: (tl?.scenes ?? []).map((x) => ({ at_s: sec(x.t), scene: x.scene })),
      overlays: tl?.overlays ?? [],
      zoom_on_clicks: tl?.layout.zoom.enabled ?? null,
      cuts: summaryOfCuts(keep, durationMs),
      captions: caps ? { lang: caps.lang, lines: caps.lines.length, words, starts_with: caps.lines.slice(0, 3).map((l) => l.words.map((w) => w.text).join(" ")) } : null,
      caption_style: await s.captionStyle(id),
      chapters: (await s.chapters(id, durationMs)).map((c) => ({ at_s: sec(c.t), title: c.title })),
      exports: (meta.exports ?? []).filter((f) => existsSync(f)),
    };
    return { text: `Take ${id}${meta.title ? ` "${meta.title}"` : ""}, ${fmt(durationMs)} long${data.cuts.cut ? `, ${fmt(keptDuration(keep))} after cuts` : ""}.`, data, summary: tr("sum.readTake"), takeId: id };
  });

  tool("get_transcript", {
    title: "Get the transcript",
    description: "The take's words with times, from its captions. If the take has no captions yet, OpenTake makes them on this computer (Vosk, English or Spanish) first; that can take a minute or two for a long take, and the tool may ask you to call it again. Each line shows [line_id start-end] text; edit_captions uses those ids. Set words to true for every word's time (for precise cuts).",
    input: {
      take: takeArg,
      lang: z.enum(["en", "es"]).optional().describe("the spoken language, when captions still have to be made (default en)"),
      remake: z.boolean().default(false).describe("make the captions again even if the take has some (the old ones can be undone back)"),
      words: z.boolean().default(false),
      from_line: z.number().int().min(0).default(0),
      max_lines: z.number().int().min(1).max(2000).default(400),
    },
    readOnly: false,
  }, async ({ take, lang, remake, words, from_line, max_lines }) => {
    const { s, id, dir } = await open(take);
    let caps = await s.captions(id);
    if (!caps?.lines.length || remake) {
      // one tool call stays under a minute (clients give up around there): what is left waits for get_job
      const t0 = Date.now();
      await ctx.bridge.ensure();
      const snap = await snapshot(id, dir, ["captions.json"]);
      const job = await ctx.bridge.call<AssistantJob>("transcribe", { takeId: id, lang: lang ?? caps?.lang ?? "en" });
      const done = await waitJob(ctx, job.id, Math.max(1000, CALL_BUDGET_MS - (Date.now() - t0)));
      if (!done.done) {
        pendingCaptions.set(job.id, snap);
        return { text: `Making captions for ${id}: ${done.stage}${done.ratio != null ? ` (${Math.round(done.ratio * 100)}%)` : ""}. Call get_transcript again in a minute, or get_job with job_id ${job.id}.`, summary: tr("sum.captionsStarted"), takeId: id };
      }
      if (done.error) throw new Error(`Could not make captions: ${done.error}`);
      caps = await s.captions(id);
      await tellApp(ctx, id);
      if (!caps?.lines.length) return { text: "OpenTake listened to the take and heard no words.", summary: tr("sum.captionsEmpty"), takeId: id, snap };
      return { text: transcriptOut(caps.lines, caps.lang, words, from_line, max_lines), summary: tr("sum.captionsMade", { count: caps.lines.length }), takeId: id, snap };
    }
    return { text: transcriptOut(caps.lines, caps.lang, words, from_line, max_lines), summary: tr("sum.readTranscript", { count: caps.lines.length }), takeId: id };
  });

  tool("get_frame", {
    title: "See a frame",
    description: "A picture of the take at one moment, as a PNG you can look at (downscaled, 1280 wide by default). Use it to see what is on screen before cutting or naming chapters. `at` is seconds on the take's own clock, or on the edited result with timeline set to edited.",
    input: { take: takeArg, at: z.number().min(0).describe("seconds"), timeline: z.enum(["take", "edited"]).default("take"), width: z.number().int().min(160).max(1920).default(1280) },
    readOnly: true,
  }, async ({ take, at, timeline, width }) => {
    const { s, id, meta, durationMs } = await open(take);
    let ms = Math.round(at * 1000);
    if (timeline === "edited") ms = toSource(ms, mergeTouching(await s.keep(id, durationMs)));
    ms = Math.min(ms, Math.max(0, durationMs - 50));
    const composite = s.track(id, meta, "composite");
    if (!composite) throw new Error("This take has no recording file");
    const png = await ctx.ff.frame(await seekableCopy(ctx, s.dir(id), composite, meta), ms, width, true);
    return { text: `Frame of ${id} at ${sec(ms)} s on the take's clock.`, image: png, summary: tr("sum.frame", { at: sec(ms) }), takeId: id };
  });

  tool("find_moments", {
    title: "Find moments",
    description: "Finds places worth cutting or marking: silences (with a threshold), long pauses, filler words (um, uh, eh, este, o sea... from the captions; make captions first with get_transcript), scene switches and bursts of clicks. Times are seconds on the take's clock. Nothing is changed.",
    input: {
      take: takeArg,
      kinds: z.array(z.enum(["silences", "fillers", "scenes", "clicks"])).default(["silences", "fillers", "scenes", "clicks"]),
      silence_db: z.number().min(-90).max(-10).default(-35).describe("quieter than this counts as silence"),
      min_silence_s: z.number().min(0.1).max(30).default(0.6),
      long_pause_s: z.number().min(0.3).max(60).default(1.5),
      include_maybe_fillers: z.boolean().default(false).describe('also words that are often fillers but can be real words ("like", "so", "pues", "bueno")'),
    },
    readOnly: true,
  }, async ({ take, kinds, silence_db, min_silence_s, long_pause_s, include_maybe_fillers }) => {
    const { s, id, meta, durationMs } = await open(take);
    const out: Record<string, unknown> = {};
    const notes: string[] = [];
    if (kinds.includes("silences")) {
      const composite = s.track(id, meta, "composite");
      const sil = composite ? parseSilences(await ctx.ff.silences(composite, silenceFilter(silence_db, min_silence_s * 1000)), durationMs) : [];
      out.silences = sil.slice(0, 500).map((r) => ({ start: sec(r.start), end: sec(r.end), length_s: sec(r.end - r.start), long_pause: r.end - r.start >= long_pause_s * 1000 }));
      out.silence_total_s = sec(sil.reduce((a, r) => a + r.end - r.start, 0));
    }
    if (kinds.includes("fillers")) {
      const caps = await s.captions(id);
      if (!caps?.lines.length) notes.push("No captions yet, so no filler words: call get_transcript first.");
      else out.fillers = findFillers(caps.lines, caps.lang, { maybe: include_maybe_fillers }).slice(0, 500).map((f) => ({ start: sec(f.start), end: sec(f.end), text: f.text, line_id: f.lineId, sure: f.sure }));
    }
    const tl = await s.timeline(id);
    if (kinds.includes("scenes")) out.scene_switches = (tl?.scenes ?? []).map((x) => ({ at: sec(x.t), scene: x.scene }));
    if (kinds.includes("clicks")) out.click_bursts = clickBursts(tl?.clicks ?? []).slice(0, 200).map((b) => ({ start: sec(b.start), end: sec(b.end), clicks: b.clicks }));
    return { text: [`Moments in ${id} (${fmt(durationMs)} long).`, ...notes].join(" "), data: out, summary: tr("sum.moments", { kinds: kinds.join(", ") }), takeId: id };
  });

  // ---------------- edit ----------------

  /** Saves new cuts with an undo snapshot and tells the app. */
  const saveCuts = async (take: string, next: (keep: TimeRange[], durationMs: number, id: string) => Promise<{ keep: TimeRange[]; what: string }> | { keep: TimeRange[]; what: string }, dryRun = false): Promise<Done> => {
    const { s, id, dir, durationMs } = await open(take);
    const before = await s.keep(id, durationMs);
    const r = await next(before, durationMs, id);
    if (!r.keep.length) throw new Error("That would cut the whole take. An edit has to keep something.");
    const result = { before: summaryOfCuts(before, durationMs).edited_length_s, ...summaryOfCuts(r.keep, durationMs) };
    if (dryRun) return { text: `Not saved (dry run): ${r.what}. The edit would be ${fmt(keptDuration(r.keep))} long.`, data: result, summary: tr("sum.tried", { what: r.what }), takeId: id };
    const snap = await snapshot(id, dir, ["edit.json"]);
    await s.writeEdit(id, r.keep, durationMs);
    await tellApp(ctx, id);
    return { text: `${r.what}. The edit is now ${fmt(keptDuration(r.keep))} long (was ${fmt(keptDuration(before))}). The take's files are untouched; undo_change or the editor can put it back.`, data: result, summary: tr("sum.cut", { what: r.what, from: fmt(keptDuration(before)), to: fmt(keptDuration(r.keep)) }), takeId: id, snap };
  };

  tool("set_cuts", {
    title: "Set the cuts",
    description: "Replaces the take's whole edit with exactly these kept stretches (seconds on the take's clock), in order. reset puts the whole take back. Use cut_ranges or keep_ranges to change the current edit instead.",
    input: { take: takeArg, keep: z.array(rangeArg).max(2000).default([]), reset: z.boolean().default(false) },
  }, async ({ take, keep, reset }) => saveCuts(take, (_k, d) => {
    if (reset) return { keep: wholeTake(d), what: tr("sum.wholeBack") };
    if (!keep.length) throw new Error("Give the stretches to keep, or reset: true for the whole take");
    return { keep: keep.map((r) => rangeFromSeconds(r, d)), what: tr("sum.setKept", { count: keep.length }) };
  }));

  tool("cut_ranges", {
    title: "Cut ranges",
    description: "Cuts these stretches (seconds on the take's clock) out of the current edit. Only the edit changes; the recording stays whole.",
    input: { take: takeArg, ranges: z.array(rangeArg).min(1).max(2000) },
  }, async ({ take, ranges: rs }) => saveCuts(take, (k, d) => ({ keep: subtractRanges(k, rs.map((r) => rangeFromSeconds(r, d)), d), what: tr("sum.cutParts", { count: rs.length }) })));

  tool("keep_ranges", {
    title: "Keep only ranges",
    description: "Keeps only these stretches (seconds on the take's clock) of what the edit keeps now, and cuts the rest. Good for picking the best 60 seconds.",
    input: { take: takeArg, ranges: z.array(rangeArg).min(1).max(2000) },
  }, async ({ take, ranges: rs }) => saveCuts(take, (k, d) => ({ keep: intersectRanges(k, rs.map((r) => rangeFromSeconds(r, d)), d), what: tr("sum.keptOnly", { count: rs.length }) })));

  tool("remove_silences", {
    title: "Remove silences",
    description: "Cuts the silent stretches out of the edit, leaving a short natural pause so words are not clipped. dry_run shows what it would do without saving.",
    input: {
      take: takeArg,
      min_silence_s: z.number().min(0.2).max(30).default(0.7).describe("only pauses at least this long are cut"),
      keep_pause_s: z.number().min(0).max(2).default(0.25).describe("how much of each pause stays"),
      silence_db: z.number().min(-90).max(-10).default(-35),
      dry_run: z.boolean().default(false),
    },
  }, async ({ take, min_silence_s, keep_pause_s, silence_db, dry_run }) => saveCuts(take, async (k, d, id) => {
    const s = ctx.store();
    const composite = s.track(id, await s.meta(id), "composite");
    if (!composite) throw new Error("This take has no recording file");
    const sil = parseSilences(await ctx.ff.silences(composite, silenceFilter(silence_db, Math.min(min_silence_s * 1000, 400))), d);
    const cuts = silenceCuts(sil, { minMs: min_silence_s * 1000, keepMs: keep_pause_s * 1000 });
    return { keep: subtractRanges(k, cuts, d), what: tr("sum.silences", { count: cuts.length }) };
  }, dry_run));

  tool("remove_filler_words", {
    title: "Remove filler words",
    description: "Cuts filler words (um, uh, er, eh, este, o sea...) found in the captions out of the edit. Needs captions (get_transcript makes them). include_maybe also cuts words that are often fillers but can be real words; extra_words adds your own. dry_run shows what it would cut.",
    input: {
      take: takeArg,
      include_maybe: z.boolean().default(false),
      extra_words: z.array(z.string().max(40)).max(50).default([]),
      pad_s: z.number().min(0).max(0.5).default(0.06),
      dry_run: z.boolean().default(false),
    },
  }, async ({ take, include_maybe, extra_words, pad_s, dry_run }) => saveCuts(take, async (k, d, id) => {
    const caps = await ctx.store().captions(id);
    if (!caps?.lines.length) throw new Error("This take has no captions yet. Call get_transcript first, then try again.");
    const fillers = findFillers(caps.lines, caps.lang, { maybe: include_maybe, extra: extra_words });
    const cuts = fillerCuts(fillers, caps.lines, pad_s * 1000);
    const kinds = [...new Set(fillers.map((f) => f.text.toLowerCase()))].slice(0, 8).join(", ");
    return { keep: subtractRanges(k, cuts, d), what: `${tr("sum.fillers", { count: cuts.length })}${kinds ? ` (${kinds})` : ""}` };
  }, dry_run));

  tool("edit_captions", {
    title: "Edit captions",
    description: "Fixes the captions, in order: replace_text (a line's new text), find_replace (a word or phrase everywhere; whole words unless whole_word is false), split (before word N of a line, counting from 0), merge_with_next, retime (start or end in seconds, or shift by seconds) and delete. Line ids come from get_transcript. The editor shows the result and it can be undone.",
    input: {
      take: takeArg,
      changes: z.array(z.discriminatedUnion("op", [
        z.object({ op: z.literal("replace_text"), line_id: z.string(), text: z.string().max(500) }),
        z.object({ op: z.literal("find_replace"), find: z.string().min(1).max(200), replace: z.string().max(200), whole_word: z.boolean().optional(), match_case: z.boolean().optional() }),
        z.object({ op: z.literal("split"), line_id: z.string(), before_word: z.number().int() }),
        z.object({ op: z.literal("merge_with_next"), line_id: z.string() }),
        z.object({ op: z.literal("retime"), line_id: z.string(), start: z.number().optional(), end: z.number().optional(), shift: z.number().optional() }),
        z.object({ op: z.literal("delete"), line_id: z.string() }),
      ])).min(1).max(500),
    },
  }, async ({ take, changes }) => {
    const { s, id, dir } = await open(take);
    const caps = await s.captions(id);
    if (!caps?.lines.length) throw new Error("This take has no captions yet. Call get_transcript first.");
    const r = applyCaptionOps(caps.lines, changes as CaptionOp[]);
    if (!r.applied) throw new Error(`Nothing changed. ${r.problems.join(". ")}`);
    const snap = await snapshot(id, dir, ["captions.json"]);
    await s.writeCaptions(id, { version: 1, lang: caps.lang, lines: r.lines });
    await tellApp(ctx, id);
    return { text: `Made ${r.applied} of ${changes.length} caption change(s).${r.problems.length ? ` Skipped: ${r.problems.join(". ")}.` : ""}`, summary: tr("sum.captionsEdited", { count: r.applied }), takeId: id, snap };
  });

  tool("set_caption_style", {
    title: "Set the caption style",
    description: "How burned-in captions look on this take's exports: clean (white with a shadow), boxed (on a dark box) or social (big words, the spoken word highlighted), at the top or bottom, margin as a fraction of the height. export_take uses it when burn_captions is on.",
    input: { take: takeArg, style: z.enum(["clean", "boxed", "social"]), position: z.enum(["bottom", "top"]).default("bottom"), margin: z.number().min(0).max(0.4).default(0.08) },
  }, async ({ take, style, position, margin }) => {
    const { s, id, dir } = await open(take);
    const snap = await snapshot(id, dir, ["caption-style.json"]);
    await s.writeCaptionStyle(id, { style, position, margin });
    return { text: `Captions on ${id} will be ${style}, at the ${position}.`, summary: tr("sum.captionStyle", { style, position: position === "top" ? tr("sum.top") : tr("sum.bottom") }), takeId: id, snap };
  });

  tool("set_title", {
    title: "Set the title",
    description: "Gives the take a title (one line, up to 80 characters; empty clears it). The folder keeps its date name; export file names use the title.",
    input: { take: takeArg, title: z.string().max(200) },
  }, async ({ take, title }) => {
    const { s, id, dir } = await open(take);
    const snap = await snapshot(id, dir, [TITLE]);
    const t = await s.setTitle(id, title);
    await tellApp(ctx, id);
    return { text: t ? `The take is now called "${t}".` : "The take has no title now.", summary: t ? tr("sum.title", { title: t }) : tr("sum.titleCleared"), takeId: id, snap };
  });

  tool("add_chapters", {
    title: "Add chapters",
    description: "Names moments of the take as chapters (seconds on the take's clock), saved beside it (chapters.json) and written as markers in timeline exports. Returns the chapter list on the edited timeline, ready for a YouTube description (YouTube needs the first at 0:00 and each at least 10 s long). replace swaps the whole list.",
    input: { take: takeArg, chapters: z.array(z.object({ at: z.number().min(0), title: z.string().min(1).max(100) })).min(1).max(100), replace: z.boolean().default(false) },
  }, async ({ take, chapters, replace }) => {
    const { s, id, dir, durationMs } = await open(take);
    const old = replace ? [] : await s.chapters(id, durationMs);
    const next = cleanChapters([...old, ...chapters.map((c) => ({ t: Math.round(c.at * 1000), title: c.title }))], durationMs);
    const snap = await snapshot(id, dir, ["chapters.json"]);
    await s.writeChapters(id, next);
    const keep = mergeTouching(await s.keep(id, durationMs));
    const youtube = next.map((c) => ({ c, at: toEdited(c.t, keep) })).filter((x) => x.at != null).map((x) => `${fmt(x.at!)} ${x.c.title}`);
    const dropped = next.length - youtube.length;
    return {
      text: `${next.length} chapter(s) on ${id}.${dropped ? ` ${dropped} fall in cut stretches and are left out of the list below.` : ""}\n\nFor YouTube:\n${youtube.join("\n")}`,
      data: next.map((c) => ({ at_s: sec(c.t), title: c.title })), summary: tr("sum.chapters", { count: next.length }), takeId: id, snap,
    };
  });

  tool("undo_change", {
    title: "Undo a change",
    description: "Undoes one change the assistant made (cuts, captions, title, chapters, caption style), by its change id from the activity list, or the most recent one. It is refused when the take was changed again afterwards, so nothing done by hand is lost.",
    input: { change_id: z.string().optional() },
  }, async ({ change_id }) => {
    const list = await readActivity(ctx.userData, 500);
    const target = change_id ?? list.find((e) => e.undoable && !e.undoneAt && e.tool !== "undo_change")?.id;
    if (!target) throw new Error("There is no change to undo.");
    const r = await undo(ctx.userData, target);
    if (!r.ok) throw new Error(r.message);
    if (r.takeId) await tellApp(ctx, r.takeId);
    return { text: r.message, summary: r.message, takeId: r.takeId };
  });

  // ---------------- export ----------------

  tool("export_take", {
    title: "Export a video",
    description: "Exports the take as a video with its cuts, in the app (the person sees the progress there). Presets: original, youtube (1920x1080), vertical (1080x1920 for Reels, TikTok, Shorts), square, linkedin, x, custom (width and height). Formats mp4, webm, gif. Quality by crf (18 best to 28 small) or a target size in MB. burn_captions draws the captions in (make them first). The file goes where the person's Settings say, under a new name: nothing is overwritten. Returns a job id for get_job.",
    input: {
      take: takeArg,
      preset: z.enum(["original", "youtube", "vertical", "square", "linkedin", "x", "custom"]).default("original"),
      format: z.enum(["mp4", "webm", "gif"]).default("mp4"),
      width: z.number().int().min(16).max(7680).optional().describe("custom preset only"),
      height: z.number().int().min(16).max(7680).optional(),
      fit: z.enum(["fit", "fill"]).default("fill").describe("when the shape differs: fit inside with bars, or fill and crop"),
      crf: z.number().int().min(14).max(35).optional(),
      target_mb: z.number().min(1).max(4000).optional().describe("instead of crf: aim for this file size (two passes)"),
      burn_captions: z.boolean().default(false),
      caption_style: z.enum(["clean", "boxed", "social"]).optional(),
      caption_position: z.enum(["bottom", "top"]).optional(),
      kind: z.enum(["composite", "hires"]).default("composite").describe("hires re-renders the screen track at full resolution (not for takes with scene switches)"),
      loudness: z.enum(["off", "-14", "-16"]).default("-14").describe("normalise loudness to -14 LUFS (social, YouTube) or -16"),
      trim_silence: z.boolean().default(false).describe("also trim silence at the very start and end"),
      use_cuts: z.boolean().default(true),
      gif_fps: z.number().int().min(5).max(30).default(15),
      gif_width: z.number().int().min(160).max(1280).default(480),
      wait_s: z.number().min(0).max(45).default(20).describe("wait up to this long for it to finish before returning the job"),
    },
  }, async (a) => {
    const { s, id } = await open(a.take);
    let burn: CaptionBurn | null = null;
    if (a.burn_captions) {
      if (!(await s.captions(id))?.lines.length) throw new Error("This take has no captions yet. Call get_transcript first, then export.");
      const saved = await s.captionStyle(id);
      burn = parseCaptionStyle({ ...(saved ?? { style: "clean", position: "bottom", margin: 0.08 }), ...(a.caption_style ? { style: a.caption_style } : {}), ...(a.caption_position ? { position: a.caption_position } : {}) });
    }
    if (a.preset === "custom" && (!a.width || !a.height)) throw new Error("The custom preset needs a width and a height");
    const output: ExportOutput = {
      preset: a.preset, format: a.format, fit: a.fit,
      ...(a.preset === "custom" ? { width: a.width, height: a.height } : {}),
      quality: a.target_mb ? { mode: "size", mb: a.target_mb } : { mode: "crf", crf: a.crf ?? 20 },
      gif: { fps: a.gif_fps, width: a.gif_width },
      captions: burn,
    };
    const options: ExportOptions = { takeId: id, kind: a.kind, loudness: a.loudness, trimSilence: a.trim_silence, useEdit: a.use_cuts, output, manual: false };
    const t0 = Date.now();
    await ctx.bridge.ensure();
    const job = await ctx.bridge.call<AssistantJob>("export", { options });
    const now = a.wait_s > 0 ? await waitJob(ctx, job.id, Math.min(a.wait_s * 1000, Math.max(0, CALL_BUDGET_MS - (Date.now() - t0)))) : job;
    if (now.done && now.error) throw new Error(now.error);
    return {
      text: now.done ? `Exported: ${now.output?.join(", ")}` : `Exporting ${id} (${now.stage}${now.ratio != null ? `, ${Math.round(now.ratio * 100)}%` : ""}). Call get_job with job_id ${job.id} to follow it.`,
      data: jobOut(now), summary: tr(burn ? "sum.exportCaptions" : "sum.export", { preset: a.preset, format: a.format }), takeId: id,
    };
  });

  tool("get_job", {
    title: "Follow a job",
    description: "How an export, a caption job, an import or a timeline export is doing: stage, progress, the files it wrote, or the error. wait_s waits for it to finish.",
    input: { job_id: z.string().min(1).max(80), wait_s: z.number().min(0).max(45).default(0) },
    readOnly: true,
  }, async ({ job_id, wait_s }) => {
    const j = await waitJob(ctx, job_id, wait_s * 1000);
    const snap = pendingCaptions.get(job_id);
    if (j.done && snap) {
      pendingCaptions.delete(job_id);
      if (!j.error) await record(ctx.userData, { tool: "get_transcript", takeId: j.takeId, summary: tr("sum.captionsMade", { count: (await ctx.store().captions(j.takeId).catch(() => null))?.lines.length ?? 0 }), ok: true }, snap).catch(() => {});
    }
    return { text: j.done ? (j.error ? `Failed: ${j.error}` : `Done.${j.output?.length ? ` Files: ${j.output.join(", ")}` : ""}`) : `${j.stage}${j.ratio != null ? ` (${Math.round(j.ratio * 100)}%)` : ""}`, data: jobOut(j), summary: tr("sum.job", { stage: j.done ? (j.error ? tr("as.failed") : tr("main.export.done")) : j.stage }), takeId: j.takeId };
  });

  tool("export_timeline", {
    title: "Open in an editor",
    description: "Writes the take as an editor timeline: an OpenTimelineIO file (.otio) for FilmCraft, DaVinci Resolve, Premiere (via its OTIO support) and others, plus FCPXML 1.10 for Final Cut Pro and Resolve when fcpxml is on, and the captions as .srt. Clips follow the cuts; clicks, scene switches, chapters and captions become markers. layout separate puts the screen, the camera and the computer sound on their own tracks. compatible_media makes MP4 copies of WebM tracks (Premiere and Final Cut cannot read WebM); it takes a while and runs as a job. Media stay where they are; the timeline points at them.",
    input: {
      take: takeArg,
      layout: z.enum(["composite", "separate"]).default("composite"),
      fcpxml: z.boolean().default(false),
      compatible_media: z.boolean().default(false),
      use_cuts: z.boolean().default(true),
      click_markers: z.boolean().default(true),
      scene_markers: z.boolean().default(true),
      caption_markers: z.boolean().default(true),
    },
  }, async (a) => {
    const { s, id, dir, meta, durationMs } = await open(a.take);
    const take: TimelineTake = {
      id, dir, title: meta.title, createdAt: meta.createdAt, durationMs, fps: meta.fps, frame: meta.frame, containers: meta.containers,
      timeline: await s.timeline(id), edit: await s.edit(id, durationMs), captions: await s.captions(id), chapters: await s.chapters(id, durationMs),
    };
    const opts = { layout: a.layout, fcpxml: a.fcpxml, compatibleMedia: a.compatible_media, useEdit: a.use_cuts, clickMarkers: a.click_markers, sceneMarkers: a.scene_markers, captionMarkers: a.caption_markers };
    const settings = readSettings(ctx.userData);
    const runIt = async (onStage?: (st: string) => void) => {
      const r = await exportTimeline(take, (args, onStdout) => ctx.ff.run(args, onStdout), settings, opts, onStage);
      await s.recordExports(id, [r.otio, ...(r.fcpxml ? [r.fcpxml] : []), ...(r.srt ? [r.srt] : [])]);
      await tellApp(ctx, id);
      return r;
    };
    const describe = (r: Awaited<ReturnType<typeof runIt>>) =>
      `Wrote ${r.otio}${r.fcpxml ? ` and ${r.fcpxml}` : ""}${r.srt ? ` and ${r.srt}` : ""}: ${r.clips} clip(s) on ${r.layout} tracks, ${r.markers} marker(s), ${r.captions} caption(s), ${fmt((r.frames / r.fps) * 1000)} at ${r.fps} fps.${r.notes.length ? ` ${r.notes.join(" ")}` : ""} Open the .otio in FilmCraft or DaVinci Resolve (File, Import, Timeline).`;
    if (!a.compatible_media) {
      const r = await runIt();
      return { text: describe(r), data: r, summary: tr("sum.timeline", { file: basename(r.otio) }), takeId: id };
    }
    const job: AssistantJob = { id: `local-${Date.now().toString(36)}`, kind: "timeline", takeId: id, stage: "Starting", ratio: null, done: false, startedAt: Date.now() };
    localJobs.set(job.id, job);
    void runIt((st) => { job.stage = st; }).then(
      (r) => Object.assign(job, { done: true, stage: describe(r), output: [r.otio, ...(r.fcpxml ? [r.fcpxml] : []), ...(r.srt ? [r.srt] : [])], finishedAt: Date.now() }),
      (e) => Object.assign(job, { done: true, stage: "Failed", error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() }),
    );
    const now = await waitJob(ctx, job.id, 45_000);
    if (now.done && now.error) throw new Error(now.error);
    return { text: now.done ? now.stage : `Making editor-friendly copies (${now.stage}). Call get_job with job_id ${job.id}.`, data: jobOut(now), summary: tr("sum.timelineMp4"), takeId: id };
  });

  // ---------------- import ----------------

  tool("import_video", {
    title: "Import a video",
    description: "Copies a video file the person names (an absolute path) into the recordings folder as a new take, so it can be cut, captioned and exported like a recording. The original is never moved or changed. MP4 and WebM are copied as they are; MOV, MKV, M4V and AVI are rewrapped (or converted) to MP4.",
    input: { path: z.string().min(3).max(1000).describe("the full path of the video file"), title: z.string().max(80).optional() },
    openWorld: true,
  }, async ({ path, title }) => {
    const job = await importVideo(ctx, path, title);
    const now = await waitJob(ctx, job.id, 45_000);
    if (now.done && now.error) throw new Error(now.error);
    return { text: now.done ? `Imported as take ${now.takeId}.` : `Importing (${now.stage}). Call get_job with job_id ${job.id}.`, data: jobOut(now), summary: tr("sum.imported", { file: basename(path) }), takeId: now.takeId || undefined };
  });

  // ---------------- prompts ----------------

  server.registerPrompt("tighten_last_take", {
    title: "Tighten my last take",
    description: "Cut the silences and filler words out of the newest take and say how much shorter it got.",
  }, () => ({ messages: [{ role: "user", content: { type: "text", text: "Tighten my latest OpenTake take. Call get_take, then get_transcript (make captions if needed), then find_moments. Remove silences longer than 0.7 s with remove_silences (keep 0.25 s of pause) and the sure filler words with remove_filler_words. Tell me the length before and after, and what you cut. Do not export yet." } }] }));

  server.registerPrompt("vertical_60s_with_captions", {
    title: "Make a 60 s vertical cut with captions",
    description: "Pick the best 60 seconds of a take and export it for Reels, TikTok and Shorts with captions burned in.",
    argsSchema: { take: z.string().optional().describe('take id, default "latest"') },
  }, ({ take }) => ({ messages: [{ role: "user", content: { type: "text", text: `Make a vertical cut of about 60 seconds from OpenTake take ${take ?? "latest"}. Read get_take and get_transcript (make captions if needed), look at a few frames with get_frame, then choose the strongest 60 seconds that stand on their own: a clear opening line and a clean ending. Use keep_ranges for it, remove_filler_words, fix obvious caption mistakes with edit_captions, set_caption_style to social at the bottom, then export_take with preset vertical, burn_captions on, loudness -14. Tell me what you kept and why, and where the file went.` } }] }));

  server.registerPrompt("clean_up_ums_and_pauses", {
    title: "Clean up ums and pauses",
    description: "Find the ums, uhs and long pauses, show them, and cut them after you agree.",
    argsSchema: { take: z.string().optional() },
  }, ({ take }) => ({ messages: [{ role: "user", content: { type: "text", text: `In OpenTake take ${take ?? "latest"}, find the filler words and long pauses (get_transcript first if there are no captions, then find_moments). Show me the list with times. Then run remove_filler_words and remove_silences with dry_run so I can see the new length, and only save after I say yes.` } }] }));
}

/**
 * A copy of a WebM composite with an index, so a frame anywhere is found at once (MediaRecorder files
 * have none, and decoding an hour to reach its end is too slow). It is the editor's own preview file,
 * made the same way (no re-encoding) and shared with it.
 */
async function seekableCopy(ctx: Context, dir: string, composite: string, meta: Meta): Promise<string> {
  if (composite.endsWith(".mp4") || meta.status === "recording") return composite;
  const preview = join(dir, "preview.webm");
  if (existsSync(preview) && (await stat(preview)).mtimeMs >= (await stat(composite)).mtimeMs) return preview;
  if ((await ctx.ff.probe(composite)).durationMs != null) return composite;
  const tmp = join(dir, "preview.tmp.webm");
  const r = await ctx.ff.run(["-nostdin", "-y", "-hide_banner", "-i", composite, "-map", "0", "-c", "copy", tmp]);
  if (r.code !== 0) { await rm(tmp, { force: true }); return composite; }
  await rename(tmp, preview);
  return preview;
}

function transcriptOut(lines: Parameters<typeof transcriptText>[0], lang: CaptionLang, words: boolean, from: number, max: number): string {
  const part = lines.slice(from, from + max);
  const head = `${lines.length} caption line(s), language ${lang}, times in seconds on the take's clock${part.length < lines.length ? `; lines ${from} to ${from + part.length - 1} shown, use from_line for more` : ""}.`;
  if (!words) return `${head}\n\n${transcriptText(part)}`;
  return `${head}\n\n${part.map((l) => `[${l.id}] ${l.words.map((w) => `${w.text}@${sec(w.start)}-${sec(w.end)}`).join(" ")}`).join("\n")}`;
}

const jobOut = (j: AssistantJob) => ({ job_id: j.id, kind: j.kind, take: j.takeId, stage: j.stage, progress: j.ratio, done: j.done, error: j.error ?? null, files: j.output ?? [] });

async function getJob(ctx: Context, id: string): Promise<AssistantJob> {
  const local = localJobs.get(id);
  if (local) return local;
  if (id.startsWith("local-")) throw new Error("That job is not known (the assistant may have been restarted).");
  try { return await ctx.bridge.call<AssistantJob>("job", { id }); } catch (e) {
    if (e instanceof AppNotRunning) throw new Error("OpenTake is not running, so that job stopped with it.");
    throw e;
  }
}

async function waitJob(ctx: Context, id: string, ms: number): Promise<AssistantJob> {
  const until = Date.now() + ms;
  for (;;) {
    const j = await getJob(ctx, id);
    if (j.done || Date.now() >= until) return j;
    await new Promise((r) => setTimeout(r, 700));
  }
}

const IMPORT_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi"]);
const MAX_IMPORT_BYTES = 20 * 1024 ** 3;

/** import_video's work: checked, copied (never moved), probed, and listed as a new take. */
async function importVideo(ctx: Context, path: string, title?: string): Promise<AssistantJob> {
  if (!isAbsolute(path)) throw new Error("Give the full path of the video file, like C:\\Users\\you\\Videos\\clip.mp4");
  const src = resolve(path);
  const ext = extname(src).toLowerCase();
  if (!IMPORT_EXT.has(ext)) throw new Error(`OpenTake imports ${[...IMPORT_EXT].join(", ")} files`);
  let st;
  try { st = await stat(src); } catch { throw new Error(`There is no file at ${src}`); }
  if (!st.isFile()) throw new Error(`${src} is not a file`);
  if (st.size > MAX_IMPORT_BYTES) throw new Error("That file is over 20 GB, which is more than OpenTake imports");
  const root = ctx.store().root;
  if (isInside(src, root, process.platform === "win32")) throw new Error("That file is already inside the recordings folder");
  const p = await ctx.ff.probe(src);
  if (!p.video) throw new Error("That file has no video OpenTake can read");
  if (!p.durationMs) throw new Error("The length of that video cannot be read");
  await mkdir(root, { recursive: true });
  try {
    const fsInfo = await statfs(root);
    if (Number(fsInfo.bavail) * Number(fsInfo.bsize) < st.size * 1.2 + 200e6) throw new Error("There is not enough free space in the recordings folder for this video");
  } catch (e) { if (e instanceof Error && /free space/.test(e.message)) throw e; }

  const created = Math.round(st.mtimeMs) || Date.now();
  const base = takeFolderName(new Date(created));
  let id = base;
  for (let i = 2; existsSync(join(root, id)); i++) id = `${base} (${i})`;
  const dir = join(root, id);
  const job: AssistantJob = { id: `local-${Date.now().toString(36)}i`, kind: "export", takeId: id, stage: "Copying", ratio: null, done: false, startedAt: Date.now() };
  localJobs.set(job.id, job);

  const work = async () => {
    await mkdir(dir);
    let container = ext === ".mp4" || ext === ".webm" ? ext.slice(1) : "mp4";
    const target = join(dir, `composite.${container}`);
    if (ext === ".mp4" || ext === ".webm") {
      await copyFile(src, target, fsc.COPYFILE_EXCL);
    } else {
      job.stage = "Rewrapping to MP4";
      let r = await ctx.ff.run(["-nostdin", "-hide_banner", "-n", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", target]);
      if (r.code !== 0) {
        await rm(target, { force: true });
        job.stage = "Converting to MP4";
        r = await ctx.ff.run(["-nostdin", "-hide_banner", "-n", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", target]);
        if (r.code !== 0) { await rm(target, { force: true }); throw new Error("That video could not be converted"); }
      }
      container = "mp4";
    }
    const fps = Number(/, ([\d.]+) fps/.exec(p.stderr)?.[1]) || 30;
    const meta: Meta = {
      id, createdAt: created, status: "done", mode: "screen", durationMs: p.durationMs, containers: { composite: container }, fps: Math.round(fps * 100) / 100,
      frame: p.width && p.height ? { width: p.width, height: p.height } : undefined, title: (title ?? basename(src, ext)).slice(0, 80) || undefined,
      imported: { from: src, at: Date.now() },
    };
    await atomicWrite(join(dir, "take.json"), JSON.stringify(meta, null, 2));
    await tellApp(ctx, id);
    Object.assign(job, { done: true, stage: "Imported", output: [target], finishedAt: Date.now() });
  };
  void work().catch(async (e) => {
    // a take folder that never got its take.json is not left half made
    if (!existsSync(join(dir, "take.json"))) await rename(dir, `${dir}.failed-import`).catch(() => {});
    Object.assign(job, { done: true, stage: "Failed", error: e instanceof Error ? e.message : String(e), finishedAt: Date.now() });
  });
  return job;
}

