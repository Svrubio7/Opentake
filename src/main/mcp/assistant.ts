// The assistant in the app: the local bridge the MCP server calls (captions, exports, live refresh), the
// note it reads at start (app.json), the Settings section that connects Claude or Codex, the activity
// list with Undo, and "Open in an editor". Started with --assistant, the app runs with no window and
// quits by itself after 10 quiet minutes; opening OpenTake normally then shows the window.
import { app, globalShortcut, ipcMain, type BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APP_INFO_FILE, type AppInfo, type AssistantStatus, type SetupResult, type TestResult } from "../../shared/assistant";
import { IPC } from "../../shared/ipc";
import type { CaptionLang, ExportOptions } from "../../shared/types";
import { revealFile } from "../dialogs";
import { defaultRecordingsDir, getSettings } from "../settings";
import { exportsRunning, exportTake, cancelExport, ffmpegPath } from "../record/export";
import { readCaptions, readEdit, writeCaptions } from "../record/editor-store";
import { runWatched } from "../record/ffmpeg-run";
import { validTakeId } from "../record/ffmpeg-core";
import { parseChapters } from "../record/take-extras";
import { exportTimeline, type TimelineOptions } from "../record/timeline-export";
import { forgetTake, readMeta, readTimeline, recordExport, takeDir } from "../record/takes";
import { readActivity, undo } from "./activity";
import { Jobs, startBridge, type BridgeHandle } from "./bridge-server";
import { backupName, claudeCodeCommand, claudeDesktopConfigPaths, codexConfigPath, codexToml, isConfigured, mergeClaudeDesktop, serverLaunch, SERVER_FILE } from "./setup-core";
import { registerTranscriber, transcribeTake } from "./transcriber";
import { SHORTCUTS as RECORD_KEYS } from "../record";
import { SHORTCUT as DRAW_KEY } from "../draw";
import { SHORTCUTS as PROMPTER_KEYS } from "../teleprompter";

/** Every global shortcut the app can hold, so ping can say none is held in a background start. */
const allShortcuts = () => [...Object.keys(RECORD_KEYS), DRAW_KEY, "Escape", ...PROMPTER_KEYS.map(([k]) => k)];

const IDLE_QUIT_MS = 10 * 60_000;

let bridge: BridgeHandle | null = null;
let background = false;
let shownOnce = false;
const jobs = new Jobs();

/** In background mode, closing the hidden captions window must not quit the app. */
export const keepRunningWithoutWindows = () => background && !shownOnce;
/** The main window was created (the person opened OpenTake): background rules end. */
export const windowShown = () => { shownOnce = true; };

const launch = () => serverLaunch({
  platform: process.platform, packaged: app.isPackaged, execPath: process.execPath, resourcesPath: process.resourcesPath, appPath: app.getAppPath(),
  userData: app.getPath("userData"), portableExe: process.env.PORTABLE_EXECUTABLE_FILE, appImage: process.env.APPIMAGE,
});

/** The server script that ships with the app (outside the asar archive), or the dev build. */
const bundledServer = () => (app.isPackaged ? join(process.resourcesPath, "mcp", SERVER_FILE) : join(app.getAppPath(), "out", "mcp", SERVER_FILE));

async function writeAppInfo() {
  const file = join(app.getPath("userData"), APP_INFO_FILE);
  const info: AppInfo = { version: app.getVersion(), defaultRecordingsDir: defaultRecordingsDir(), ffmpeg: ffmpegPath(), writtenAt: Date.now() };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(info, null, 2));
  // the portable exe and the AppImage run the server from a copy that outlives their temporary folder
  const l = launch();
  if (l.flavour === "portable" || l.flavour === "appimage") {
    const src = bundledServer();
    const dest = l.args[0];
    const same = existsSync(dest) && readFileSync(dest).equals(readFileSync(src));
    if (!same && existsSync(src)) { await copyFile(src, `${dest}.tmp`); await rename(`${dest}.tmp`, dest); }
  }
}

function storeDirs(): string[] {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== "win32" || !local) return [];
  try { return readdirSync(join(local, "Packages")).filter((n) => /^Claude_/i.test(n)).map((n) => join(local, "Packages", n)); } catch { return []; }
}

const configPaths = () => claudeDesktopConfigPaths(process.platform, process.env, homedir(), storeDirs());
const readText = async (f: string) => { try { return await readFile(f, "utf8"); } catch { return null; } };

