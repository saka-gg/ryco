import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { BUILT_IN_THEMES, DEFAULT_THEME, DEFAULT_THEME_ID } from "./builtin";
import {
  ACTIVE_THEME_STORAGE_KEY,
  CUSTOM_THEMES_STORAGE_KEY,
  THEME_STYLE_ELEMENT_ID,
  addCustomTheme,
  applyThemeToDocument,
  deleteCustomTheme,
  duplicateTheme,
  findTheme,
  generateCustomThemeId,
  getActiveThemeId,
  getAllThemes,
  getCustomThemes,
  isBuiltInThemeId,
  isValidColorValue,
  isValidTheme,
  isValidTokenValue,
  materializeTokenValue,
  materializeTokens,
  parseLength,
  resolveTokens,
  setActiveThemeId,
  themeTokensToStyle,
  tokensToCss,
  updateCustomTheme,
} from "./registry";
import type { ThemeDefinition } from "./types";

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

function installLocalStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
}

function uninstallLocalStorage() {
  Reflect.deleteProperty(globalThis, "localStorage");
}

describe("findTheme", () => {
  it("returns the default theme when the id is unknown", () => {
    expect(findTheme("does-not-exist").id).toBe(DEFAULT_THEME_ID);
  });

  it("returns the default theme when the id is null or undefined", () => {
    expect(findTheme(null).id).toBe(DEFAULT_THEME_ID);
    expect(findTheme(undefined).id).toBe(DEFAULT_THEME_ID);
  });

  it("returns the matching built-in theme when present", () => {
    const found = findTheme("midnight-graphite");
    expect(found.id).toBe("midnight-graphite");
    expect(found.builtIn).toBe(true);
  });
});

describe("resolveTokens", () => {
  it("returns the default tokens when overlay is empty", () => {
    const overlay: ThemeDefinition = { id: "empty", name: "Empty" };
    expect(resolveTokens(overlay, "light")).toEqual(DEFAULT_THEME.light);
    expect(resolveTokens(overlay, "dark")).toEqual(DEFAULT_THEME.dark);
  });

  it("merges overlay tokens on top of the default base", () => {
    const overlay: ThemeDefinition = {
      id: "patchy",
      name: "Patchy",
      light: { primary: "#ff0000" },
    };
    const merged = resolveTokens(overlay, "light");
    expect(merged.primary).toBe("#ff0000");
    expect(merged.foreground).toBe(DEFAULT_THEME.light?.foreground);
    expect(merged.background).toBe(DEFAULT_THEME.light?.background);
  });

  it("falls back to default tokens when the requested variant is undefined on the overlay", () => {
    const overlay: ThemeDefinition = {
      id: "light-only",
      name: "Light Only",
      light: { primary: "#abc123" },
    };
    const dark = resolveTokens(overlay, "dark");
    expect(dark).toEqual(DEFAULT_THEME.dark);
    const light = resolveTokens(overlay, "light");
    expect(light.primary).toBe("#abc123");
  });
});

