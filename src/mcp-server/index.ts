// OpenTake's MCP server: edit your recordings by talking to Claude or Codex. It runs on this computer
// over stdio, started by the assistant with OpenTake's own executable in Node mode
// (ELECTRON_RUN_AS_NODE=1), so nothing else needs installing. See docs/mcp.md.
// stdout carries the protocol only: anything else this process says goes to stderr.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge-client";
import { Ff } from "./ff";
import { localeFor, resolveLang, setLang } from "../shared/i18n";
import { ffmpegBinary, readSettings, recordingsRoot, userDataDir } from "./paths";
import { Store } from "./store";
import { registerTools } from "./tools";

declare const __OPENTAKE_VERSION__: string | undefined;
const version = typeof __OPENTAKE_VERSION__ === "string" ? __OPENTAKE_VERSION__ : "dev";

console.log = console.error;
console.info = console.error;

async function main() {
  const userData = userDataDir();
  // what the person reads (the activity list, undo, timeline notes) follows the app's language
  const system = [Intl.DateTimeFormat().resolvedOptions().locale, process.env.LANG ?? ""].filter(Boolean);
  const lang = resolveLang(readSettings(userData).language, system);
  setLang(lang, localeFor(lang, system));
  const server = new McpServer(
    { name: "opentake", title: "OpenTake", version },
    {
      instructions:
        "OpenTake is a desktop screen and camera recorder. These tools read, cut, caption and export the person's recordings (takes) on their own computer. " +
        "Start with list_takes or use \"latest\". Times are seconds on the take's own recording clock. Edits only change the take's edit and captions, never the recording itself, and can be undone with undo_change. " +
        "Look before you cut: get_transcript and get_frame show what is said and on screen. Exports go where the person's Settings say and never overwrite a file.",
    },
  );
  registerTools(server, {
    userData,
    // read again on every call: the recordings folder can change in Settings while we run
    store: () => new Store(recordingsRoot(userData)),
    ff: new Ff(ffmpegBinary(userData)),
    bridge: new Bridge(userData),
  });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error("[opentake-mcp]", e);
  process.exit(1);
});
