// Where a long command or config line may wrap in the Settings card: at spaces and right after a path
// separator, never inside a word or at a hyphen ("--scope", "opentake-mcp.cjs" stay whole). Pure, tested
// in wrap-core.test.ts. A piece longer than the line scrolls sideways inside its block instead.

export type Piece = { kind: "text"; text: string } | { kind: "space"; text: string };

export function wrapPieces(text: string): Piece[] {
  const out: Piece[] = [];
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { out.push({ kind: "space", text: part }); continue; }
    for (const chunk of part.match(/[^\\/]*[\\/]+|[^\\/]+$/g) ?? [part]) out.push({ kind: "text", text: chunk });
  }
  return out;
}
