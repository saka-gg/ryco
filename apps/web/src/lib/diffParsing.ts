import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { buildPatchCacheKey } from "./diffRendering";
import { gitDiffPaths } from "./gitDiffPaths";

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
      const paths = gitDiffPaths(source);
      if (!paths) throw new Error("Unsupported or ambiguous Git file paths.");
      return parsePatchFiles(`${source}\n`, identity)
        .flatMap((patch) => patch.files)
        .map((file, index) => {
          // Pierre strips transport prefixes but retains C escapes and trims names.
          // Resolve paths from the raw Git headers exactly once for every consumer.
          file.name = paths.name;
          if (paths.prevName !== undefined) file.prevName = paths.prevName;
          else delete file.prevName;
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
