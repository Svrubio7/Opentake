import { describe, expect, it } from "vitest";
import { en } from "./en";
import { es } from "./es";
import { bytes, list, localeFor, resolveLang, setLang, t, tIn, type Msg } from "./core";

const forms = (m: Msg) => (typeof m === "string" ? [m] : [m.one, m.other]);
const vars = (m: Msg) => [...new Set(forms(m).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1])))].sort();

describe("the dictionaries", () => {
  const enKeys = Object.keys(en).sort();
  const esKeys = Object.keys(es).sort();

  it("have the same keys in English and Spanish", () => {
    expect(esKeys.filter((k) => !(k in en))).toEqual([]);
    expect(enKeys.filter((k) => !(k in es))).toEqual([]);
  });

  it("use the same {variables} in both languages", () => {
    const bad = enKeys.filter((k) => vars(en[k as keyof typeof en]).join() !== vars(es[k as keyof typeof es]).join());
    expect(bad).toEqual([]);
  });

  it("give a plural in both languages, or in neither", () => {
    const bad = enKeys.filter((k) => typeof en[k as keyof typeof en] !== typeof es[k as keyof typeof es]);
    expect(bad).toEqual([]);
  });

  it("have no empty message", () => {
    const empty = (d: Record<string, Msg>) => Object.entries(d).filter(([, m]) => forms(m).some((s) => !s.trim())).map(([k]) => k);
    expect(empty(en)).toEqual([]);
    expect(empty(es)).toEqual([]);
  });

  it("have no em dash or en dash used as one (Quetzal's copy rule)", () => {
    const dashed = (d: Record<string, Msg>) => Object.entries(d).filter(([, m]) => forms(m).some((s) => /—|\s–\s/.test(s))).map(([k]) => k);
    expect(dashed(en)).toEqual([]);
    expect(dashed(es)).toEqual([]);
  });

  it("never leave a Spanish message the same as the English unless it is a name", () => {
    // a word both languages share (Logo, Zoom, Podcast) is fine; a whole English sentence is not
    const same = enKeys.filter((k) => {
      const e = forms(en[k as keyof typeof en]).join(" "), s = forms(es[k as keyof typeof es]).join(" ");
      return e === s && e.split(/\s+/).filter((w) => /^[a-z]{3,}$/i.test(w)).length >= 3;
    });
    expect(same).toEqual([]);
  });

  it("write Spain's spelling of the glossary words", () => {
    const wrong = Object.entries(es).filter(([, m]) => forms(m).some((s) => /\bvideo\b|\bguión\b|\bcomputadora\b|\bustedes?\b|\barchivo de video\b/i.test(s))).map(([k]) => k);
    expect(wrong).toEqual([]);
  });
});

describe("t", () => {
  it("fills variables and picks the plural form", () => {
    setLang("en");
    expect(tIn("en", "card.look")).toBe("Look");
    expect(tIn("es", "card.look")).toBe("Estilo");
    expect(tIn("en", "set.takes", { count: 1 })).toBe("1 take");
    expect(tIn("en", "set.takes", { count: 2 })).toBe("2 takes");
    expect(tIn("es", "set.takes", { count: 1 })).toBe("1 toma");
    expect(tIn("es", "set.takes", { count: 0 })).toBe("0 tomas");
    expect(tIn("es", "fr.step", { step: 2, total: 3 })).toBe("Paso 2 de 3");
  });

  it("follows the current language", () => {
    setLang("es");
    expect(t("card.help")).toBe("Ayuda");
    setLang("en");
    expect(t("card.help")).toBe("Help");
  });
});

describe("the language a system gets", () => {
  it("is Spanish for any Spanish system and English for the rest", () => {
    expect(resolveLang("system", ["es-ES"])).toBe("es");
    expect(resolveLang("system", ["es-419", "en-US"])).toBe("es");
    expect(resolveLang("system", ["en-GB", "es-ES"])).toBe("en");
    expect(resolveLang("system", ["fr-FR"])).toBe("en");
    expect(resolveLang("system", [])).toBe("en");
    expect(resolveLang("es", ["en-US"])).toBe("es");
    expect(resolveLang("en", ["es-ES"])).toBe("en");
  });

  it("keeps the system's own region when it speaks the language", () => {
    expect(localeFor("es", ["es-MX"])).toBe("es-MX");
    expect(localeFor("es", ["en-US"])).toBe("es-ES");
    expect(localeFor("en", ["en_GB"])).toBe("en-GB");
    expect(localeFor("en", ["es-ES"])).toBe("en-US");
  });
});

describe("numbers and sizes", () => {
  it("follow the locale", () => {
    setLang("es", "es-ES");
    expect(bytes(1.4 * 1024 ** 3)).toBe("1,4 GB");
    expect(bytes(820 * 1024 ** 2)).toBe("820 MB");
    expect(list(["a", "b", "c"])).toBe("a, b y c");
    setLang("en", "en-US");
    expect(bytes(1.4 * 1024 ** 3)).toBe("1.4 GB");
    expect(list(["a", "b", "c"])).toBe("a, b, and c");
  });
});