describe("tokensToCss", () => {
  it("emits each token as `--name: value;` with single-space separators", () => {
    const css = tokensToCss({ primary: "#fff", background: "#000" });
    expect(css).toBe("--primary: #fff; --background: #000;");
  });

  it("returns an empty string when no tokens are provided", () => {
    expect(tokensToCss({})).toBe("");
  });

  it("skips tokens with empty or non-string values", () => {
    const tokens = {
      primary: "#fff",
      background: "",
      foreground: undefined,
    } as unknown as Parameters<typeof tokensToCss>[0];
    expect(tokensToCss(tokens)).toBe("--primary: #fff;");
  });

  it("preserves token name verbatim including dashes", () => {
    const css = tokensToCss({ "scrollbar-thumb": "rgba(0,0,0,0.1)" });
    expect(css).toBe("--scrollbar-thumb: rgba(0,0,0,0.1);");
  });

  it("drops tokens whose name is not in the allow-list (CSS injection guard)", () => {
    const css = tokensToCss({
      primary: "#fff",
      "evil-key; }:root{--primary": "red",
    } as unknown as Parameters<typeof tokensToCss>[0]);
    expect(css).toBe("--primary: #fff;");
  });

  it("drops values that contain `;` or `}` (rule-break injection)", () => {
    const css = tokensToCss({
      primary: "red; --secondary: blue",
      background: "#000 } evil { color: red",
      foreground: "#abc",
    } as unknown as Parameters<typeof tokensToCss>[0]);
    expect(css).toBe("--foreground: #abc;");
  });

  it("drops values that fail isValidColorValue (e.g. javascript:)", () => {
    const css = tokensToCss({
      primary: "javascript:alert(1)",
      background: "#000",
    } as unknown as Parameters<typeof tokensToCss>[0]);
    expect(css).toBe("--background: #000;");
  });

  it("drops global appearance tokens that are controlled outside themes", () => {
    const css = tokensToCss({
      primary: "#fff",
      "font-family-sans": '"Geist", sans-serif',
      "font-family-mono": '"Geist Mono", monospace',
      radius: "2rem",
      "font-size-base": "20px",
    });
    expect(css).toBe("--primary: #fff;");
  });
});

describe("themeTokensToStyle", () => {
  it("emits each token as a custom property", () => {
    expect(themeTokensToStyle({ primary: "#fff", "scrollbar-thumb": "rgba(0,0,0,0.1)" })).toEqual({
      "--primary": "#fff",
      "--scrollbar-thumb": "rgba(0,0,0,0.1)",
    });
  });

  it("applies the same guards as tokensToCss", () => {
    const tokens = {
      primary: "#fff",
      background: "",
      foreground: undefined,
      "evil-key; }:root{--primary": "red",
      secondary: "red; --accent: blue",
      accent: "#000 } evil { color: red",
      border: "javascript:alert(1)",
      radius: "2rem",
      "font-family-sans": '"Geist", sans-serif',
    } as unknown as Parameters<typeof themeTokensToStyle>[0];
    expect(themeTokensToStyle(tokens)).toEqual({ "--primary": "#fff" });
    expect(tokensToCss(tokens)).toBe("--primary: #fff;");
  });

  it("matches tokensToCss for every built-in theme variant", () => {
    for (const theme of BUILT_IN_THEMES) {
      for (const variant of ["light", "dark"] as const) {
        const tokens = materializeTokens(resolveTokens(theme, variant));
        const css = Object.entries(themeTokensToStyle(tokens))
          .map(([name, value]) => `${name}: ${value};`)
          .join(" ");
        expect(css).toBe(tokensToCss(tokens));
      }
    }
  });
});

describe("isBuiltInThemeId", () => {
  it("recognizes shipped built-in themes", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(isBuiltInThemeId(theme.id)).toBe(true);
    }
  });

  it("returns false for unknown ids", () => {
    expect(isBuiltInThemeId("custom-thing")).toBe(false);
    expect(isBuiltInThemeId("")).toBe(false);
  });
});

describe("getActiveThemeId", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    uninstallLocalStorage();
  });

  it("falls back to the default theme when a stored id no longer exists", () => {
    localStorage.setItem(ACTIVE_THEME_STORAGE_KEY, "solarized-dark");

    expect(getActiveThemeId()).toBe(DEFAULT_THEME_ID);
  });
});

