import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

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

/** Git hunk lines always have a context/addition/deletion prefix. */
export function splitPatchIntoFileSegments(patch: string): string[] {
  const starts = Array.from(patch.matchAll(/^diff --git /gm), (match) => match.index);
  if (starts.length < 2) return [patch];
  return [0, ...starts.slice(1)].map((start, index, boundaries) =>
    patch.slice(start, boundaries[index + 1]),
  );
}

export type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
  previous?: { source: string; patch: RenderablePatch | null },
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.replace(/^\n+|\n+$/g, "");
  if (normalizedPatch.trim().length === 0) return null;

  try {
    // Reuse only the mounted panel's previous payload, with no global source-text
    // cache or arbitrary file-count limit. These slices/maps are temporary;
    // the owner retains one reference to its active source string and metadata.
    const previousFiles = new Map<string, FileDiffMetadata[]>();
    if (previous?.patch?.kind === "files") {
      for (const file of previous.patch.files) {
        if (!file.cacheKey) continue;
        const identity = file.cacheKey.slice(0, file.cacheKey.lastIndexOf(":"));
        const group = previousFiles.get(identity) ?? [];
        group.push(file);
        previousFiles.set(identity, group);
      }
    }
    const previousSources = new Map<string, string>();
    if (previousFiles.size && previous) {
      for (const segment of splitPatchIntoFileSegments(previous.source)) {
        const source = segment.replace(/^\n+|\n+$/g, "");
        previousSources.set(buildPatchCacheKey(source, cacheScope), source);
      }
    }
    const files = splitPatchIntoFileSegments(normalizedPatch).flatMap((segment) => {
      // Do not trim spaces: a trailing space can be meaningful hunk content.
      const source = segment.replace(/\n+$/, "");
      const identity = buildPatchCacheKey(source, cacheScope);
      const cached = previousFiles.get(identity);
      if (cached && previousSources.get(identity) === source) return cached;
      // Normalize the patch line terminator, not the represented file newline.
      // Pierre honors explicit "No newline at end of file" markers itself.
      return parsePatchFiles(`${source}\n`, identity)
        .flatMap((patch) => patch.files)
        .map((file, index) => {
          file.cacheKey = `${identity}:${index}`;
          return file;
        });
    });
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

/** Per-mounted-panel cache. Only the active source reference is retained, never a
 * history of source strings; all active files are eligible for reuse regardless
 * of the whole-payload LRU's entry count. Cache mutation affects reuse only.
 */
export class ActiveDiffParser {
  #previous: { source: string; patch: RenderablePatch | null } | undefined;

  parse(source: string, scope: string, cached?: RenderablePatch | null): RenderablePatch | null {
    const patch = cached === undefined ? getRenderablePatch(source, scope, this.#previous) : cached;
    this.#previous = source.trim().length ? { source, patch } : undefined;
    return patch;
  }
}
