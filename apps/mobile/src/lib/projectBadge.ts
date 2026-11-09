// A project's badge when it has no icon of its own: its initial on a color that stays the same
// for the project wherever it shows (title pill, context card), picked from a stable hash of its
// id. Every color carries white text.

export const PROJECT_BADGE_COLORS = [
  "#5b7cfa",
  "#8b5cf6",
  "#d9488f",
  "#e2733a",
  "#1f9e8f",
  "#2f9e5b",
  "#d94a4f",
  "#2a8fd0",
  "#c08a1e",
  "#6b63e6",
] as const;

/** FNV-1a: tiny, stable across runs and platforms. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

export function projectBadgeColor(key: string): string {
  return PROJECT_BADGE_COLORS[hash(key) % PROJECT_BADGE_COLORS.length]!;
}

/** The first letter or digit of the name, upper case; "#" when it has none. */
export function projectBadgeInitial(name: string): string {
  const match = /[\p{L}\p{N}]/u.exec(name);
  return match ? match[0].toLocaleUpperCase() : "#";
}
