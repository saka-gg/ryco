import { fnv1a32 } from "../lib/diffRendering";

/**
 * Saturated (~600-weight) fills that keep white initials legible on both the
 * light and dark surfaces. Yellow and lime are left out: white on them fails.
 */
const PROJECT_MONOGRAM_PALETTE = [
  "#ea580c", // orange
  "#9333ea", // purple
  "#4f46e5", // indigo
  "#2563eb", // blue
  "#0284c7", // sky
  "#0891b2", // cyan
  "#0d9488", // teal
  "#16a34a", // green
  "#dc2626", // red
  "#db2777", // pink
  "#e11d48", // rose
  "#7c3aed", // violet
] as const;

export interface ProjectMonogram {
  /** One letter for a single-word name ("ryco" → "R"), two for more ("ryco-hub" → "RH"). */
  readonly initials: string;
  readonly color: string;
}

/** Splits on separators and camelCase humps: "cs2-weaponpaints_vue" → cs2 / weaponpaints / vue. */
function nameWords(name: string): string[] {
  return name
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

/**
 * A stable stand-in for a project without artwork. The color is keyed on the
 * name, so every checkout of one repository shares it.
 */
export function deriveProjectMonogram(name: string): ProjectMonogram {
  const words = nameWords(name.trim());
  const initials =
    words.length === 0
      ? "#"
      : words
          .slice(0, 2)
          .map((word) => Array.from(word)[0]!)
          .join("")
          .toLocaleUpperCase();
  const color =
    PROJECT_MONOGRAM_PALETTE[
      fnv1a32(name.trim().toLocaleLowerCase()) % PROJECT_MONOGRAM_PALETTE.length
    ]!;
  return { initials, color };
}
