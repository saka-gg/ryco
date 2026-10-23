import { useSyncExternalStore } from "react";

import { COLOR_MODE_OPTIONS, useTheme } from "../hooks/useTheme";
import { cn } from "../lib/utils";
import {
  DEFAULT_THEME,
  getThemeListSnapshot,
  materializeTokens,
  resolveTokens,
  subscribeThemeRegistry,
  themeTokensToStyle,
} from "../themes/registry";
import type { ThemeDefinition, ThemeVariant } from "../themes/types";
import type { CommandPaletteActionItem, CommandPaletteSubmenuItem } from "./CommandPalette.logic";

export type AppearancePaletteInput = ReturnType<typeof useTheme> & {
  readonly themes: ReadonlyArray<ThemeDefinition>;
};

const CURRENT_MARKER = <span className="shrink-0 text-muted-foreground/70 text-xs">Current</span>;

/** The theme's background with dots of its primary and foreground colors. */
function ThemeSwatchFill(props: {
  readonly theme: ThemeDefinition;
  readonly variant: ThemeVariant;
  readonly className?: string;
}) {
  return (
    <span
      style={themeTokensToStyle(materializeTokens(resolveTokens(props.theme, props.variant)))}
      className={cn(
        "absolute inset-0 flex items-center justify-center gap-px bg-[var(--background)]",
        props.className,
      )}
    >
      <span className="size-1.5 rounded-full bg-[var(--primary)]" />
      <span className="size-1 rounded-full bg-[var(--foreground)]" />
    </span>
  );
}

/** A theme in one color mode; System shows light and dark halves, as in Settings. */
function ThemeSwatch(props: {
  readonly theme: ThemeDefinition;
  readonly mode: ThemeVariant | "system";
}) {
  return (
    <span
      aria-hidden="true"
      className="relative size-4 shrink-0 overflow-hidden rounded-full border border-border"
    >
      <ThemeSwatchFill theme={props.theme} variant={props.mode === "dark" ? "dark" : "light"} />
      {props.mode === "system" ? (
        <ThemeSwatchFill
          theme={props.theme}
          variant="dark"
          className="[clip-path:inset(0_0_0_50%)]"
        />
      ) : null}
    </span>
  );
}

/**
 * "Change theme…" and "Change color mode…": the palette's way to the two
 * pickers of Settings → Appearance, through the same setters.
 */
export function buildAppearancePaletteItems(
  input: AppearancePaletteInput,
): readonly [CommandPaletteSubmenuItem, CommandPaletteSubmenuItem] {
  const activeTheme =
    input.themes.find((theme) => theme.id === input.activeThemeId) ?? DEFAULT_THEME;
  const themeItems = input.themes.map((theme): CommandPaletteActionItem => ({
    kind: "action",
    value: `theme:${theme.id}`,
    searchTerms: [theme.name, theme.description ?? ""],
    title: theme.name,
    icon: <ThemeSwatch theme={theme} mode={input.resolvedTheme} />,
    titleTrailingContent: theme.id === activeTheme.id ? CURRENT_MARKER : null,
    run: async () => {
      input.setActiveTheme(theme.id);
    },
  }));
  const colorModeItems = COLOR_MODE_OPTIONS.map((option): CommandPaletteActionItem => ({
    kind: "action",
    value: `color-mode:${option.value}`,
    searchTerms: [option.label],
    title: option.label,
    icon: <ThemeSwatch theme={activeTheme} mode={option.value} />,
    titleTrailingContent: option.value === input.theme ? CURRENT_MARKER : null,
    run: async () => {
      input.setTheme(option.value);
    },
  }));
  const themeSwatch = <ThemeSwatch theme={activeTheme} mode={input.resolvedTheme} />;
  const colorModeSwatch = <ThemeSwatch theme={activeTheme} mode="system" />;

  return [
    {
      kind: "submenu",
      value: "action:change-theme",
      searchTerms: [
        "change theme",
        "theme palette",
        "colors",
        "appearance",
        ...input.themes.map((theme) => theme.name),
      ],
      title: "Change theme…",
      icon: themeSwatch,
      addonIcon: themeSwatch,
      groups: [{ value: "themes", label: "Themes", items: themeItems }],
    },
    {
      kind: "submenu",
      value: "action:change-color-mode",
      searchTerms: ["change color mode", "appearance", "light mode", "dark mode", "system"],
      title: "Change color mode…",
      icon: colorModeSwatch,
      addonIcon: colorModeSwatch,
      groups: [{ value: "color-modes", label: "Color mode", items: colorModeItems }],
    },
  ];
}

export function useAppearancePaletteItems(): ReturnType<typeof buildAppearancePaletteItems> {
  const themeControls = useTheme();
  const themes = useSyncExternalStore(subscribeThemeRegistry, getThemeListSnapshot);
  return buildAppearancePaletteItems({ ...themeControls, themes });
}
