import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { DEFAULT_THEME, DEFAULT_THEME_ID } from "./builtin";
import {
  ACTIVE_THEME_STORAGE_KEY,
  addCustomTheme,
  getCustomThemes,
  setCustomThemes,
} from "./registry";
import {
  importThemesFromFiles,
  THEME_FILE_EXTENSION,
  decodeThemeFromBase64,
  encodeThemeToBase64,
  importTheme,
  importThemeFromFile,
  parseTheme,
  serializeTheme,
  themeFilename,
} from "./transport";
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

describe("themeFilename", () => {
  it("slugifies the name and appends the standard extension", () => {
    expect(themeFilename({ id: "x", name: "My Theme" })).toBe(`My-Theme${THEME_FILE_EXTENSION}`);
    expect(themeFilename({ id: "x", name: "Solar / Dark!" })).toBe(
      `Solar-Dark${THEME_FILE_EXTENSION}`,
    );
  });

  it("falls back to the id when the name is empty", () => {
    expect(themeFilename({ id: "fallback", name: "" })).toBe(`fallback${THEME_FILE_EXTENSION}`);
  });

  it("uses 'theme' when both name and id are missing", () => {
    expect(themeFilename({ id: "", name: "" })).toBe(`theme${THEME_FILE_EXTENSION}`);
  });
});

describe("serializeTheme / parseTheme", () => {
  it("round-trips a fully-populated theme", () => {
    const theme: ThemeDefinition = {
      id: "alpha",
      name: "Alpha",
      description: "An optional description.",
      light: { primary: "#abc", background: "#fff" },
      dark: { primary: "#def" },
    };
    const json = serializeTheme(theme);
    const parsed = parseTheme(json);
    expect(parsed.id).toBe("alpha");
    expect(parsed.name).toBe("Alpha");
    expect(parsed.description).toBe("An optional description.");
    expect(parsed.light).toEqual({ primary: "#abc", background: "#fff" });
    expect(parsed.dark).toEqual({ primary: "#def" });
    expect(parsed.builtIn).toBe(false);
  });

  it("strips builtIn=true from the source even when explicitly present", () => {
    const json = serializeTheme({ ...DEFAULT_THEME });
    expect(json).not.toMatch(/"builtIn"/);
    const parsed = parseTheme(json);
    expect(parsed.builtIn).toBe(false);
  });

  it("omits optional fields when not provided", () => {
    const json = serializeTheme({ id: "x", name: "X" });
    const obj = JSON.parse(json) as Record<string, unknown>;
    expect(obj).toEqual({ id: "x", name: "X" });
  });

  it("throws on malformed JSON", () => {
    expect(() => parseTheme("{ not json")).toThrow(/parse/i);
  });

  it("throws on schema-invalid input", () => {
    expect(() => parseTheme(JSON.stringify({ id: "x" }))).toThrow(/schema/i);
    expect(() => parseTheme(JSON.stringify({ id: "x", name: "X", light: { primary: 1 } }))).toThrow(
      /schema/i,
    );
  });
});

describe("encodeThemeToBase64 / decodeThemeFromBase64", () => {
  it("round-trips a theme through base64", () => {
    const theme: ThemeDefinition = {
      id: "alpha",
      name: "Alpha",
      light: { primary: "#abc" },
    };
    const encoded = encodeThemeToBase64(theme);
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    const decoded = decodeThemeFromBase64(encoded);
    expect(decoded.id).toBe("alpha");
    expect(decoded.light).toEqual({ primary: "#abc" });
  });

  it("preserves UTF-8 characters in the name", () => {
    const theme: ThemeDefinition = { id: "u", name: "テーマ ⚡", light: { primary: "#ff0" } };
    const decoded = decodeThemeFromBase64(encodeThemeToBase64(theme));
    expect(decoded.name).toBe("テーマ ⚡");
  });

  it("rejects garbage base64 inputs", () => {
    expect(() => decodeThemeFromBase64("!!!not-base64!!!")).toThrow();
  });
});

