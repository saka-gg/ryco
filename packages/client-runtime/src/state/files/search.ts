import type { ProjectEntry } from "@ryco/contracts";
import { normalizeWorkspaceEntryQuery } from "@ryco/shared/workspaceEntrySearch";

import type { TextRange } from "./highlight.ts";
import {
  normalizeWorkspaceRelativePath,
  workspaceFileBasename,
  workspaceFileParentPath,
} from "./paths.ts";

/** Kept well under the contract's 200 so a broad query stays a single readable screen. */
export const WORKSPACE_FILE_SEARCH_LIMIT = 80;

export const WORKSPACE_FILE_SEARCH_DEBOUNCE_MS = 250;

/** Contract cap on `ProjectSearchEntriesInput.query`. */
export const WORKSPACE_FILE_SEARCH_QUERY_MAX_LENGTH = 256;

export interface WorkspaceFileSearchRow {
  readonly path: string;
  readonly name: string;
  readonly parentPath: string | null;
  readonly kind: "file" | "directory";
}

/**
 * Shapes raw input into something the node accepts: the contract demands a
 * trimmed, non-empty query of at most 256 characters, and an empty result means
 * "no search" rather than "search for nothing".
 */
export function normalizeWorkspaceFileSearchQuery(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= WORKSPACE_FILE_SEARCH_QUERY_MAX_LENGTH) return trimmed;
  return trimmed.slice(0, WORKSPACE_FILE_SEARCH_QUERY_MAX_LENGTH).trim();
}

/**
 * Search results stay in the node's ranked order — the tree builder's ordering
 * would destroy the ranking. Paths that fail normalization are dropped, and
 * duplicates collapse so the list keys stay unique.
 */
export function buildWorkspaceFileSearchRows(
  entries: ReadonlyArray<ProjectEntry>,
): readonly WorkspaceFileSearchRow[] {
  const rows: WorkspaceFileSearchRow[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const path = normalizeWorkspaceRelativePath(entry.path);
    if (path === null || seen.has(path)) continue;
    seen.add(path);
    rows.push({
      path,
      name: workspaceFileBasename(path),
      parentPath: workspaceFileParentPath(path),
      kind: entry.kind,
    });
  }

  return rows;
}

/**
 * Where a search query matched a result's `path`, as ranges into it, for
 * highlighting the node's ranked results. It follows the ranking's tiers
 * (`scoreWorkspaceEntry`): a contiguous match before a scattered subsequence,
 * each in the name before the whole path. Empty for an empty query and when
 * nothing matches; the row still shows, just unhighlighted.
 */
export function workspacePathMatchRanges(path: string, query: string): readonly TextRange[] {
  const normalizedQuery = normalizeWorkspaceEntryQuery(query);
  const value = path.toLowerCase();
  // Case folding that changes the length would shift every offset.
  if (normalizedQuery.length === 0 || value.length !== path.length) return [];

  const nameStart = value.lastIndexOf("/") + 1;
  const index = contiguousMatchIndex(value, normalizedQuery, nameStart);
  if (index !== -1) return [{ start: index, end: index + normalizedQuery.length }];
  return (
    subsequenceRanges(value, normalizedQuery, nameStart) ??
    subsequenceRanges(value, normalizedQuery, 0) ??
    []
  );
}

/** In the name, else at the path's start, else after a `/`, else anywhere; -1 for none. */
function contiguousMatchIndex(value: string, query: string, nameStart: number): number {
  const inName = value.indexOf(query, nameStart);
  if (inName !== -1) return inName;
  if (value.startsWith(query)) return 0;
  const afterSeparator = value.indexOf(`/${query}`);
  return afterSeparator !== -1 ? afterSeparator + 1 : value.indexOf(query);
}

/** The first left-to-right subsequence match from `from`, runs of adjacent characters merged. */
function subsequenceRanges(value: string, query: string, from: number): TextRange[] | null {
  const ranges: Array<{ start: number; end: number }> = [];
  let queryIndex = 0;
  for (let index = from; index < value.length && queryIndex < query.length; index += 1) {
    if (value[index] !== query[queryIndex]) continue;
    queryIndex += 1;
    const last = ranges.at(-1);
    if (last !== undefined && last.end === index) last.end = index + 1;
    else ranges.push({ start: index, end: index + 1 });
  }
  return queryIndex === query.length ? ranges : null;
}
