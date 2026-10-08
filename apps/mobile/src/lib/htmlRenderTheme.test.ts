import { HTML_RENDER_DEFAULT_FONTS } from "@ryco/shared/htmlRender";
import {
  RYCO_DARK_THEME_COLORS,
  RYCO_LIGHT_THEME_COLORS,
  THEME_COLOR_TOKENS,
} from "@ryco/shared/themePalettes";
import { describe, expect, it, vi } from "vite-plus/test";

const hoisted = vi.hoisted(() => ({
  scheme: "dark" as string | null,
  read: (_name: string): unknown => undefined,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("react-native", () => ({ useColorScheme: () => hoisted.scheme }));
vi.mock("uniwind", () => ({
  useCSSVariable: (names: ReadonlyArray<string>) => names.map((name) => hoisted.read(name)),
}));

import {
  MOBILE_HTML_RENDER_TOKENS,
  mobileHtmlRenderTheme,
  useMobileHtmlRenderTheme,
} from "./htmlRenderTheme";

// The dark tokens of `global.css` as Uniwind resolves them on device (hex or
// 8-digit hex with alpha).
const DARK_TOKENS: Record<string, string> = {
  "--color-screen": "#0a0a0a",
  "--color-foreground": "#ededed",
  "--color-card": "#141414",
  "--color-card-alt": "#1f1f1f",
  "--color-primary": "#ffffff",
  "--color-primary-foreground": "#0a0a0a",
  "--color-secondary": "#ffffff0d",
  "--color-secondary-foreground": "#ededed",
  "--color-subtle": "#ffffff0a",
  "--color-foreground-muted": "#949494",
  "--color-danger-foreground": "#e0455f",
  "--color-border": "#ffffff1a",
  "--color-input-border": "#ffffff14",
  "--color-accent": "#3b82c4",
  "--color-md-link": "#60a5fa",
  "--color-success": "#2fa37a",
  "--color-warning": "#c99a3a",
};

describe("mobileHtmlRenderTheme", () => {
  it("maps every theme token to a mobile token", () => {
    expect(Object.keys(MOBILE_HTML_RENDER_TOKENS).toSorted()).toEqual(
      [...THEME_COLOR_TOKENS].toSorted(),
    );
    for (const name of Object.values(MOBILE_HTML_RENDER_TOKENS)) {
      expect(DARK_TOKENS[name], name).toBeDefined();
    }
  });

  it("paints the page with the thread's own canvas and the app's colors", () => {
    const theme = mobileHtmlRenderTheme((name) => DARK_TOKENS[name], "dark");
    expect(theme.appearance).toBe("dark");
    expect(theme.variables).toMatchObject({
      "--background": "#0a0a0a",
      "--foreground": "#ededed",
      "--card": "#141414",
      "--popover": "#1f1f1f",
      "--muted-foreground": "#949494",
      "--border": "#ffffff1a",
      "--input": "#ffffff14",
      "--ring": "#3b82c4",
      "--primary": "#ffffff",
      "--destructive": "#e0455f",
      "--success": "#2fa37a",
      "--warning": "#c99a3a",
      "--info": "#3b82c4",
      "--link": "#60a5fa",
      // A grey primary cannot stand for a chart series, so the first series is the accent.
      "--chart-1": "#3b82c4",
      "--font-sans": HTML_RENDER_DEFAULT_FONTS.sans,
      "--font-mono": HTML_RENDER_DEFAULT_FONTS.mono,
    });
    // Surfaces are plain sRGB mixes over the canvas, so a canvas-drawing page can use them.
    expect(theme.variables["--accent-surface"]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("falls back to Ryco's palette for a token the platform cannot resolve", () => {
    const dark = mobileHtmlRenderTheme(() => undefined, "dark");
    expect(dark.variables["--background"]).toBe(RYCO_DARK_THEME_COLORS.background);
    expect(dark.variables["--link"]).toBe(RYCO_DARK_THEME_COLORS["info-foreground"]);
    const light = mobileHtmlRenderTheme((name) => (name === "--color-screen" ? 12 : ""), "light");
    expect(light.appearance).toBe("light");
    expect(light.variables["--background"]).toBe(RYCO_LIGHT_THEME_COLORS.background);
    expect(light.variables["--foreground"]).toBe(RYCO_LIGHT_THEME_COLORS.foreground);
  });

  it("follows the appearance it is given", () => {
    const light = mobileHtmlRenderTheme((name) => DARK_TOKENS[name], "light");
    expect(light.appearance).toBe("light");
    expect(light.variables["--chart-2"]).toBe("#0d9488");
  });
});

describe("useMobileHtmlRenderTheme", () => {
  it("reads the live tokens and color scheme", () => {
    hoisted.read = (name) => DARK_TOKENS[name];
    hoisted.scheme = "dark";
    expect(useMobileHtmlRenderTheme()).toEqual(
      mobileHtmlRenderTheme((name) => DARK_TOKENS[name], "dark"),
    );
    hoisted.scheme = "light";
    expect(useMobileHtmlRenderTheme().appearance).toBe("light");
    // No scheme yet reads as the app's dark default.
    hoisted.scheme = null;
    expect(useMobileHtmlRenderTheme().appearance).toBe("dark");
  });
});
