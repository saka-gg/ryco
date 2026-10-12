/**
 * Build-time compressed siblings of static web assets.
 *
 * The web build writes `<file>.gz` (and optionally `<file>.br`) next to its
 * hashed, compressible assets; the Ryco server streams a sibling instead of the
 * file when the request's `Accept-Encoding` admits it. The server negotiates
 * with this definition, so the build must only compress extensions listed
 * here: the server never looks for a sibling of any other file.
 *
 * @module precompressedAssets
 */

/** Content codings a sibling may carry, in server preference order. */
export const PRECOMPRESSED_ASSET_ENCODINGS = [
  { encoding: "br", suffix: ".br" },
  { encoding: "gzip", suffix: ".gz" },
] as const;

export type PrecompressedAssetEncoding = (typeof PRECOMPRESSED_ASSET_ENCODINGS)[number]["encoding"];

/** Extensions of files that may have compressed siblings (lower case, with the dot). */
export const PRECOMPRESSIBLE_ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  ".bcmap",
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".pfb",
  ".svg",
  ".ttf",
  ".txt",
  ".wasm",
  ".webmanifest",
]);

/** Whether `filePath` has an extension that may come with compressed siblings. */
export function hasPrecompressibleAssetExtension(filePath: string): boolean {
  const separator = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const dot = filePath.lastIndexOf(".");
  return (
    dot > separator + 1 && PRECOMPRESSIBLE_ASSET_EXTENSIONS.has(filePath.slice(dot).toLowerCase())
  );
}