describe("importTheme", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    uninstallLocalStorage();
  });

  it("adds a brand-new theme when no id collision exists", () => {
    const json = JSON.stringify({ id: "alpha", name: "Alpha", light: { primary: "#abc" } });
    const result = importTheme(json);
    expect(result.action).toBe("added");
    expect(result.theme.id).toBe("alpha");
    expect(getCustomThemes().map((theme) => theme.id)).toEqual(["alpha"]);
  });

  it("renames the import when colliding with a built-in id", () => {
    const json = JSON.stringify({
      id: DEFAULT_THEME_ID,
      name: "Default",
      light: { primary: "#abc" },
    });
    const result = importTheme(json, "replace");
    expect(result.action).toBe("renamed");
    expect(result.theme.id).not.toBe(DEFAULT_THEME_ID);
    expect(result.theme.id.startsWith("custom-")).toBe(true);
    expect(getCustomThemes().map((theme) => theme.id)).toEqual([result.theme.id]);
  });

  it("renames the import when colliding with another custom theme under 'rename' policy", () => {
    addCustomTheme({ id: "alpha", name: "Existing", builtIn: false });
    const json = JSON.stringify({ id: "alpha", name: "Imported", light: { primary: "#abc" } });
    const result = importTheme(json, "rename");
    expect(result.action).toBe("renamed");
    expect(result.theme.id).not.toBe("alpha");
    expect(getCustomThemes()).toHaveLength(2);
  });

  it("replaces an existing custom theme under 'replace' policy", () => {
    addCustomTheme({ id: "alpha", name: "Existing", builtIn: false });
    const json = JSON.stringify({ id: "alpha", name: "Imported", light: { primary: "#xyz" } });
    const result = importTheme(json, "replace");
    expect(result.action).toBe("replaced");
    const stored = getCustomThemes();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe("Imported");
    expect(stored[0]?.light).toEqual({ primary: "#xyz" });
  });

  it("propagates parse errors instead of writing to storage", () => {
    setCustomThemes([{ id: "seed", name: "Seed", builtIn: false }]);
    expect(() => importTheme("{ malformed")).toThrow();
    expect(getCustomThemes().map((theme) => theme.id)).toEqual(["seed"]);
  });
});

describe("importThemeFromFile", () => {
  beforeEach(() => {
    installLocalStorage();
  });

  afterEach(() => {
    uninstallLocalStorage();
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLStyleElement");
  });

  it("applies the theme to the document when activate=true (no reliance on storage events)", async () => {
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
            globalThis as unknown as {
              HTMLStyleElement: new () => (typeof styleNodes)[number];
            }
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

    const json = JSON.stringify({
      id: "alpha",
      name: "Alpha",
      light: { primary: "#abcabc" },
    });
    const file = new File([json], "alpha.json", { type: "application/json" });

    const result = await importThemeFromFile(file, { activate: true });
    expect(result.action).toBe("added");

    const style = styleNodes.find((node) => node.id === "ryco-active-theme");
    expect(style).toBeDefined();
    expect(style?.textContent).toContain("--primary: #abcabc;");
  });

  it("does not touch the document when activate is false", async () => {
    const accessed: string[] = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: new Proxy(
        {},
        {
          get(_, prop: string) {
            accessed.push(prop);
            return undefined;
          },
        },
      ),
    });

    const json = JSON.stringify({ id: "beta", name: "Beta", light: { primary: "#000" } });
    const file = new File([json], "beta.json", { type: "application/json" });

    await importThemeFromFile(file);
    expect(accessed).toEqual([]);
  });
});

describe("importThemesFromFiles", () => {
  beforeEach(installLocalStorage);
  afterEach(uninstallLocalStorage);

  const fileOf = (name: string, text: string) =>
    new File([text], name, { type: "application/json" });

  it("adds a VS Code color theme as a custom theme", async () => {
    const { imported } = await importThemesFromFiles([
      fileOf(
        "harbor-night-color-theme.json",
        `{ "name": "Harbor Night", "type": "dark", // JSONC
           "colors": { "editor.background": "#101820", "editor.foreground": "#d8e0e8", }, }`,
      ),
    ]);
    expect(imported).toHaveLength(1);
    expect(imported[0]?.theme).toMatchObject({
      name: "Harbor Night",
      dark: { background: "#101820" },
    });
    expect(imported[0]?.theme.light).toBeUndefined();
    expect(getCustomThemes().map((theme) => theme.name)).toEqual(["Harbor Night"]);
  });

  it("uses a picked base theme for its colors only: never as a theme, even when it comes last", async () => {
    const { imported } = await importThemesFromFiles(
      [
        fileOf(
          "harbor-dimmed.json",
          `{ "name": "Harbor Dimmed", "type": "dark", "include": "./harbor-base.json",
             "colors": { "editor.background": "#101820" } }`,
        ),
        // A base without an editor background of its own.
        fileOf("harbor-base.json", `{ "colors": { "editor.foreground": "#c0d0e0" } }`),
      ],
      { activate: true },
    );
    expect(imported.map((entry) => entry.theme.name)).toEqual(["Harbor Dimmed"]);
    expect(imported[0]?.theme.dark).toMatchObject({ foreground: "#c0d0e0" });
    expect(getCustomThemes().map((theme) => theme.name)).toEqual(["Harbor Dimmed"]);
    expect(localStorage.getItem(ACTIVE_THEME_STORAGE_KEY)).toBe(imported[0]?.theme.id);
  });

  it("refuses a file larger than 256 KiB without reading it", async () => {
    let read = false;
    const big = {
      name: "huge.json",
      size: 300 * 1024,
      text: async () => {
        read = true;
        return "{}";
      },
    } as unknown as File;
    await expect(importThemesFromFiles([big])).rejects.toThrow(/larger than 256 KiB/u);
    expect(read).toBe(false);
  });

  it("refuses a file that is neither kind of theme", async () => {
    await expect(importThemesFromFiles([fileOf("notes.json", `{ "hello": 1 }`)])).rejects.toThrow(
      /neither a Ryco theme nor a VS Code color theme/u,
    );
  });
});
