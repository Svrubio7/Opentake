// Every word a person reads goes through t() (src/shared/i18n): this scan fails on English left in the
// renderer as JSX text, as a text prop (title, aria-label, placeholder...), as a literal inside JSX, or as
// a label/hint/notice field in code. Names that read the same in every language are allowed below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname);

// files other builders were still changing when the strings moved to the dictionaries; the last pass removes them
const NOT_YET: string[] = [
  "modules/record/engine.ts",
  "modules/record/recorder.ts",
  "modules/record/zoom-core.ts",
  "modules/record/overlays.ts",
  "modules/record/overlays-core.ts",
  "modules/record/branding-panel.tsx",
  "modules/record/scenes-core.ts",
  "modules/record/keys-core.ts",
  "modules/audio/engine.ts",
];

/** Strings that are the same in English and Spanish: product, format, codec, unit and key names. */
const SAME_EVERYWHERE = new Set([
  "OpenTake", "Quetzal", "OpenTake Prompter", "MP4", "WebM", "GIF", "SRT", "VTT", "LUFS", "RNNoise", "Speex", "Vosk", "MediaPipe",
  "YouTube", "Reels", "TikTok", "Shorts", "LinkedIn", "REC", "English", "Español", "Ctrl", "Cmd", "Alt", "Esc", "Tab", "fps", "px", "dB",
  "macOS", "Windows", "Linux", "GitHub", "ffmpeg", "Logo", "Zoom", "Demo",
]);
/** units and short codes that read the same in both languages */
const UNITS = new Set(["fps", "px", "dB", "ms", "MB", "GB", "KB", "TB", "Hz", "kHz", "kbps", "Mbps", "CRF", "crf", "x", "K", "p", "s", "h", "m", "inf"]);
const neutral = (tok: string) => SAME_EVERYWHERE.has(tok) || UNITS.has(tok) || /^[\d.,]+(fps|px|p|k|K|dB|ms|s|MB|GB|x)?$/.test(tok) || /^#[0-9a-f]{3,8}$/i.test(tok) || /^[A-Z]$/.test(tok) || /^\.[a-z0-9]{2,4}$/.test(tok) || !/[A-Za-z]/.test(tok);

function words(s: string): boolean {
  const v = s.trim();
  if (!v || SAME_EVERYWHERE.has(v)) return false;
  return v.split(/[\s·,/:()+|=×–-]+/).filter(Boolean).some((tok) => !neutral(tok) && /[A-Za-z]{2,}/.test(tok));
}

const TEXT_PROPS = new Set(["title", "aria-label", "aria-description", "aria-valuetext", "placeholder", "alt", "label", "hint", "text", "note", "sub", "tooltip", "description", "summary"]);
const TEXT_FIELDS = new Set(["label", "hint", "title", "text", "note", "notice", "message", "does", "tooltip", "description", "sub", "detail", "error", "reason", "value"]);
/** a field value worth flagging: a sentence or a capitalised word (ids and codes stay lowercase-kebab) */
const sentence = (s: string) => words(s) && (/\s/.test(s.trim()) || /^[A-Z][a-z]/.test(s.trim()));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === "vosk" || n === "models" || n === "assets" ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) && !/\.test\.tsx?$/.test(n) && !/\.d\.ts$/.test(n) && !/worklet/.test(n) ? [p] : [];
  });
}

type Node = { type: string; [k: string]: unknown };
const isNode = (v: unknown): v is Node => !!v && typeof v === "object" && typeof (v as Node).type === "string";

