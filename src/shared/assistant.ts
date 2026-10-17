// Contracts between the app, its MCP server (src/mcp-server) and the Settings section that connects
// Claude or Codex. File names are relative to the app's data folder.

/** Written by the app each time it starts, so the server finds things Electron knows and Node does not. */
export const APP_INFO_FILE = "assistant/app.json";
/** The running app's bridge: port and process. Gone or stale when the app is closed. */
export const BRIDGE_FILE = "assistant/bridge.json";
/** The per-install secret the bridge asks for. Readable only by this user. */
export const TOKEN_FILE = "assistant/token";
/** The header that carries it. */
export const TOKEN_HEADER = "x-opentake-token";
/** The command line flag that starts the app with no window, for the assistant. */
export const BACKGROUND_FLAG = "--assistant";

export interface AppInfo {
  version: string;
  /** the standard Documents/OpenTake recordings (Node cannot see a moved Documents folder) */
  defaultRecordingsDir: string;
  ffmpeg: string;
  writtenAt: number;
}

export interface BridgeFile { port: number; pid: number; version: string; startedAt: number }

export type BridgeMethod = "ping" | "changed" | "transcribe" | "export" | "job" | "cancel";

/** A long piece of work the app runs for the assistant. */
export interface AssistantJob {
  id: string;
  kind: "export" | "captions" | "timeline";
  takeId: string;
  stage: string;
  ratio: number | null;
  done: boolean;
  error?: string;
  /** the files it wrote */
  output?: string[];
  startedAt: number;
  finishedAt?: number;
}

/** How Claude or Codex starts the server: a command, its arguments and the environment it needs. */
export interface ServerLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** the way this copy runs (the portable exe and the AppImage move on every start) */
  flavour: "installed" | "portable" | "appimage" | "dev";
}

export interface AssistantStatus {
  launch: ServerLaunch;
  /** claude_desktop_config.json files this computer has (or would have) */
  claudeDesktop: { path: string; exists: boolean; configured: boolean }[];
  claudeCode: string;
  /** the block for Codex's config.toml, and where that file is */
  codex: string;
  codexPath: string;
  /** a plain line when this copy cannot be set up as it is (the portable exe) */
  warning?: string;
}

export interface SetupResult { ok: boolean; message: string; path?: string; backup?: string }

export interface TestResult { ok: boolean; message: string; tools?: number; takes?: number; ms?: number }
