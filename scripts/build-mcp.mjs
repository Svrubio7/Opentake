// Bundles the MCP server (src/mcp-server) into one CommonJS file, out/mcp/opentake-mcp.cjs, with the MCP
// SDK and zod inside it. The installed app ships it outside the asar archive (resources/mcp) and runs it
// with its own executable in Node mode, so it needs no node_modules and no Node.js on the computer.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

await build({
  root,
  configFile: false,
  logLevel: "warn",
  resolve: { alias: { "@shared": resolve(root, "src/shared"), "@core": resolve(root, "src/renderer/core") } },
  define: { __OPENTAKE_VERSION__: JSON.stringify(pkg.version) },
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: resolve(root, "src/mcp-server/index.ts"),
    outDir: resolve(root, "out/mcp"),
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: "node22",
    rollupOptions: { output: { format: "cjs", entryFileNames: "opentake-mcp.cjs", codeSplitting: false } },
  },
});
console.log("built out/mcp/opentake-mcp.cjs");
