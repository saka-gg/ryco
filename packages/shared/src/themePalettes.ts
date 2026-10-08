/**
 * Resolved sRGB values of the default Ryco theme (`apps/web/src/index.css`),
 * for surfaces that cannot read the app's CSS: the server's headless HTML
 * render browser and the default CSS baked into a stored HTML render. Keyed by
 * the app's own token names. Clients with a live theme read it instead.
 */

export type ThemeAppearance = "light" | "dark";

export const THEME_COLOR_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
] as const;

export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];

/** CSS colors for every theme token; any syntax a browser accepts. */
export type ThemeColors = Readonly<Record<ThemeColorToken, string>>;

export const RYCO_LIGHT_THEME_COLORS: ThemeColors = {
  background: "#ffffff",
  foreground: "#262626",
  card: "#ffffff",
  "card-foreground": "#262626",
  popover: "#ffffff",
  "popover-foreground": "#262626",
  primary: "#171717",
  "primary-foreground": "#ffffff",
  secondary: "rgba(0, 0, 0, 0.05)",
  "secondary-foreground": "#262626",
  muted: "rgba(0, 0, 0, 0.045)",
  "muted-foreground": "#686868",
  destructive: "#fb2c36",
  "destructive-foreground": "#c10007",
  border: "rgba(0, 0, 0, 0.1)",
  input: "rgba(0, 0, 0, 0.12)",
  ring: "#525252",
  info: "#2b7fff",
  "info-foreground": "#1447e6",
  success: "#00bc7d",
  "success-foreground": "#007a55",
  warning: "#fe9a00",
  "warning-foreground": "#bb4d00",
};

export const RYCO_DARK_THEME_COLORS: ThemeColors = {
  background: "#0b0b0c",
  foreground: "#ececed",
  card: "#151516",
  "card-foreground": "#ececed",
  popover: "#1a1a1b",
  "popover-foreground": "#ececed",
  primary: "#e4e4e5",
  "primary-foreground": "#0b0b0c",
  secondary: "rgba(255, 255, 255, 0.07)",
  "secondary-foreground": "#ececed",
  muted: "rgba(255, 255, 255, 0.06)",
  "muted-foreground": "#b2b2b2",
  destructive: "#fb414a",
  "destructive-foreground": "#ff6467",
  border: "rgba(255, 255, 255, 0.09)",
  input: "rgba(255, 255, 255, 0.12)",
  ring: "#a1a1a6",
  info: "#2b7fff",
  "info-foreground": "#51a2ff",
  success: "#00bc7d",
  "success-foreground": "#00d492",
  warning: "#fe9a00",
  "warning-foreground": "#ffb900",
};

export const RYCO_DEFAULT_RADIUS = "0.625rem";

export function defaultThemeColors(appearance: ThemeAppearance): ThemeColors {
  return appearance === "light" ? RYCO_LIGHT_THEME_COLORS : RYCO_DARK_THEME_COLORS;
}
