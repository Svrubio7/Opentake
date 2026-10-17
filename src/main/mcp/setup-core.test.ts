import { describe, expect, it } from "vitest";
import { backupName, claudeCodeCommand, claudeDesktopConfigPaths, codexToml, isConfigured, mergeClaudeDesktop, serverLaunch, type LaunchContext } from "./setup-core";

const win: LaunchContext = {
  platform: "win32", packaged: true, execPath: "C:\\Users\\Ana\\AppData\\Local\\Programs\\OpenTake\\OpenTake.exe",
  resourcesPath: "C:\\Users\\Ana\\AppData\\Local\\Programs\\OpenTake\\resources", appPath: "C:\\x\\app.asar", userData: "C:\\Users\\Ana\\AppData\\Roaming\\OpenTake",
};

describe("server launch", () => {
  it("runs the installed app's own script with its executable in Node mode", () => {
    expect(serverLaunch(win)).toEqual({
      command: win.execPath, args: ["C:\\Users\\Ana\\AppData\\Local\\Programs\\OpenTake\\resources\\mcp\\opentake-mcp.cjs"],
      env: { ELECTRON_RUN_AS_NODE: "1", OPENTAKE_USER_DATA: win.userData }, flavour: "installed",
    });
  });

  it("starts the portable exe and the AppImage by their stable file, with a copy of the script", () => {
    expect(serverLaunch({ ...win, portableExe: "D:\\Tools\\OpenTake-1.2.0-portable.exe" })).toMatchObject({ command: "D:\\Tools\\OpenTake-1.2.0-portable.exe", args: ["C:\\Users\\Ana\\AppData\\Roaming\\OpenTake\\assistant\\opentake-mcp.cjs"], flavour: "portable" });
    const linux = serverLaunch({ ...win, platform: "linux", execPath: "/tmp/.mount_x/opentake", resourcesPath: "/tmp/.mount_x/resources", userData: "/home/ana/.config/OpenTake", appImage: "/home/ana/OpenTake.AppImage" });
    expect(linux).toMatchObject({ command: "/home/ana/OpenTake.AppImage", args: ["/home/ana/.config/OpenTake/assistant/opentake-mcp.cjs"], flavour: "appimage" });
  });

  it("uses the built script and tells the server where the project is in dev", () => {
    const dev = serverLaunch({ ...win, packaged: false, execPath: "C:\\p\\node_modules\\electron\\dist\\electron.exe", appPath: "C:\\p" });
    expect(dev.args).toEqual(["C:\\p\\out\\mcp\\opentake-mcp.cjs"]);
    expect(dev.env.OPENTAKE_APP_ROOT).toBe("C:\\p");
  });
});

describe("Claude Desktop config", () => {
  const launch = serverLaunch(win);

  it("finds the config, the Store build's too, or the override", () => {
    expect(claudeDesktopConfigPaths("win32", { APPDATA: "C:\\R" }, "C:\\H", ["C:\\L\\Packages\\Claude_abc"])).toEqual(["C:\\R\\Claude\\claude_desktop_config.json", "C:\\L\\Packages\\Claude_abc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json"]);
    expect(claudeDesktopConfigPaths("darwin", {}, "/Users/ana")).toEqual(["/Users/ana/Library/Application Support/Claude/claude_desktop_config.json"]);
    expect(claudeDesktopConfigPaths("linux", { OPENTAKE_CLAUDE_CONFIG: "/tmp/c.json" }, "/h")).toEqual(["/tmp/c.json"]);
  });

  it("adds OpenTake and keeps every other server and setting", () => {
    const existing = JSON.stringify({ globalShortcut: "Ctrl+Space", mcpServers: { files: { command: "npx", args: ["-y", "fs"] } } });
    const r = mergeClaudeDesktop(existing, launch);
    const doc = JSON.parse(r.text);
    expect(r.changed).toBe(true);
    expect(doc.globalShortcut).toBe("Ctrl+Space");
    expect(doc.mcpServers.files).toEqual({ command: "npx", args: ["-y", "fs"] });
    expect(doc.mcpServers.opentake).toEqual({ command: launch.command, args: launch.args, env: launch.env });
    expect(isConfigured(r.text, launch)).toBe(true);
    expect(mergeClaudeDesktop(r.text, launch).changed).toBe(false);
  });

  it("starts a config when there is none, and never rewrites one it cannot read", () => {
    expect(JSON.parse(mergeClaudeDesktop(null, launch).text).mcpServers.opentake.command).toBe(launch.command);
    expect(() => mergeClaudeDesktop("{ not json", launch)).toThrow(/left it alone/);
    expect(() => mergeClaudeDesktop("[1,2]", launch)).toThrow(/left it alone/);
  });

  it("names backups by the time", () => {
    expect(backupName("C:\\R\\Claude\\claude_desktop_config.json", new Date(2026, 9, 17, 14, 5, 9))).toBe("C:\\R\\Claude\\claude_desktop_config.json.opentake-backup-20261017-140509");
  });
});

describe("Claude Code and Codex", () => {
  const launch = serverLaunch({ ...win, execPath: "C:\\Program Files\\OpenTake\\OpenTake.exe", resourcesPath: "C:\\Program Files\\OpenTake\\resources" });

  it("quotes paths with spaces in the Claude Code command", () => {
    expect(claudeCodeCommand(launch)).toBe(
      `claude mcp add opentake --scope user -e ELECTRON_RUN_AS_NODE=1 -e OPENTAKE_USER_DATA=C:\\Users\\Ana\\AppData\\Roaming\\OpenTake -- "C:\\Program Files\\OpenTake\\OpenTake.exe" "C:\\Program Files\\OpenTake\\resources\\mcp\\opentake-mcp.cjs"`,
    );
  });

  it("writes Windows paths as TOML literal strings, and escapes when it must", () => {
    expect(codexToml(launch)).toBe([
      "[mcp_servers.opentake]",
      "command = 'C:\\Program Files\\OpenTake\\OpenTake.exe'",
      "args = ['C:\\Program Files\\OpenTake\\resources\\mcp\\opentake-mcp.cjs']",
      "env = { ELECTRON_RUN_AS_NODE = '1', OPENTAKE_USER_DATA = 'C:\\Users\\Ana\\AppData\\Roaming\\OpenTake' }",
      "",
    ].join("\n"));
    expect(codexToml({ ...launch, command: "/Users/o'neil/OpenTake" })).toContain(`command = "/Users/o'neil/OpenTake"`);
  });
});