function scan(file: string, src = readFileSync(file, "utf8")): string[] {
  const ast = parse(src, { sourceType: "module", plugins: ["typescript", "jsx"] });
  const found: string[] = [];
  const at = (n: Node, what: string) => found.push(`${relative(ROOT, file).replace(/\\/g, "/")}:${(n.loc as { start: { line: number } }).start.line} ${what}`);

  const walk = (n: Node, inJsx: boolean, parent: Node | null) => {
    switch (n.type) {
      case "JSXText": if (words(String(n.value))) at(n, JSON.stringify(String(n.value).trim())); break;
      case "JSXAttribute": {
        const name = (n.name as Node).type === "JSXIdentifier" ? String((n.name as Node).name) : "";
        const v = n.value as Node | null;
        if (v?.type === "StringLiteral" && TEXT_PROPS.has(name) && words(String(v.value))) at(v, `${name}=${JSON.stringify(v.value)}`);
        break;
      }
      case "StringLiteral": {
        const v = String(n.value);
        // a literal shown inside JSX: {"Text"}, {a ? "Yes" : "No"}, {x || "None"}
        if (inJsx && parent && ["JSXExpressionContainer", "ConditionalExpression", "LogicalExpression"].includes(parent.type) && sentence(v)) at(n, JSON.stringify(v));
        // a text field in code: { label: "Text" }, { notice: "Something happened." }
        if (parent?.type === "ObjectProperty" && parent.value === n) {
          const k = (parent.key as Node).type === "Identifier" ? String((parent.key as Node).name) : String((parent.key as Node).value ?? "");
          if (TEXT_FIELDS.has(k) && sentence(v)) at(n, `${k}: ${JSON.stringify(v)}`);
        }
        break;
      }
      case "TemplateLiteral": {
        const raw = (n.quasis as Node[]).map((q) => String((q.value as { cooked: string }).cooked ?? "")).join(" ");
        if (inJsx && parent && ["JSXExpressionContainer", "ConditionalExpression", "LogicalExpression", "JSXAttribute"].includes(parent.type) && /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(raw)) at(n, `\`${raw}\``);
        if (parent?.type === "ObjectProperty" && parent.value === n) {
          const k = (parent.key as Node).type === "Identifier" ? String((parent.key as Node).name) : "";
          if (TEXT_FIELDS.has(k) && /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(raw)) at(n, `${k}: \`${raw}\``);
        }
        break;
      }
    }
    // what is shown: element children and the text props; a call (t("..."), cx(...)) or any other prop
    // (className, key, style) is code again
    let childJsx = inJsx;
    if (n.type === "JSXElement" || n.type === "JSXFragment") childJsx = true;
    else if (n.type === "CallExpression") childJsx = false;
    else if (n.type === "JSXAttribute") childJsx = TEXT_PROPS.has((n.name as Node).type === "JSXIdentifier" ? String((n.name as Node).name) : "");
    for (const [k, v] of Object.entries(n)) {
      if (k === "loc" || k === "start" || k === "end" || k === "extra" || k === "leadingComments" || k === "trailingComments") continue;
      if (Array.isArray(v)) { for (const c of v) if (isNode(c)) walk(c, childJsx, n); }
      else if (isNode(v)) walk(v, childJsx, n);
    }
  };
  walk(ast.program as unknown as Node, false, null);
  return found;
}

describe("the renderer", () => {
  it("shows no English that skips the dictionaries", () => {
    const all = files(ROOT).filter((f) => !NOT_YET.includes(relative(ROOT, f).replace(/\\/g, "/")));
    expect(all.length).toBeGreaterThan(40);
    expect(all.flatMap((f) => scan(f))).toEqual([]);
  });

  it("still finds every kind of slip", () => {
    const sample = [
      'export const A = () => <div title="Open the folder" aria-label="Close">Some words<b>{"Hello there"}</b>{x ? "Yes please" : "No"}</div>;',
      'const opts = [{ value: "a", label: "First option", hint: "Does a thing" }];',
      's.set({ notice: "The take was saved." });',
      'export const B = () => <div title={t("x")} className="panel big">{t("y")} 1080p · 30 fps <kbd>Ctrl</kbd> {"OpenTake"}</div>;',
    ].join("\n");
    const hits = scan(join(ROOT, "probe.tsx"), sample).map((h) => h.replace(/^probe\.tsx:\d+ /, ""));
    expect(hits).toEqual([
      'title="Open the folder"', 'aria-label="Close"', '"Some words"', '"Hello there"', '"Yes please"', '"No"',
      'label: "First option"', 'hint: "Does a thing"', 'notice: "The take was saved."',
    ]);
  });
});
