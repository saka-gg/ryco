import type { CSSProperties } from "react";

import { DEFAULT_THEME, materializeTokens, themeTokensToStyle } from "~/themes/registry";

/**
 * The crown is "island material": near-black in both themes. The app's dark
 * tokens only exist on `:root` under `@variant dark`, so a `.dark` subtree
 * gets the `dark:` utilities but none of the dark variables. The island pins
 * the default dark palette inline instead.
 *
 * Tailwind's `@theme` aliases (`--color-muted-foreground: var(--muted-foreground)`)
 * are resolved where they are declared, on `:root`, so they would still carry
 * the light values in the light theme. Re-declaring them here makes every
 * colour utility inside the island resolve against the pinned dark tokens.
 */
function islandDarkTokenStyle(): CSSProperties {
  const tokens = themeTokensToStyle(materializeTokens(DEFAULT_THEME.dark ?? {}));
  const aliases: Record<string, string> = {};
  for (const name of Object.keys(tokens)) {
    aliases[`--color-${name.slice(2)}`] = `var(${name})`;
  }
  return { ...tokens, ...aliases } as CSSProperties;
}

/** Inline style for the crown root: dark tokens plus the crown's own section colours. */
export const ISLAND_DARK_TOKEN_STYLE = {
  colorScheme: "dark",
  ...islandDarkTokenStyle(),
  "--crown-plan": "#a78bfa",
  "--crown-agent": "#38bdf8",
  "--crown-merged": "#c084fc",
  "--crown-note": "#eccb6b",
  "--crown-note-ink": "#1a1406",
} as CSSProperties;
