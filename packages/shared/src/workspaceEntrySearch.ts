import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
  type RankedSearchResult,
} from "./searchRanking.ts";

/**
 * Workspace entry (`@` file picker) ranking. The server ranks its index with
 * it and the client narrows complete cached results with it, so both produce
 * identical results for the same entries and query.
 */

/** Leading `@`, `.` and `/` characters carry no meaning in a workspace path query. */
const WORKSPACE_ENTRY_QUERY_LEADING_PATTERN = /^[@./]+/;

export type WorkspaceEntryKind = "file" | "directory";

export interface WorkspaceEntrySearchKey {
  /** Workspace-relative path with `/` separators. */
  readonly path: string;
  readonly kind: WorkspaceEntryKind;
  /** Lowercased `path`. */
  readonly normalizedPath: string;
}

export function normalizeWorkspaceEntryQuery(query: string): string {
  return normalizeSearchQuery(query, { trimLeadingPattern: WORKSPACE_ENTRY_QUERY_LEADING_PATTERN });
}

export function workspaceEntryBasename(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
}

export function workspaceEntryParentPath(path: string): string | undefined {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex <= 0 ? undefined : path.slice(0, separatorIndex);
}

export function workspaceEntryDepth(path: string): number {
  let depth = 0;
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
    depth += 1;
  }
  return depth;
}

/**
 * Scores one entry against a normalized query (see
 * {@link normalizeWorkspaceEntryQuery}). Lower is better; `null` means no
 * match.
 *
 * An empty query ranks the shallowest entries first, directories before
 * files. Otherwise the best of the basename and full-path match tiers wins.
 * The basename is a suffix of the path, so a basename match implies a path
 * (subsequence) match: a path miss skips the basename entirely, which is the
 * common case while scanning a large index.
 */
export function scoreWorkspaceEntry(
  entry: Pick<WorkspaceEntrySearchKey, "kind" | "normalizedPath">,
  query: string,
): number | null {
  if (query.length === 0) {
    return workspaceEntryDepth(entry.normalizedPath) * 2 + (entry.kind === "directory" ? 0 : 1);
  }
  const pathScore = scoreQueryMatch({
    value: entry.normalizedPath,
    query,
    exactBase: 1,
    prefixBase: 3,
    boundaryBase: 4,
    includesBase: 6,
    fuzzyBase: 200,
    boundaryMarkers: ["/"],
  });
  if (pathScore === null) {
    return null;
  }
  const nameScore = scoreQueryMatch({
    value: workspaceEntryBasename(entry.normalizedPath),
    query,
    exactBase: 0,
    prefixBase: 2,
    includesBase: 5,
    fuzzyBase: 100,
  });
  return nameScore === null ? pathScore : Math.min(nameScore, pathScore);
}

export interface RankedWorkspaceEntries<T> {
  readonly entries: T[];
  /** Every entry that matched, including those beyond `limit`. */
  readonly matchedCount: number;
}

/**
 * Ranks `entries` against a normalized query and keeps the best `limit`.
 * Ties break on the path, so the result does not depend on the input order.
 */
export function rankWorkspaceEntries<T extends WorkspaceEntrySearchKey>(
  entries: Iterable<T>,
  query: string,
  limit: number,
): RankedWorkspaceEntries<T> {
  const boundedLimit = Math.max(0, Math.floor(limit));
  const ranked: RankedSearchResult<T>[] = [];
  let matchedCount = 0;

  for (const entry of entries) {
    const score = scoreWorkspaceEntry(entry, query);
    if (score === null) {
      continue;
    }
    matchedCount += 1;
    // A full list only admits a better score, or an equal one that wins the
    // tie-break: skip the candidate allocation for everything strictly worse.
    const worst = ranked.length >= boundedLimit ? ranked[ranked.length - 1] : undefined;
    if (boundedLimit === 0 || (worst !== undefined && score > worst.score)) {
      continue;
    }
    insertRankedSearchResult(ranked, { item: entry, score, tieBreaker: entry.path }, boundedLimit);
  }

  return { entries: ranked.map((candidate) => candidate.item), matchedCount };
}