describe("built-in themes", () => {
  it("uses unique ids", () => {
    const ids = BUILT_IN_THEMES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("resolves every built-in theme to valid light and dark CSS", () => {
    for (const theme of BUILT_IN_THEMES) {
      const lightCss = tokensToCss(resolveTokens(theme, "light"));
      const darkCss = tokensToCss(resolveTokens(theme, "dark"));
      expect(lightCss, `${theme.id} light`).toContain("--background:");
      expect(lightCss, `${theme.id} light`).toContain("--primary:");
      expect(darkCss, `${theme.id} dark`).toContain("--background:");
      expect(darkCss, `${theme.id} dark`).toContain("--primary:");
    }
  });

  it("ships combined light and dark variants for dual-mode popular presets", () => {
    expect(findTheme("github")).toMatchObject({
      id: "github",
      light: expect.any(Object),
      dark: expect.any(Object),
    });
    expect(findTheme("catppuccin")).toMatchObject({
      id: "catppuccin",
      light: expect.any(Object),
      dark: expect.any(Object),
    });
  });
});

describe("parseLength", () => {
  it("parses common length values", () => {
    expect(parseLength("16px")).toEqual({ number: 16, unit: "px" });
    expect(parseLength("0.625rem")).toEqual({ number: 0.625, unit: "rem" });
    expect(parseLength("  2em  ")).toEqual({ number: 2, unit: "em" });
    expect(parseLength("100%")).toEqual({ number: 100, unit: "%" });
  });

  it("returns null for non-length values", () => {
    expect(parseLength("")).toBeNull();
    expect(parseLength("clamp(1rem, 2vw, 2rem)")).toBeNull();
    expect(parseLength("blue")).toBeNull();
    expect(parseLength("16")).toBeNull();
  });

  it("normalizes the unit to lowercase", () => {
    expect(parseLength("16PX")).toEqual({ number: 16, unit: "px" });
    expect(parseLength("0.5REM")).toEqual({ number: 0.5, unit: "rem" });
  });
});

describe("isValidTokenValue", () => {
  it("validates colors against the forbidden-pattern allow-list", () => {
    expect(isValidTokenValue("color", "#fff")).toBe(true);
    expect(isValidTokenValue("color", "var(--color-blue-500)")).toBe(true);
    expect(isValidTokenValue("color", "")).toBe(false);
    expect(isValidTokenValue("color", "javascript:alert(1)")).toBe(false);
  });

  it("validates opacity as a number in [0, 1]", () => {
    expect(isValidTokenValue("opacity", "0")).toBe(true);
    expect(isValidTokenValue("opacity", "0.5")).toBe(true);
    expect(isValidTokenValue("opacity", "1")).toBe(true);
    expect(isValidTokenValue("opacity", "1.0001")).toBe(false);
    expect(isValidTokenValue("opacity", "-0.1")).toBe(false);
    expect(isValidTokenValue("opacity", "blue")).toBe(false);
    expect(isValidTokenValue("opacity", "")).toBe(false);
  });

  it("validates length as a number+unit", () => {
    expect(isValidTokenValue("length", "16px")).toBe(true);
    expect(isValidTokenValue("length", "0.625rem")).toBe(true);
    expect(isValidTokenValue("length", "16")).toBe(false);
    expect(isValidTokenValue("length", "px")).toBe(false);
    expect(isValidTokenValue("length", "javascript:alert(1)")).toBe(false);
  });

  it("validates font-family as a non-empty string with no forbidden patterns", () => {
    expect(isValidTokenValue("font-family", "DM Sans, sans-serif")).toBe(true);
    expect(isValidTokenValue("font-family", '"Inter", system-ui')).toBe(true);
    expect(isValidTokenValue("font-family", "")).toBe(false);
    expect(isValidTokenValue("font-family", "<script>")).toBe(false);
  });

  it("rejects values longer than 200 chars", () => {
    expect(isValidTokenValue("color", "a".repeat(201))).toBe(false);
    expect(isValidTokenValue("font-family", "a".repeat(201))).toBe(false);
  });
});

describe("isValidColorValue", () => {
  it("accepts ordinary CSS color values", () => {
    expect(isValidColorValue("#fff")).toBe(true);
    expect(isValidColorValue("rgba(0,0,0,0.1)")).toBe(true);
    expect(isValidColorValue("oklch(0.5 0.2 264)")).toBe(true);
    expect(isValidColorValue("var(--color-blue-500)")).toBe(true);
    expect(isValidColorValue("color-mix(in srgb, #000 80%, #fff)")).toBe(true);
  });

  it("rejects empty / non-string / dangerous values", () => {
    expect(isValidColorValue("")).toBe(false);
    expect(isValidColorValue("   ")).toBe(false);
    expect(isValidColorValue("javascript:alert(1)")).toBe(false);
    expect(isValidColorValue("url(javascript:alert(1))")).toBe(false);
    expect(isValidColorValue("expression(alert(1))")).toBe(false);
    expect(isValidColorValue("<script>")).toBe(false);
    expect(isValidColorValue("a".repeat(201))).toBe(false);
  });
});

describe("materializeTokenValue", () => {
  it("passes through values that don't contain --alpha(", () => {
    expect(materializeTokenValue("#fff")).toBe("#fff");
    expect(materializeTokenValue("rgb(0,0,0)")).toBe("rgb(0,0,0)");
    expect(materializeTokenValue("var(--color-blue-500)")).toBe("var(--color-blue-500)");
    expect(materializeTokenValue("")).toBe("");
  });

  it("converts a single --alpha(<color> / <pct>%) to color-mix(...)", () => {
    expect(materializeTokenValue("--alpha(var(--color-blue-500) / 50%)")).toBe(
      "color-mix(in srgb, var(--color-blue-500) 50%, transparent)",
    );
    expect(materializeTokenValue("--alpha(#abc / 25%)")).toBe(
      "color-mix(in srgb, #abc 25%, transparent)",
    );
  });

  it("handles --alpha(...) with surrounding text", () => {
    const result = materializeTokenValue("1px solid --alpha(var(--color-zinc-300) / 60%) inset");
    expect(result).toBe(
      "1px solid color-mix(in srgb, var(--color-zinc-300) 60%, transparent) inset",
    );
  });

  it("converts multiple --alpha(...) instances in the same string", () => {
    const input = "--alpha(#fff / 50%) --alpha(#000 / 25%)";
    expect(materializeTokenValue(input)).toBe(
      "color-mix(in srgb, #fff 50%, transparent) color-mix(in srgb, #000 25%, transparent)",
    );
  });

  it("handles nested parens inside --alpha(...)", () => {
    const result = materializeTokenValue("--alpha(oklch(0.5 0.2 264) / 40%)");
    expect(result).toBe("color-mix(in srgb, oklch(0.5 0.2 264) 40%, transparent)");
  });

  it("leaves --alpha() without a slash separator unchanged-shaped (no conversion)", () => {
    const input = "--alpha(no-slash-here)";
    expect(materializeTokenValue(input)).toBe(input);
  });
});

describe("materializeTokens", () => {
  it("returns an empty bag when given an empty bag", () => {
    expect(materializeTokens({})).toEqual({});
  });

  it("materializes --alpha(...) for each value in the bag", () => {
    const out = materializeTokens({
      primary: "#abc",
      border: "--alpha(var(--color-blue-500) / 50%)",
    });
    expect(out).toEqual({
      primary: "#abc",
      border: "color-mix(in srgb, var(--color-blue-500) 50%, transparent)",
    });
  });
});

describe("isValidTheme", () => {
  it("accepts a minimal valid theme", () => {
    expect(isValidTheme({ id: "x", name: "X" })).toBe(true);
    expect(
      isValidTheme({ id: "x", name: "X", light: { primary: "#fff" }, dark: { primary: "#000" } }),
    ).toBe(true);
  });

  it("rejects malformed themes", () => {
    expect(isValidTheme(null)).toBe(false);
    expect(isValidTheme({})).toBe(false);
    expect(isValidTheme({ id: "x" })).toBe(false);
    expect(isValidTheme({ id: 1, name: "x" })).toBe(false);
    expect(isValidTheme({ id: "", name: "x" })).toBe(false);
    expect(isValidTheme({ id: "x", name: "" })).toBe(false);
    expect(isValidTheme({ id: "x", name: "X", light: { primary: 1 } })).toBe(false);
  });
});

describe("custom theme storage", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    uninstallLocalStorage();
  });

  it("starts empty", () => {
    expect(getCustomThemes()).toEqual([]);
    expect(getAllThemes().every((theme) => theme.builtIn === true)).toBe(true);
  });

  it("addCustomTheme appends and persists", () => {
    const theme: ThemeDefinition = { id: "alpha", name: "Alpha", builtIn: false };
    addCustomTheme(theme);
    expect(getCustomThemes()).toEqual([theme]);
    const raw = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual([theme]);
  });

  it("getAllThemes lists built-ins first then custom", () => {
    const custom: ThemeDefinition = { id: "alpha", name: "Alpha", builtIn: false };
    addCustomTheme(custom);
    const all = getAllThemes();
    expect(all[0]?.id).toBe(DEFAULT_THEME_ID);
    expect(all.at(-1)?.id).toBe("alpha");
  });

  it("generateCustomThemeId avoids collisions and prefixes built-in ids", () => {
    expect(generateCustomThemeId("default")).toBe("custom-default");
    addCustomTheme({ id: "custom-default", name: "Forked", builtIn: false });
    expect(generateCustomThemeId("default")).toBe("custom-default-2");
    addCustomTheme({ id: "custom-default-2", name: "Forked Again", builtIn: false });
    expect(generateCustomThemeId("default")).toBe("custom-default-3");
    expect(generateCustomThemeId("custom-x")).toBe("custom-x");
  });

  it("duplicateTheme of the default theme yields an empty patch so tokens fall back through resolveTokens", () => {
    const copy = duplicateTheme(DEFAULT_THEME);
    expect(copy.id).not.toBe(DEFAULT_THEME_ID);
    expect(copy.id.startsWith("custom-")).toBe(true);
    expect(copy.builtIn).toBe(false);
    expect(copy.name).toBe(`${DEFAULT_THEME.name} (Copy)`);
    expect(copy.light).toBeUndefined();
    expect(copy.dark).toBeUndefined();
    expect(resolveTokens(copy, "light")).toEqual(DEFAULT_THEME.light);
    expect(resolveTokens(copy, "dark")).toEqual(DEFAULT_THEME.dark);
  });

  it("duplicateTheme of a non-default theme copies the patch and materializes --alpha(...) values", () => {
    const source: ThemeDefinition = {
      id: "fancy",
      name: "Fancy",
      description: "Fancy theme.",
      builtIn: true,
      light: { primary: "#abc", border: "--alpha(var(--color-blue-500) / 50%)" },
      dark: { primary: "#def" },
    };
    const copy = duplicateTheme(source);
    expect(copy.id).not.toBe("fancy");
    expect(copy.builtIn).toBe(false);
    expect(copy.description).toBe("Fancy theme.");
    expect(copy.light?.primary).toBe("#abc");
    expect(copy.light?.border).toBe("color-mix(in srgb, var(--color-blue-500) 50%, transparent)");
    expect(copy.dark).toEqual({ primary: "#def" });
  });

  it("updateCustomTheme replaces the matching entry and forces builtIn=false", () => {
    const seed: ThemeDefinition = { id: "alpha", name: "Alpha", builtIn: false };
    addCustomTheme(seed);
    updateCustomTheme("alpha", { id: "alpha", name: "Alpha v2", light: { primary: "#abc" } });
    const stored = getCustomThemes();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: "alpha", name: "Alpha v2", builtIn: false });
    expect(stored[0]?.light).toEqual({ primary: "#abc" });
  });

  it("updateCustomTheme rotates the active theme id when the id changes", () => {
    addCustomTheme({ id: "alpha", name: "Alpha", builtIn: false });
    setActiveThemeId("alpha");
    updateCustomTheme("alpha", { id: "alpha-renamed", name: "Alpha", builtIn: false });
    expect(getActiveThemeId()).toBe("alpha-renamed");
    expect(getCustomThemes().map((theme) => theme.id)).toEqual(["alpha-renamed"]);
  });

  it("updateCustomTheme throws if renaming would collide with another existing theme", () => {
    addCustomTheme({ id: "alpha", name: "Alpha", builtIn: false });
    addCustomTheme({ id: "beta", name: "Beta", builtIn: false });
    expect(() =>
      updateCustomTheme("alpha", { id: "beta", name: "Alpha", builtIn: false }),
    ).toThrow();
    expect(() =>
      updateCustomTheme("alpha", { id: "default", name: "Alpha", builtIn: false }),
    ).toThrow();
  });

  it("deleteCustomTheme removes the entry and falls back to default if it was active", () => {
    addCustomTheme({ id: "alpha", name: "Alpha", builtIn: false });
    setActiveThemeId("alpha");
    deleteCustomTheme("alpha");
    expect(getCustomThemes()).toEqual([]);
    expect(getActiveThemeId()).toBe(DEFAULT_THEME_ID);
  });

  it("deleteCustomTheme refuses to delete built-in themes", () => {
    deleteCustomTheme(DEFAULT_THEME_ID);
    expect(getAllThemes().some((theme) => theme.id === DEFAULT_THEME_ID)).toBe(true);
    expect(localStorage.getItem(ACTIVE_THEME_STORAGE_KEY)).toBeNull();
  });

  it("deleteCustomTheme of the active theme also removes the injected <style> tag", () => {
    const styleNodes: Array<{ id: string; textContent: string; remove: () => void }> = [];
    Object.defineProperty(globalThis, "HTMLStyleElement", {
      configurable: true,
      value: class FakeStyle {
        id = "";
        textContent = "";
        remove() {
          const i = styleNodes.indexOf(this);
          if (i >= 0) styleNodes.splice(i, 1);
        }
      },
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: (id: string) => styleNodes.find((node) => node.id === id) ?? null,
        createElement: () => {
          const Style = (
            globalThis as unknown as { HTMLStyleElement: new () => (typeof styleNodes)[number] }
          ).HTMLStyleElement;
          return new Style();
        },
        head: {
          append: (node: (typeof styleNodes)[number]) => {
            styleNodes.push(node);
          },
        },
      },
    });

    addCustomTheme({ id: "alpha", name: "Alpha", builtIn: false, light: { primary: "#abc" } });
    setActiveThemeId("alpha");
    applyThemeToDocument({
      id: "alpha",
      name: "Alpha",
      builtIn: false,
      light: { primary: "#abc" },
    });
    expect(styleNodes.find((node) => node.id === THEME_STYLE_ELEMENT_ID)).toBeDefined();

    deleteCustomTheme("alpha");
    expect(styleNodes.find((node) => node.id === THEME_STYLE_ELEMENT_ID)).toBeUndefined();
    expect(getActiveThemeId()).toBe(DEFAULT_THEME_ID);

    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLStyleElement");
  });
});

