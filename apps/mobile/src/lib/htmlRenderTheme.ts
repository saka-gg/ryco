import {
  HTML_RENDER_DEFAULT_FONTS,
  htmlRenderTheme,
  type HtmlRenderTheme,
} from "@ryco/shared/htmlRender";
import {
  defaultThemeColors,
  THEME_COLOR_TOKENS,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeColorToken,
} from "@ryco/shared/themePalettes";
import { useMemo } from "react";
import { useColorScheme } from "react-native";
import { useCSSVariable } from "uniwind";

/**
 * The mobile token each render color reads from (`global.css`). The page sits
 * on the thread's canvas, so `background` is the screen color the feed paints.
 * Mobile has no separate info or foreground roles for its status colors, so
 * those reuse the nearest token: the accent blue for info, the markdown link
 * color for links, and each status color for its own text.
 */
export const MOBILE_HTML_RENDER_TOKENS: Readonly<Record<ThemeColorToken, `--color-${string}`>> = {
  background: "--color-screen",
  foreground: "--color-foreground",
  card: "--color-card",
  "card-foreground": "--color-foreground",
  popover: "--color-card-alt",
  "popover-foreground": "--color-foreground",
  primary: "--color-primary",
  "primary-foreground": "--color-primary-foreground",
  secondary: "--color-secondary",
  "secondary-foreground": "--color-secondary-foreground",
  muted: "--color-subtle",
  "muted-foreground": "--color-foreground-muted",
  destructive: "--color-danger-foreground",
  "destructive-foreground": "--color-danger-foreground",
  border: "--color-border",
  input: "--color-input-border",
  ring: "--color-accent",
  info: "--color-accent",
  "info-foreground": "--color-md-link",
  success: "--color-success",
  "success-foreground": "--color-success",
  warning: "--color-warning",
  "warning-foreground": "--color-warning",
};

const MOBILE_TOKEN_NAMES = THEME_COLOR_TOKENS.map((token) => MOBILE_HTML_RENDER_TOKENS[token]);

/**
 * The theme a render wears on mobile, from the app's resolved CSS variables.
 * A token the platform cannot resolve falls back to Ryco's default palette, so
 * every variable a page styles against is always defined. WebViews cannot load
 * the app's bundled fonts, so renders use the system stacks.
 */
export function mobileHtmlRenderTheme(
  readToken: (name: `--color-${string}`) => unknown,
  appearance: ThemeAppearance,
): HtmlRenderTheme {
  const fallback = defaultThemeColors(appearance);
  const colors = Object.fromEntries(
    THEME_COLOR_TOKENS.map((token) => {
      const value = readToken(MOBILE_HTML_RENDER_TOKENS[token]);
      return [
        token,
        typeof value === "string" && value.trim() !== "" ? value.trim() : fallback[token],
      ];
    }),
  ) as ThemeColors;
  return htmlRenderTheme(colors, appearance, { fonts: HTML_RENDER_DEFAULT_FONTS });
}

function themeFromSignature(signature: string): HtmlRenderTheme {
  const [appearance, values] = JSON.parse(signature) as [ThemeAppearance, ReadonlyArray<unknown>];
  const byName = new Map(MOBILE_TOKEN_NAMES.map((name, index) => [name, values[index]]));
  return mobileHtmlRenderTheme((name) => byName.get(name), appearance);
}

/**
 * The live render theme. It is a new object only when a resolved color or the
 * appearance changes, because a new theme is posted into every mounted page.
 */
export function useMobileHtmlRenderTheme(): HtmlRenderTheme {
  const appearance: ThemeAppearance = useColorScheme() === "light" ? "light" : "dark";
  const signature = JSON.stringify([appearance, useCSSVariable(MOBILE_TOKEN_NAMES)]);
  return useMemo(() => themeFromSignature(signature), [signature]);
}
