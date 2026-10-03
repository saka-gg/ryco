import type { FileDiffMetadata } from "@pierre/diffs";
import type { EnvironmentId } from "@ryco/contracts";
import {
  changeRequestFileTier,
  orderChangeRequestFiles,
  type ChangeRequestFileTier,
} from "@ryco/client-runtime/state/pull-request-review";
import { useMemo, useState } from "react";

import { ActiveDiffParser } from "../../../lib/diffParsing";
import { useSourceControlChangeRequestDiff } from "../../../rpc/useSourceControl";
import {
  buildReviewFileTree,
  fileDiffStat,
  fileStatusOf,
  isOversizedDiffError,
  LARGE_FILE_CHANGED_LINES,
  reviewFileTreePaths,
  type PullRequestFileStatus,
  type ReviewFileTreeNode,
} from "./pullRequestFiles.logic";

export interface PullRequestDiffFile {
  readonly path: string;
  readonly previousPath: string | null;
  readonly fileDiff: FileDiffMetadata;
  readonly status: PullRequestFileStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly tier: ChangeRequestFileTier;
  /** Generated output, or a very large change: starts collapsed. */
  readonly startsCollapsed: boolean;
  /** Stable per parsed patch; changes when the file's patch text changes. */
  readonly renderKey: string;
}

export type PullRequestDiffFilesStatus = "loading" | "ready" | "empty" | "oversized" | "error";

export interface PullRequestDiffFiles {
  readonly status: PullRequestDiffFilesStatus;
  /** Reading order (see `buildReviewFileTree`). */
  readonly files: ReadonlyArray<PullRequestDiffFile>;
  readonly paths: ReadonlyArray<string>;
  readonly byPath: ReadonlyMap<string, PullRequestDiffFile>;
  readonly tree: ReadonlyArray<ReviewFileTreeNode>;
  readonly error: string | null;
  /** True while a newer diff is loading behind the one on screen. */
  readonly isFetching: boolean;
  /**
   * The head the diff on screen was read at. While a new head's diff loads,
   * the previous one stays up, so this can trail the change request's head:
   * line comments are stamped with it (their line numbers refer to it).
   */
  readonly headSha: string | null;
}

const EMPTY_FILES: ReadonlyArray<PullRequestDiffFile> = [];

/**
 * The change request's (or one commit's) diff, parsed once per patch text and
 * put in reading order: `orderChangeRequestFiles` decides what comes first,
 * then the tree groups each directory where its first file appears, and the
 * diff stream follows the tree exactly.
 *
 * A new head (the author pushed while you read) is a new read; until it
 * arrives the previous head's diff stays on screen, so the scroll position,
 * open files and an open composer survive, and files whose patch did not
 * change keep their parsed identity (and their mounted section) afterwards.
 */
export function usePullRequestDiffFiles(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string;
  readonly headSha: string | null;
  readonly commitSha: string | null;
  readonly enabled: boolean;
  /**
   * Paths the detail already lists. While the diff loads, the tree shows them
   * (in reading order) so the reader is never told there are 0 files.
   */
  readonly provisionalPaths?: ReadonlyArray<string> | undefined;
}): PullRequestDiffFiles {
  const query = useSourceControlChangeRequestDiff({
    environmentId: input.environmentId,
    cwd: input.cwd,
    reference: input.reference,
    headSha: input.headSha,
    commitSha: input.commitSha,
    enabled: input.enabled,
  });
  const provisionalPaths = input.provisionalPaths;
  const [parser] = useState(() => new ActiveDiffParser());
  const scope = `pr:${input.reference}:${input.commitSha ?? "all"}`;

  // Remember the last diff read for this scope (during render, no effect
  // round-trip) and keep it on screen while another head's read is in flight.
  const [held, setHeld] = useState<{
    readonly scope: string;
    readonly headSha: string | null;
    readonly data: string;
  } | null>(null);
  if (
    query.data !== null &&
    (held?.scope !== scope || held.data !== query.data || held.headSha !== input.headSha)
  ) {
    setHeld({ scope, headSha: input.headSha, data: query.data });
  }
  const holding =
    query.data === null && query.error === null && held !== null && held.scope === scope;
  const source = query.data ?? (holding ? held.data : null);
  const sourceHeadSha = holding ? held.headSha : query.data !== null ? input.headSha : null;
  const isFetching = query.isFetching || holding;

  const patch = useMemo(
    () => (source === null ? null : parser.parse(source, scope)),
    [parser, scope, source],
  );

  return useMemo<PullRequestDiffFiles>(() => {
    const errorMessage = query.error?.message ?? null;
    if (patch === null) {
      if (errorMessage !== null) {
        return {
          status: isOversizedDiffError(errorMessage) ? "oversized" : "error",
          files: EMPTY_FILES,
          paths: [],
          byPath: new Map(),
          tree: [],
          error: errorMessage,
          isFetching,
          headSha: null,
        };
      }
      const provisional =
        source === null && provisionalPaths && provisionalPaths.length > 0
          ? buildReviewFileTree(
              orderChangeRequestFiles(provisionalPaths.map((path) => ({ path }))).map(
                (entry) => entry.path,
              ),
            )
          : [];
      return {
        status: source === null ? "loading" : "empty",
        files: EMPTY_FILES,
        paths: reviewFileTreePaths(provisional),
        byPath: new Map(),
        tree: provisional,
        error: null,
        isFetching,
        headSha: sourceHeadSha,
      };
    }
    if (patch.kind === "raw") {
      return {
        status: "oversized",
        files: EMPTY_FILES,
        paths: [],
        byPath: new Map(),
        tree: [],
        error: patch.reason,
        isFetching,
        headSha: sourceHeadSha,
      };
    }
    const entries = patch.files.map((fileDiff): PullRequestDiffFile => {
      const path = fileDiff.name;
      const stat = fileDiffStat(fileDiff);
      const tier = changeRequestFileTier(path);
      return {
        path,
        previousPath: fileDiff.prevName ?? null,
        fileDiff,
        status: fileStatusOf(fileDiff),
        additions: stat.additions,
        deletions: stat.deletions,
        tier,
        startsCollapsed:
          tier === "generated" || stat.additions + stat.deletions > LARGE_FILE_CHANGED_LINES,
        renderKey: fileDiff.cacheKey ?? `${fileDiff.prevName ?? ""}:${path}`,
      };
    });
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const tree = buildReviewFileTree(orderChangeRequestFiles(entries).map((entry) => entry.path));
    const paths = reviewFileTreePaths(tree);
    const files = paths.flatMap((path) => byPath.get(path) ?? []);
    return {
      status: files.length === 0 ? "empty" : "ready",
      files,
      paths,
      byPath,
      tree,
      error: errorMessage,
      isFetching,
      headSha: sourceHeadSha,
    };
  }, [isFetching, patch, provisionalPaths, query.error, source, sourceHeadSha]);
}
