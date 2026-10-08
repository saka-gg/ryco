import "../index.css";
import {
  RYCO_DARK_THEME_COLORS,
  RYCO_LIGHT_THEME_COLORS,
  THEME_COLOR_TOKENS,
} from "@ryco/shared/themePalettes";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { applyAppearancePreferencesToDocument } from "./appearancePreferences";
import {
  getHtmlRenderThemeSnapshot,
  normalizeHtmlRenderColor,
  readHtmlRenderTheme,
  subscribeHtmlRenderTheme,
} from "./htmlRenderTheme";
import { THEME_STYLE_ELEMENT_ID } from "./registry";

const nextFrames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

function channels(color: string): [number, number, number, number] {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex) {
    return [0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).concat(1) as [
      number,
      number,
      number,
      number,
    ];
  }
  const parts = /^rgba?\(([^)]*)\)$/.exec(color)![1]!.split(",").map(Number);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.getElementById(THEME_STYLE_ELEMENT_ID)?.remove();
});

describe("readHtmlRenderTheme", () => {
  it.each([
    ["light", RYCO_LIGHT_THEME_COLORS],
    ["dark", RYCO_DARK_THEME_COLORS],
  ] as const)(
    "reads the painted %s theme as plain sRGB, matching the shared default palette",
    (appearance, palette) => {
      document.documentElement.classList.toggle("dark", appearance === "dark");
      const theme = readHtmlRenderTheme();
      expect(theme.appearance).toBe(appearance);
      for (const token of THEME_COLOR_TOKENS) {
        const value = theme.variables[`--${token}`]!;
        expect(value, token).toMatch(/^rgba?\(\d+, \d+, \d+(?:, [\d.]+)?\)$/);
        // The server bakes the shared palette into pages; it must not drift
        // from the stylesheet.
        const [r, g, b, a] = channels(value);
        const [er, eg, eb, ea] = channels(palette[token]);
        expect(Math.abs(r - er), `${token} red`).toBeLessThanOrEqual(2);
        expect(Math.abs(g - eg), `${token} green`).toBeLessThanOrEqual(2);
        expect(Math.abs(b - eb), `${token} blue`).toBeLessThanOrEqual(2);
        expect(Math.abs(a - ea), `${token} alpha`).toBeLessThanOrEqual(0.01);
      }
      // rem-based in the app; a page's rem is its own base, so it travels as px.
      expect(theme.variables["--radius"]).toBe("10px");
      expect(theme.variables["--font-sans"]).toContain("DM Sans");
      expect(theme.variables["--font-mono"]).toContain("SF Mono");
      // Ryco's brand color stands in for the render's accent.
      expect(theme.variables["--accent"]).toBe(theme.variables["--primary"]);
    },
  );

  it("normalizes every color syntax the browser computes to sRGB", () => {
    expect(normalizeHtmlRenderColor("rgba(0, 0, 0, 0.045)")).toBe("rgba(0, 0, 0, 0.045)");
    expect(normalizeHtmlRenderColor("rgb(11 11 12)")).toBe("rgb(11, 11, 12)");
    expect(normalizeHtmlRenderColor("color(srgb 1 1 1 / 0.07)")).toBe("rgba(255, 255, 255, 0.07)");
    expect(normalizeHtmlRenderColor("color(srgb 0.5 none 1)")).toBe("rgb(128, 0, 255)");
    expect(normalizeHtmlRenderColor("oklch(0.6 0.2 145)")).toMatch(/^rgb\(\d+, \d+, \d+\)$/);
    const [r, g, b] = channels(normalizeHtmlRenderColor("oklch(0.6 0.2 145)")!);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(normalizeHtmlRenderColor("color(display-p3 1 0 0)")).toBe("rgb(255, 0, 0)");
    expect(normalizeHtmlRenderColor("")).toBeUndefined();
  });
});

describe("subscribeHtmlRenderTheme", () => {
  it("notifies only when the theme actually changes", async () => {
    const listener = vi.fn();
    const stop = subscribeHtmlRenderTheme(listener);
    try {
      const initial = getHtmlRenderThemeSnapshot();
      // `useTheme()` re-applies the same theme on every mount.
      applyAppearancePreferencesToDocument();
      document.documentElement.classList.add("no-transitions");
      await nextFrames();
      document.documentElement.classList.remove("no-transitions");
      await nextFrames();
      expect(listener).not.toHaveBeenCalled();
      expect(getHtmlRenderThemeSnapshot()).toBe(initial);

      document.documentElement.classList.add("dark");
      await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
      expect(getHtmlRenderThemeSnapshot().appearance).toBe("dark");
      expect(getHtmlRenderThemeSnapshot().variables["--background"]).toBe("rgb(11, 11, 12)");
    } finally {
      stop();
    }
  });

  it("follows theme style edits that announce nothing", async () => {
    document.documentElement.classList.add("dark");
    const listener = vi.fn();
    const stop = subscribeHtmlRenderTheme(listener);
    try {
      // A theme or a live editor draft only writes this element.
      const style = document.createElement("style");
      style.id = THEME_STYLE_ELEMENT_ID;
      style.textContent = ":root.dark { --primary: oklch(0.6 0.2 145); }";
      document.head.append(style);
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
      const [r, g, b] = channels(getHtmlRenderThemeSnapshot().variables["--accent"]!);
      expect(g).toBeGreaterThan(Math.max(r, b));

      style.textContent = ":root.dark { --primary: rgb(200, 20, 20); }";
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
      expect(getHtmlRenderThemeSnapshot().variables["--primary"]).toBe("rgb(200, 20, 20)");
      // A chromatic primary leads the chart series.
      expect(getHtmlRenderThemeSnapshot().variables["--chart-1"]).toBe("rgb(200, 20, 20)");

      style.remove();
      await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(3));
      expect(getHtmlRenderThemeSnapshot().variables["--primary"]).toBe("rgb(228, 228, 229)");
    } finally {
      stop();
    }
  });

  it("reads the document afresh while nobody is subscribed", () => {
    const light = getHtmlRenderThemeSnapshot();
    expect(light.appearance).toBe("light");
    expect(getHtmlRenderThemeSnapshot()).toBe(light);
    document.documentElement.classList.add("dark");
    expect(getHtmlRenderThemeSnapshot().appearance).toBe("dark");
  });
});
