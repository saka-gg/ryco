import type { EnvironmentId, VcsRef } from "@ryco/contracts";
import { useCallback, useDeferredValue } from "react";

import { useGitBranches } from "./useGit";

export interface GitBranchSearch {
  /** The refs to list: the server's matches once typing settles, else its first page. */
  readonly refs: ReadonlyArray<VcsRef>;
  readonly isPending: boolean;
  /** Narrows a name by what is typed, at once (before the server answers). */
  readonly matches: (name: string) => boolean;
  /** "Showing 50 of 312 · type to narrow" while the server holds more; else null. */
  readonly status: string | null;
}

/** What an empty branch list says. */
export function branchSearchEmptyText(loading: boolean): string {
  return loading ? "Loading branches…" : "No branches match.";
}

/**
 * The ref search every branch picker shares (the pull request dialog's
 * branch line, a schedule's "off [main]"): the unfiltered first page is the
 * shared read; a query asks the server for its matches once typing settles,
 * while the loaded names narrow at once. Reads nothing while closed.
 */
export function useGitBranchSearch(input: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly open: boolean;
  readonly query: string;
}): GitBranchSearch {
  const { environmentId, cwd, open } = input;
  const deferredQuery = useDeferredValue(input.query.trim());
  const all = useGitBranches({ environmentId, cwd: open ? cwd : null, query: "" });
  const searched = useGitBranches({
    environmentId,
    cwd: open && deferredQuery.length > 0 ? cwd : null,
    query: deferredQuery,
  });
  const source = deferredQuery.length > 0 && !searched.isPending ? searched : all;
  const needle = input.query.trim().toLowerCase();
  const matches = useCallback(
    (name: string) => needle.length === 0 || name.toLowerCase().includes(needle),
    [needle],
  );
  return {
    refs: source.refs,
    isPending: source.isPending,
    matches,
    status:
      !source.isPending && source.hasNextPage
        ? `Showing ${source.refs.length} of ${source.totalCount} · type to narrow`
        : null,
  };
}