async function status(): Promise<AssistantStatus> {
  const l = launch();
  const desktops = await Promise.all(configPaths().map(async (path) => {
    const text = await readText(path);
    return { path, exists: text != null, configured: isConfigured(text, l) };
  }));
  return {
    launch: l,
    claudeDesktop: desktops,
    claudeCode: claudeCodeCommand(l),
    codex: codexToml(l),
    codexPath: codexConfigPath(homedir(), process.env),
    warning: l.flavour === "portable" ? "For Claude and Codex, use the installed OpenTake: the portable copy is not tested with them yet." : undefined,
  };
}

/** Adds OpenTake to Claude Desktop's config, after a backup. Other servers and settings stay. */
async function setupClaudeDesktop(): Promise<SetupResult> {
  const l = launch();
  // the Store build's folder when it is there, else the standard one
  const paths = configPaths();
  const target = paths.find((p) => existsSync(dirname(p)) && p.includes("Packages")) ?? paths[0];
  try {
    const existing = await readText(target);
    const merged = mergeClaudeDesktop(existing, l);
    if (!merged.changed) return { ok: true, message: "Claude Desktop is already set up. Restart it if OpenTake does not show.", path: target };
    await mkdir(dirname(target), { recursive: true });
    let backup: string | undefined;
    if (existing != null) { backup = backupName(target, new Date()); await copyFile(target, backup); }
    await writeFile(`${target}.opentake-tmp`, merged.text);
    await rename(`${target}.opentake-tmp`, target);
    return { ok: true, message: "Done. Quit Claude Desktop completely and open it again to load OpenTake.", path: target, backup };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e), path: target };
  }
}

/** Starts the server exactly as the assistant would and asks it for its tools and the takes. */
function testConnection(): Promise<TestResult> {
  const l = launch();
  const started = Date.now();
  return new Promise((resolve) => {
    if (!existsSync(l.args[0])) return resolve({ ok: false, message: `The server file is missing: ${l.args[0]}` });
    // the data folder is passed only here, for a test copy run with its own --user-data-dir
    const p = spawn(l.command, l.args, { env: { ...process.env, ...l.env, OPENTAKE_USER_DATA: app.getPath("userData"), OPENTAKE_NO_LAUNCH: "1" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buf = "";
    let tools = 0;
    const finish = (r: TestResult) => { clearTimeout(timer); p.kill(); resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, message: "The server did not answer within 20 seconds." }), 20_000);
    const send = (m: object) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    p.on("error", (e) => finish({ ok: false, message: `Could not start it: ${e.message}` }));
    p.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let m: { id?: number; result?: { tools?: unknown[]; content?: { text?: string }[]; isError?: boolean }; error?: { message: string } };
        try { m = JSON.parse(line); } catch { continue; }
        if (m.error) return finish({ ok: false, message: m.error.message });
        if (m.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/list" });
        } else if (m.id === 2) {
          tools = m.result?.tools?.length ?? 0;
          send({ id: 3, method: "tools/call", params: { name: "list_takes", arguments: { limit: 200 } } });
        } else if (m.id === 3) {
          const text = m.result?.content?.[0]?.text ?? "";
          if (m.result?.isError) return finish({ ok: false, message: text });
          const takes = Number(/^(\d+) take/.exec(text)?.[1] ?? 0);
          finish({ ok: true, message: `Connected: ${tools} tools, ${takes} take(s) found. Claude and Codex start it the same way.`, tools, takes, ms: Date.now() - started });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "OpenTake test", version: app.getVersion() } } });
  });
}

/** "Open in an editor" from the app: the same timeline export the assistant uses. */
export async function timelineForTake(takeId: string, o: TimelineOptions) {
  const meta = await readMeta(takeId);
  const dir = takeDir(takeId);
  const durationMs = meta.durationMs;
  const r = await exportTimeline({
    id: takeId, dir, title: meta.title, createdAt: meta.createdAt, durationMs, fps: meta.fps, frame: meta.frame, containers: meta.containers,
    timeline: await readTimeline(takeId), edit: await readEdit(takeId, durationMs), captions: await readCaptions(takeId),
    chapters: parseChapters(await readJson(join(dir, "chapters.json")), durationMs)?.chapters ?? [],
  }, (args, onStdout) => runWatched(ffmpegPath(), args, { cwd: dir, onStdout }), getSettings(), o);
  await recordExport(takeId, [r.otio, ...(r.fcpxml ? [r.fcpxml] : []), ...(r.srt ? [r.srt] : [])]);
  return r;
}

async function readJson(f: string): Promise<unknown> { try { return JSON.parse(await readFile(f, "utf8")); } catch { return null; } }

