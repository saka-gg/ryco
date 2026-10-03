import type { ChangeRequestFileContents, EnvironmentId } from "@ryco/contracts";
import type { FileDiffContentsLoader, FileDiffLoadedFiles } from "@pierre/diffs";

import { loadChangeRequestFileContents } from "./sourceControlAtoms";

export interface ChangeRequestDiffFilesTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string;
  /** The head the rendered diff was produced from. */
  readonly headSha: string;
  /** Old-side revision for commit-scoped diffs; omit for the whole change request. */
  readonly baseSha?: string | null;
}

export class ChangeRequestFileContentsUnavailableError extends Error {
  readonly reason: "binary" | "truncated";
  constructor(reason: "binary" | "truncated", path: string) {
    super(
      reason === "truncated"
        ? `${path} is too large to expand.`
        : `${path} has no text contents to expand.`,
    );
    this.name = "ChangeRequestFileContentsUnavailableError";
    this.reason = reason;
  }
}

/**
 * Shapes both sides of a file for `@pierre/diffs`. An added or deleted side is
 * an empty file; truncated or binary contents are refused, because expanding
 * hunks from partial text would misnumber lines.
 */
export function changeRequestFileContentsToDiffFiles(
  contents: ChangeRequestFileContents,
  options: {
    readonly path: string;
    readonly previousPath?: string | null;
    /** Identifies each side for the highlight cache, e.g. `${reference}:${headSha}`. */
    readonly cacheKeyPrefix: string;
  },
): FileDiffLoadedFiles {
  if (contents.truncated) {
    throw new ChangeRequestFileContentsUnavailableError("truncated", options.path);
  }
  if (contents.oldContents === null && contents.newContents === null) {
    throw new ChangeRequestFileContentsUnavailableError("binary", options.path);
  }
  const oldName = options.previousPath ?? options.path;
  return {
    oldFile: {
      name: oldName,
      contents: contents.oldContents ?? "",
      cacheKey: `${options.cacheKeyPrefix}:old:${oldName}`,
    },
    newFile: {
      name: options.path,
      contents: contents.newContents ?? "",
      cacheKey: `${options.cacheKeyPrefix}:new:${options.path}`,
    },
  };
}

/**
 * A `loadDiffFiles` implementation for change request diffs: hydrates a
 * partial (patch-parsed) file so hunks can expand. Results come from the
 * bounded `loadChangeRequestFileContents` LRU.
 */
export function createChangeRequestDiffFilesLoader(
  target: ChangeRequestDiffFilesTarget,
): FileDiffContentsLoader {
  const cacheKeyPrefix = `pr:${target.reference}:${target.baseSha ?? "merge-base"}:${target.headSha}`;
  return async (fileDiff) => {
    const previousPath = fileDiff.prevName ?? null;
    const contents = await loadChangeRequestFileContents({
      environmentId: target.environmentId,
      cwd: target.cwd,
      reference: target.reference,
      path: fileDiff.name,
      previousPath,
      baseSha: target.baseSha ?? null,
      headSha: target.headSha,
    });
    return changeRequestFileContentsToDiffFiles(contents, {
      path: fileDiff.name,
      previousPath,
      cacheKeyPrefix,
    });
  };
}
