// The words the app shows, in English and Spanish. One dictionary per language (en/, es/), the same
// keys in both (a missing key is a type error, a missing {variable} fails i18n.test.ts). Every process
// keeps its own current language: main reads it from settings.json, each window asks main on load and
// follows its broadcast, so a switch in Settings changes every window at once without a restart.
import { en } from "./en";
import { es } from "./es";

export type Lang = "en" | "es";
/** what Settings stores: a language, or whatever the system uses */
export type LangSetting = "system" | Lang;
/** a message that changes with a number: Intl.PluralRules picks the form, {count} is the number */
export interface Plural { one: string; other: string }
export type Msg = string | Plural;

type En = typeof en;
export type Key = keyof En;

/** The same keys as English, each a plain string or a plural (what the Spanish files must fill in). */
export type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Plural };

type VarsIn<S> = S extends `${string}{${infer V}}${infer R}` ? V | VarsIn<R> : never;
type VarsOf<K extends Key> = En[K] extends { one: infer A; other: infer B } ? VarsIn<A> | VarsIn<B> | "count" : VarsIn<En[K]>;
export type Vars = Record<string, string | number>;
/** a key whose message takes no {variables}: t(key) alone (for maps of keys) */
export type PlainKey = { [K in Key]: [VarsOf<K>] extends [never] ? K : never }[Key];
type Args<K extends Key> = [VarsOf<K>] extends [never] ? [] : [Record<VarsOf<K>, string | number>];

const DICTS: Record<Lang, Record<string, Msg>> = { en, es };

let lang: Lang = "en";
let locale = "en-US";
const listeners = new Set<() => void>();

/** The language of the words, and the locale numbers and dates follow. */
export const getLang = () => lang;
export const getLocale = () => locale;

/** The locale for a language: the system's own when it speaks that language (es-MX keeps its dates), else a standard one. */
export function localeFor(l: Lang, systemLocales: readonly string[] = []): string {
  const own = systemLocales.find((s) => s.toLowerCase().split(/[-_]/)[0] === l);
  if (own) { try { return Intl.getCanonicalLocales(own.replace(/_/g, "-"))[0]; } catch { /* a malformed tag */ } }
  return l === "es" ? "es-ES" : "en-US";
}

/** The language a setting means here: Spanish for any es-* system, English for the rest. */
export function resolveLang(setting: LangSetting | undefined, systemLocales: readonly string[]): Lang {
  if (setting === "en" || setting === "es") return setting;
  const first = systemLocales.find(Boolean)?.toLowerCase() ?? "";
  return first.startsWith("es") ? "es" : "en";
}

export function setLang(next: Lang, nextLocale = localeFor(next)) {
  if (next === lang && nextLocale === locale) return;
  lang = next;
  locale = nextLocale;
  for (const f of listeners) f();
}

/** Called after every language change (the React hook re-renders on it). */
export function onLang(f: () => void): () => void {
  listeners.add(f);
  return () => { listeners.delete(f); };
}

const fill = (s: string, vars?: Vars) => (vars ? s.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all)) : s);

/** The message for a key in the current language, with its {variables} filled in. */
export function t<K extends Key>(key: K, ...args: Args<K>): string {
  return tIn(lang, key, ...args);
}

/** The same in a given language (a test, or a file name that must not change with the app's language). */
export function tIn<K extends Key>(l: Lang, key: K, ...args: Args<K>): string {
  const vars = args[0] as Vars | undefined;
  const m = DICTS[l][key] ?? DICTS.en[key];
  if (m == null) return String(key);
  if (typeof m === "string") return fill(m, vars);
  const n = Number(vars?.count ?? 0);
  const form = new Intl.PluralRules(l === lang ? locale : localeFor(l)).select(n) === "one" ? m.one : m.other;
  return fill(form, { ...vars, count: typeof vars?.count === "number" ? num(vars.count) : String(vars?.count ?? "") });
}

/** Whether a key exists (for keys built from data, like a shortcut id). */
export const hasKey = (key: string): key is Key => key in DICTS.en;

// ---- numbers, sizes and dates in the current locale ----

export const num = (n: number, opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, opts).format(n);

/** A file or drive size: "820 MB", "1.4 GB" (Spanish "1,4 GB"). */
export function bytes(b: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = b, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i === 0 || v >= 10 ? 0 : 1;
  return `${num(v, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[i]}`;
}

/** A date and time like "17 oct, 14:05" or "Oct 17, 2:05 PM". */
export const dateTime = (ms: number, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) =>
  new Date(ms).toLocaleString(locale, opts);

export const date = (ms: number, opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }) =>
  new Date(ms).toLocaleDateString(locale, opts);

export const time = (ms: number, opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" }) =>
  new Date(ms).toLocaleTimeString(locale, opts);

/** "a, b and c" / "a, b y c". */
export const list = (items: string[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(items);