export function registerAssistant(getMain: () => BrowserWindow | null, o: { background: boolean }) {
  background = o.background;
  const toMain = (channel: string, ...args: unknown[]) => { const w = getMain(); if (w && !w.isDestroyed()) w.webContents.send(channel, ...args); };
  const changed = (takeId: string) => { forgetTake(takeId); toMain(IPC.assistantChanged, { takeId }); };
  registerTranscriber();

  void writeAppInfo().catch((e) => console.warn("[assistant] app.json:", e));
  void startBridge({
    userData: app.getPath("userData"),
    version: app.getVersion(),
    handlers: {
      ping: () => ({ version: app.getVersion(), window: !!getMain(), background: keepRunningWithoutWindows(), shortcutsHeld: allShortcuts().filter((k) => globalShortcut.isRegistered(k)) }),
      changed: (p) => { if (validTakeId(p.takeId)) changed(p.takeId); return true; },
      job: (p) => { const j = jobs.get(String(p.id)); if (!j) throw new Error("That job is not known (OpenTake may have restarted)."); return j; },
      cancel: (p) => { const j = jobs.get(String(p.id)); if (j?.kind === "export") cancelExport(j.takeId); return !!j; },
      transcribe: (p) => {
        if (!validTakeId(p.takeId)) throw new Error("bad take id");
        takeDir(p.takeId);
        const lang: CaptionLang = p.lang === "es" ? "es" : "en";
        const job = jobs.start("captions", p.takeId);
        void transcribeTake(job.id, p.takeId, lang, (stage, ratio) => { job.stage = stage; job.ratio = ratio; })
          .then(async (lines) => { await writeCaptions(job.takeId, { version: 1, lang, lines }); changed(job.takeId); jobs.finish(job, { output: [join(takeDir(job.takeId), "captions.json")] }); })
          .catch((e) => jobs.finish(job, { error: e instanceof Error ? e.message : String(e) }));
        return job;
      },
      export: (p) => {
        const opts = p.options as ExportOptions | undefined;
        if (!opts || !validTakeId(opts.takeId)) throw new Error("bad take id");
        const job = jobs.start("export", opts.takeId);
        // the export runs as if started on stop: no Save dialog, and nothing is opened afterwards
        void exportTake({ ...opts, manual: false }, (prog) => {
          job.stage = prog.stage; job.ratio = prog.ratio;
          toMain(IPC.exportProgress, prog);
        }, getMain()).then(
          (out) => {
            const stem = out.replace(/\.\w+$/, "");
            jobs.finish(job, { output: [out, ...[`${stem}.srt`, `${stem}.vtt`].filter((f) => existsSync(f))] });
            changed(job.takeId);
          },
          (e) => jobs.finish(job, { error: e instanceof Error ? e.message : String(e) }),
        );
        return job;
      },
    },
  }).then((b) => { bridge = b; }, (e) => console.warn("[assistant] bridge did not start:", e));

  ipcMain.handle(IPC.assistantStatus, () => status());
  ipcMain.handle(IPC.assistantSetupClaude, () => setupClaudeDesktop());
  ipcMain.handle(IPC.assistantTest, () => testConnection());
  ipcMain.handle(IPC.assistantActivity, () => readActivity(app.getPath("userData"), 50));
  ipcMain.handle(IPC.assistantUndo, async (_e, id: unknown) => {
    const r = await undo(app.getPath("userData"), String(id));
    if (r.takeId && validTakeId(r.takeId)) changed(r.takeId);
    return r;
  });
  ipcMain.handle(IPC.assistantTimeline, async (_e, takeId: unknown, opts: unknown) => {
    if (!validTakeId(takeId)) throw new Error("bad take id");
    const o = (opts && typeof opts === "object" ? opts : {}) as TimelineOptions;
    const r = await timelineForTake(takeId, { layout: o.layout === "separate" ? "separate" : "composite", fcpxml: o.fcpxml !== false, compatibleMedia: !!o.compatibleMedia });
    revealFile(r.otio);
    return r;
  });

  // with no window, the app is only here for the assistant: it leaves once nothing has asked for a while
  if (background) {
    const timer = setInterval(() => {
      if (shownOnce) { clearInterval(timer); return; }
      const quiet = Date.now() - (bridge?.lastUsed() ?? Date.now()) > IDLE_QUIT_MS;
      if (quiet && jobs.running() === 0 && exportsRunning() === 0) app.quit();
    }, 30_000);
  }
  app.on("will-quit", () => bridge?.forget());
}