describe("applyThemeToDocument", () => {
  class FakeStyle {
    id = "";
    textContent = "";
  }
  let appended: FakeStyle[];

  beforeEach(() => {
    appended = [];
    Object.defineProperty(globalThis, "HTMLStyleElement", {
      configurable: true,
      value: FakeStyle,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        getElementById: (id: string) => appended.find((node) => node.id === id) ?? null,
        createElement: () => new FakeStyle(),
        head: {
          append: (node: FakeStyle) => {
            appended.push(node);
          },
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLStyleElement");
  });

  it("never emits raw --alpha(...) into the runtime style tag (would collapse to white/black)", () => {
    applyThemeToDocument({
      id: "custom-default",
      name: "Default Copy",
      builtIn: false,
    });
    const style = appended.find((node) => node.id === THEME_STYLE_ELEMENT_ID);
    expect(style).toBeDefined();
    expect(style?.textContent).not.toMatch(/--alpha\(/);
    expect(style?.textContent).toMatch(/color-mix\(in srgb, /);
  });

  it("converts --alpha() in user-supplied overlay tokens too", () => {
    applyThemeToDocument({
      id: "custom-x",
      name: "X",
      builtIn: false,
      light: { primary: "--alpha(#ff0000 / 50%)" },
    });
    const style = appended.find((node) => node.id === THEME_STYLE_ELEMENT_ID);
    expect(style?.textContent).toContain("color-mix(in srgb, #ff0000 50%, transparent)");
    expect(style?.textContent).not.toContain("--alpha(");
  });
});
