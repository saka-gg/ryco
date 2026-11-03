import "../index.css";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID,
  applyAppearancePreferencesToDocument,
  resetAppearancePreference,
  setAppearancePreference,
} from "./appearancePreferences";

/** An sRGB pixel of any CSS color the browser computes (oklab, color(), rgb…). */
function rgbOf(color: string): readonly [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  const channel = (value: number) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastAt(
  percent: number | null,
  dark: boolean,
  className = "text-muted-foreground bg-background",
): number {
  document.documentElement.classList.toggle("dark", dark);
  if (percent === null) resetAppearancePreference("contrast");
  else setAppearancePreference("contrast", String(percent));
  applyAppearancePreferencesToDocument();
  const probe = document.createElement("span");
  probe.className = className;
  probe.textContent = "Aa";
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const text = luminance(rgbOf(style.color));
  const surface = luminance(rgbOf(style.backgroundColor));
  probe.remove();
  const [light, darker] = text > surface ? [text, surface] : [surface, text];
  return (light + 0.05) / (darker + 0.05);
}

afterEach(() => {
  resetAppearancePreference("contrast");
  document.getElementById(APPEARANCE_PREFERENCES_STYLE_ELEMENT_ID)?.remove();
  document.documentElement.classList.remove("dark");
});

describe("appearance contrast", () => {
  for (const dark of [false, true]) {
    it(`raises and lowers muted text contrast in ${dark ? "dark" : "light"} mode`, () => {
      const theme = contrastAt(null, dark);
      const stronger = contrastAt(150, dark);
      const softer = contrastAt(50, dark);
      expect(stronger).toBeGreaterThan(theme);
      expect(softer).toBeLessThan(theme);
      // 100 % is exactly the theme.
      expect(contrastAt(100, dark)).toBeCloseTo(theme, 5);
    });

    it(`moves the active sidebar row with the rest of the sidebar in ${dark ? "dark" : "light"} mode`, () => {
      const row = "text-sidebar-accent-foreground bg-sidebar";
      const theme = contrastAt(null, dark, row);
      expect(contrastAt(150, dark, row)).toBeGreaterThan(theme);
      expect(contrastAt(50, dark, row)).toBeLessThan(theme);
    });
  }
});
