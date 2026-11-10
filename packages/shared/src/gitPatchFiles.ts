import { gitDiffPaths } from "./gitDiffPaths.ts";

/**
 * A Git patch read file by file: one entry per `diff --git` segment, in the
 * order the patch lists them, with its paths, status and line counts. The node
 * builds a turn diff's file index from it, and the phone reads pull request and
 * checkout patches with it, so both sides agree on what a file is.
 */

export type GitPatchFileStatus = "added" | "deleted" | "modified" | "renamed";

export interface GitPatchFile {
  /** The file's path after the change (its old path when it was deleted). */
  readonly path: string;
  /** The old path of a renamed or moved file. */
  readonly previousPath: string | null;
  readonly status: GitPatchFileStatus;
  readonly binary: boolean;
  readonly additions: number;
  readonly deletions: number;
  /** The file's own patch, from its `diff --git` line through its last hunk. */
  readonly patch: string;
}

const DIFF_GIT_HEADER = /^diff --git /mu;

function segmentStarts(patch: string): number[] {
  const starts: number[] = [];
  const pattern = /^diff --git /gmu;
  for (let match = pattern.exec(patch); match !== null; match = pattern.exec(patch)) {
    starts.push(match.index);
  }
  return starts;
}

/** The `diff --git a/x b/y` remainder, shown as-is when the paths cannot be resolved. */
function rawHeaderPath(segment: string): string {
  const newline = segment.indexOf("\n");
  const firstLine = segment.slice(0, newline === -1 ? undefined : newline);
  return firstLine.replace(DIFF_GIT_HEADER, "").trim() || "(unknown file)";
}

export function readGitPatchFile(segment: string): GitPatchFile {
  const paths = gitDiffPaths(segment);
  const hunkStart = segment.search(/^@@ /mu);
  const header = hunkStart === -1 ? segment : segment.slice(0, hunkStart);
  const binary = /^(?:Binary files .* differ|GIT binary patch)$/mu.test(header);
  let additions = 0;
  let deletions = 0;
  if (hunkStart !== -1) {
    for (const line of segment.slice(hunkStart).split("\n")) {
      if (line.startsWith("+")) additions += 1;
      else if (line.startsWith("-")) deletions += 1;
    }
  }
  const previousPath = paths?.prevName ?? null;
  const status: GitPatchFileStatus = /^new file mode /mu.test(header)
    ? "added"
    : /^deleted file mode /mu.test(header)
      ? "deleted"
      : previousPath !== null
        ? "renamed"
        : "modified";
  return {
    path: paths?.name ?? rawHeaderPath(segment),
    previousPath,
    status,
    binary,
    additions,
    deletions,
    patch: segment,
  };
}

/** The patch's files exactly in the order the patch lists them. */
export function readGitPatchFiles(patch: string): ReadonlyArray<GitPatchFile> {
  const normalized = patch.replace(/\r\n/gu, "\n");
  const starts = segmentStarts(normalized);
  return starts.map((start, index) =>
    readGitPatchFile(normalized.slice(start, starts[index + 1]).replace(/\n+$/u, "")),
  );
}
