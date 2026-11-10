import type {
  OrchestrationTurnDiffFileView,
  OrchestrationTurnDiffFileViewRequest,
} from "@ryco/contracts";
import { readGitPatchFiles, type GitPatchFile } from "@ryco/shared/gitPatchFiles";

/**
 * A turn diff read file by file (D6). `CheckpointDiffQuery` imports it on the
 * first file view: the server's boot chunks have a size budget
 * (`serverBundleBoundaries.test.ts`).
 */

/** Patches split per file, for the few diffs being read file by file right now. */
const SPLIT_PATCH_CACHE_MAX_ENTRIES = 4;

function splitPatch(
  cache: Map<string, unknown>,
  cacheKey: string,
  diff: string,
): ReadonlyArray<GitPatchFile> {
  const cached = cache.get(cacheKey) as ReadonlyArray<GitPatchFile> | undefined;
  cache.delete(cacheKey);
  const files = cached ?? readGitPatchFiles(diff);
  cache.set(cacheKey, files);
  for (const oldest of cache.keys()) {
    if (cache.size <= SPLIT_PATCH_CACHE_MAX_ENTRIES) break;
    cache.delete(oldest);
  }
  return files;
}

/** The file view a client asked for, from the patch split per file. */
export function answerFileView(
  cache: Map<string, unknown>,
  cacheKey: string,
  diff: string,
  request: OrchestrationTurnDiffFileViewRequest,
  commits: { readonly fromCommitOid: string; readonly toCommitOid: string },
): OrchestrationTurnDiffFileView {
  if (request.kind === "index") {
    return {
      ...commits,
      files: splitPatch(cache, cacheKey, diff).map((file, index) => ({
        index,
        path: file.path,
        ...(file.previousPath !== null ? { previousPath: file.previousPath } : {}),
        status: file.status,
        ...(file.binary ? { binary: true } : {}),
        additions: file.additions,
        deletions: file.deletions,
        patchChars: file.patch.length,
      })),
    };
  }
  const files = splitPatch(cache, cacheKey, diff);
  const patches: Array<{ index: number; patch: string }> = [];
  for (const index of new Set(request.indices)) {
    const file = files[index];
    if (file) patches.push({ index, patch: file.patch });
  }
  return { ...commits, patches };
}
