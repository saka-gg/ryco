export const DIRECTORY_SLUG_MAX_LENGTH = 48;

/**
 * A short, portable directory-name fragment: ASCII lowercase letters, digits and single hyphens,
 * at most {@link DIRECTORY_SLUG_MAX_LENGTH} characters. A slug never contains a path separator
 * or `..`, so it is safe to join under a managed root. An empty slug returns `fallback`, which
 * callers pass as a constant of the same shape.
 */
export function directorySlug(value: string, fallback: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, DIRECTORY_SLUG_MAX_LENGTH)
      .replace(/-+$/g, "") || fallback
  );
}
