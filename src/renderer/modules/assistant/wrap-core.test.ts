import { describe, expect, it } from "vitest";
import { wrapPieces } from "./wrap-core";

const texts = (s: string) => wrapPieces(s).map((p) => (p.kind === "space" ? "_" : p.text));

describe("copy block wrapping", () => {
  it("breaks after path separators and at spaces only", () => {
    expect(texts("claude mcp add opentake --scope user -- \"C:\\Program Files\\OpenTake\\OpenTake.exe\""))
      .toEqual(["claude", "_", "mcp", "_", "add", "_", "opentake", "_", "--scope", "_", "user", "_", "--", "_", "\"C:\\", "Program", "_", "Files\\", "OpenTake\\", "OpenTake.exe\""]);
    expect(texts("/Applications/OpenTake.app/Contents/Resources/mcp/opentake-mcp.cjs")).toEqual(["/", "Applications/", "OpenTake.app/", "Contents/", "Resources/", "mcp/", "opentake-mcp.cjs"]);
  });

  it("keeps the text the same when joined back, new lines included", () => {
    const s = "[mcp_servers.opentake]\ncommand = 'C:\\a b\\x.exe'\nargs = ['C:\\a b\\m.cjs']\n";
    expect(wrapPieces(s).map((p) => p.text).join("")).toBe(s);
  });
});
