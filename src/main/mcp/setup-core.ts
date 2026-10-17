// Connecting Claude or Codex to OpenTake, as pure functions (tested in setup-core.test.ts): the command
// that starts the bundled MCP server for this copy of the app, the claude_desktop_config.json merge
// (other servers and settings are kept as they are), and the lines for Claude Code and Codex.
import { join, posix, win32 } from "node:path";
import type { ServerLaunch } from "../../shared/assistant";

export const SERVER_NAME = "opentake";
export const SERVER_FILE = "opentake-mcp.cjs";

export interface LaunchContext {
  platform: string;
  packaged: boolean;
  /** the running executable (OpenTake, or Electron in dev) */
  execPath: string;
  resourcesPath: string;
  /** the app folder (the project folder in dev) */
  appPath: string;
  userData: string;
  /** set by the Windows portable build: the .exe the person double-clicked */
  portableExe?: string;
  /** set by the AppImage: the .AppImage file */
  appImage?: string;
}

const pathOf = (platform: string) => (platform === "win32" ? win32 : posix);

/**
 * How the assistant starts the server. The installed app runs the script next to its resources with its
 * own executable in Node mode. The portable exe and the AppImage unpack to a new temporary folder
 * every time, so they are started by their own stable file and run a copy of the script kept in the
 * app's data folder (the app refreshes that copy when it starts).
 */
export function serverLaunch(c: LaunchContext): ServerLaunch {
  const p = pathOf(c.platform);
  // the server finds the app's data folder itself (OPENTAKE_USER_DATA is only for tests)
  const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" };
  if (!c.packaged) return { command: c.execPath, args: [p.join(c.appPath, "out", "mcp", SERVER_FILE)], env: { ...env, OPENTAKE_APP_ROOT: c.appPath }, flavour: "dev" };
  const copy = p.join(c.userData, "assistant", SERVER_FILE);
  if (c.platform === "win32" && c.portableExe) return { command: c.portableExe, args: [copy], env, flavour: "portable" };
  if (c.platform === "linux" && c.appImage) return { command: c.appImage, args: [copy], env, flavour: "appimage" };
  return { command: c.execPath, args: [p.join(c.resourcesPath, "mcp", SERVER_FILE)], env, flavour: "installed" };
}

/** Where Claude Desktop keeps its config on this system (the Microsoft Store build has its own folder). */
export function claudeDesktopConfigPaths(platform: string, env: Record<string, string | undefined>, home: string, storeDirs: string[] = []): string[] {
  if (env.OPENTAKE_CLAUDE_CONFIG) return [env.OPENTAKE_CLAUDE_CONFIG];
  if (platform === "win32") {
    const roaming = env.APPDATA ?? win32.join(home, "AppData", "Roaming");
    return [win32.join(roaming, "Claude", "claude_desktop_config.json"), ...storeDirs.map((d) => win32.join(d, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json"))];
  }
  if (platform === "darwin") return [posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")];
  return [posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), "Claude", "claude_desktop_config.json")];
}

export interface MergeResult { text: string; changed: boolean }

/**
 * The config with OpenTake's server added or updated. Everything else in the file stays. A file that
 * is not valid JSON is never rewritten: that throws, so the person can fix it first.
 */
export function mergeClaudeDesktop(existing: string | null, launch: ServerLaunch): MergeResult {
  let doc: Record<string, unknown> = {};
  if (existing != null && existing.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch { throw new Error("claude_desktop_config.json is not valid JSON, so OpenTake left it alone. Fix it or set it up by hand."); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("claude_desktop_config.json does not hold a settings object, so OpenTake left it alone.");
    doc = parsed as Record<string, unknown>;
  }
  const servers = doc.mcpServers && typeof doc.mcpServers === "object" && !Array.isArray(doc.mcpServers) ? (doc.mcpServers as Record<string, unknown>) : {};
  const entry = { command: launch.command, args: launch.args, env: launch.env };
  const before = JSON.stringify(servers[SERVER_NAME] ?? null);
  const next = { ...doc, mcpServers: { ...servers, [SERVER_NAME]: entry } };
  return { text: JSON.stringify(next, null, 2) + "\n", changed: before !== JSON.stringify(entry) };
}

/** True when the config already starts this exact server. */
export function isConfigured(existing: string | null, launch: ServerLaunch): boolean {
  if (!existing) return false;
  try {
    const s = (JSON.parse(existing) as { mcpServers?: Record<string, unknown> }).mcpServers?.[SERVER_NAME];
    return JSON.stringify(s) === JSON.stringify({ command: launch.command, args: launch.args, env: launch.env });
  } catch { return false; }
}

/** A backup name beside the config: claude_desktop_config.json.opentake-backup-20261017-140500. */
export function backupName(file: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${file}.opentake-backup-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** Quotes for a shell line that works the same in PowerShell, cmd and bash (paths with spaces). */
const q = (s: string) => (/^[\w./:\\=-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** The Claude Code command that adds the server for this user. */
export function claudeCodeCommand(l: ServerLaunch): string {
  const env = Object.entries(l.env).map(([k, v]) => `-e ${q(`${k}=${v}`)}`).join(" ");
  return `claude mcp add ${SERVER_NAME} --scope user ${env} -- ${[l.command, ...l.args].map(q).join(" ")}`;
}

/** A TOML string: a literal one ('C:\path') when it can be, else a basic one with escapes. */
const toml = (s: string) => (!/['\n\r]/.test(s) ? `'${s}'` : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`);

/** The block for Codex's ~/.codex/config.toml. */
export function codexToml(l: ServerLaunch): string {
  const env = Object.entries(l.env).map(([k, v]) => `${k} = ${toml(v)}`).join(", ");
  return [`[mcp_servers.${SERVER_NAME}]`, `command = ${toml(l.command)}`, `args = [${l.args.map(toml).join(", ")}]`, `env = { ${env} }`, ""].join("\n");
}

export const codexConfigPath = (home: string, env: Record<string, string | undefined>) => join(env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
