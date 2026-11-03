/**
 * How a Claude instance compacts its context (`ClaudeSettings.autoCompact` and
 * `autoCompactWindow`). Both settings are free strings so that a typo, or a value from a newer
 * client, falls back to the default instead of making the instance unavailable.
 */

/**
 * - `ryco`: Ryco sends Claude Code's `/compact` between turns at 80% of the window.
 * - `claudeCode`: Ryco never compacts; Claude Code's own auto-compaction decides.
 */
export type ClaudeAutoCompactMode = "ryco" | "claudeCode";

export const DEFAULT_CLAUDE_AUTO_COMPACT_MODE: ClaudeAutoCompactMode = "ryco";

/** The range Claude Code accepts for its `autoCompactWindow` setting. */
export const CLAUDE_AUTO_COMPACT_WINDOW_MIN = 100_000;
export const CLAUDE_AUTO_COMPACT_WINDOW_MAX = 1_000_000;

/** The configured mode; anything other than `claudeCode` is Ryco's default. */
export function resolveClaudeAutoCompactMode(raw: string): ClaudeAutoCompactMode {
  return raw.trim() === "claudeCode" ? "claudeCode" : DEFAULT_CLAUDE_AUTO_COMPACT_MODE;
}

/**
 * The configured compaction window in tokens, or undefined for the model's own window. Digit
 * group separators (`,`, `_`, spaces) are allowed; anything that is not a whole number within
 * 100,000–1,000,000 is undefined.
 */
export function parseClaudeAutoCompactWindow(raw: string): number | undefined {
  const digits = raw.replace(/[\s,_]/g, "");
  if (!/^\d+$/.test(digits)) return undefined;
  const tokens = Number(digits);
  return tokens >= CLAUDE_AUTO_COMPACT_WINDOW_MIN && tokens <= CLAUDE_AUTO_COMPACT_WINDOW_MAX
    ? tokens
    : undefined;
}
