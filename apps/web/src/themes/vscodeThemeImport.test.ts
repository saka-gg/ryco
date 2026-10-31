import { describe, expect, it } from "vite-plus/test";

import { isValidTokenValue } from "./registry";
import { THEME_TOKEN_META, type ThemeTokenName } from "./types";
import {
  contrastRatio,
  convertVsCodeTheme,
  isVsCodeThemeFile,
  pairVsCodeThemes,
  parseJsonc,
  parseVsCodeColor,
} from "./vscodeThemeImport";

// Hand-written fixtures, not copies of published themes.
const darkTheme = {
  name: "harbor-night",
  type: "dark",
  colors: {
    "editor.background": "#101820",
    "editor.foreground": "#d8e0e8",
    "button.background": "#3a7bd5",
    "button.foreground": "#ffffff",
    "list.hoverBackground": "#ffffff14",
    "sideBar.background": "#0c1218",
    "editorError.foreground": "#ff5c5c",
    "scrollbarSlider.background": "#79797966",
  },
  tokenColors: [],
};

const rgb = (hex: string) => {
  const parsed = parseVsCodeColor(hex);
  if (!parsed) throw new Error(`not a color: ${hex}`);
  return parsed;
};

describe("VS Code theme import", () => {
  it("reads JSONC with comments and trailing commas, but not inside strings", () => {
    expect(
      parseJsonc(`{
        // a comment
        "name": "a // not a comment", /* block */
        "colors": { "editor.background": "#000", },
      }`),
    ).toEqual({ name: "a // not a comment", colors: { "editor.background": "#000" } });
  });

  it("fills only the theme's own variant, with the editor background as the background", () => {
    const theme = convertVsCodeTheme(darkTheme, { sourceName: "harbor-night-color-theme.json" });
    expect(theme.variant).toBe("dark");
    expect(theme.name).toBe("Harbor Night");
    expect(theme.tokens.background).toBe("#101820");
    expect(theme.tokens.foreground).toBe("#d8e0e8");
    expect(theme.tokens.primary).toBe("#3a7bd5");
    // #ffffff14 flattened over the editor background.
    expect(theme.tokens.accent).toBe("#232a31");
    // Scrollbars keep their alpha.
    expect(theme.tokens["scrollbar-thumb"]).toBe("#79797966");
    for (const [name, value] of Object.entries(theme.tokens)) {
      expect(isValidTokenValue(THEME_TOKEN_META[name as ThemeTokenName].kind, value), name).toBe(
        true,
      );
    }
  });

  it("replaces a foreground that would not be readable on its surface", () => {
    const theme = convertVsCodeTheme({
      type: "dark",
      colors: { "editor.background": "#202020", "editor.foreground": "#555555" },
    });
    expect(contrastRatio(rgb("#555555"), rgb("#202020"))).toBeLessThan(4.5);
    expect(theme.tokens.foreground).toBe("#ffffff");
  });

  it("says plainly when there is no editor background to build from", () => {
    expect(() => convertVsCodeTheme({ colors: { "editor.foreground": "#fff" } })).toThrow(
      /no "editor.background"/u,
    );
  });

  it("recognises VS Code files by their dotted workbench keys", () => {
    expect(isVsCodeThemeFile(darkTheme)).toBe(true);
    expect(isVsCodeThemeFile({ id: "custom-x", name: "X", dark: { background: "#000" } })).toBe(
      false,
    );
  });

  it("joins a light and a dark file of one family picked together into one theme", () => {
    const light = convertVsCodeTheme({
      name: "Harbor Light",
      type: "light",
      colors: { "editor.background": "#fbfbf8", "editor.foreground": "#202428" },
    });
    const dark = convertVsCodeTheme({ ...darkTheme, name: "Harbor Dark" });
    const paired = pairVsCodeThemes([light, dark]);
    expect(paired).toHaveLength(1);
    expect(paired[0]).toMatchObject({
      name: "Harbor",
      light: { background: "#fbfbf8" },
      dark: { background: "#101820" },
    });
  });

  it("builds on a base theme only when it was picked too", () => {
    const child = { include: "./harbor-base.json", colors: { "editor.foreground": "#eeeeee" } };
    const base = { colors: { "editor.background": "#101820" } };
    const theme = convertVsCodeTheme(child, {
      siblings: new Map([["harbor-base.json", base]]),
    });
    expect(theme.tokens).toMatchObject({ background: "#101820", foreground: "#eeeeee" });
    expect(() => convertVsCodeTheme(child)).toThrow(/no "editor.background"/u);
  });
});
