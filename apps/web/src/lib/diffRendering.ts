export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

/**
 * Lines longer than this are not tokenized (rendered in the default color).
 * Shiki has no cap by default, and one minified line costs it up to its
 * 500 ms per-line limit; every highlighter in the app shares this bound.
 */
export const SYNTAX_TOKENIZE_MAX_LINE_LENGTH = 1_000;

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

/**
 * Shadow-DOM theming shared by every `@pierre/diffs` surface (thread diff panel,
 * pull request files): app tokens for backgrounds, add/delete tints, and a
 * sticky file header.
 */
export const DIFF_SURFACE_BASE_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-file-info] {
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
}
`;

/**
 * The gutter `+` that picks lines (drag for a range) in the app's primary
 * color rather than pierre's own blue.
 */
export const GUTTER_UTILITY_UNSAFE_CSS = `
[data-utility-button] {
  background-color: var(--primary) !important;
  color: var(--primary-foreground) !important;
}
`;

/**
 * Picked and revealed lines in a neutral tint rather than pierre's
 * modified-line blue, the same on every surface that picks lines. An
 * editor's own text selection keeps pierre's color.
 */
export const NEUTRAL_LINE_SELECTION_UNSAFE_CSS = `
pre,
[data-diff],
[data-file] {
  --diffs-selection-base: color-mix(in srgb, var(--foreground) 55%, var(--background)) !important;
}
[data-editor-overlay] {
  --diffs-selection-base: var(--diffs-modified-base) !important;
}
`;

/**
 * Annotation rows (a note, a review thread) sit on the diff's own surface,
 * untinted, even under the selected lines they belong to.
 */
export const PLAIN_ANNOTATION_UNSAFE_CSS = `
[data-line-annotation],
[data-gutter-buffer="annotation"] {
  --diffs-annotation-bg: var(--diffs-bg) !important;
}
[data-line-annotation][data-selected-line],
[data-gutter-buffer="annotation"][data-selected-line] {
  --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg) !important;
}
`;

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export function buildPatchCacheKey(patch: string, scope = "diff-panel"): string {
  const normalizedPatch = patch.replace(/^\n+|\n+$/g, "");
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}
