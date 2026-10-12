/**
 * Encodings the web build can write next to its hashed assets
 * (`apps/web/src/viteBuild/precompressAssets.ts`): `<file>.gz` by default, and
 * `<file>.br` when that plugin's `brotli` option is on. Both are recognised so
 * a measurement never depends on which encodings a build enabled.
 */
const PRECOMPRESSED_SIBLING_SUFFIXES = [".br", ".gz"] as const;

/**
 * Whether `fileName` is a precompressed copy of another file in the same
 * directory (`siblingNames` lists that directory's entries). Bundle
 * measurements count each asset once, by its identity bytes; counting the
 * copies would report the precompression itself as a bundle-size regression.
 */
export function isPrecompressedSibling(
  fileName: string,
  siblingNames: ReadonlySet<string>,
): boolean {
  return PRECOMPRESSED_SIBLING_SUFFIXES.some(
    (suffix) => fileName.endsWith(suffix) && siblingNames.has(fileName.slice(0, -suffix.length)),
  );
}
