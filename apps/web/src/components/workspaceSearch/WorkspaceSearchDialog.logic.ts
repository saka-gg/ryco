import {
  buildWorkspaceFileSearchRows,
  splitHighlightSegments,
  workspacePathMatchRanges,
  type HighlightSegment,
} from "@ryco/client-runtime/state/files";
import type { ProjectEntry } from "@ryco/contracts";

/** One quick open result: a file, its name and folder split into highlighted runs. */
export interface QuickOpenRow {
  readonly path: string;
  readonly name: readonly HighlightSegment[];
  /** Null for a file at the workspace root. */
  readonly parentPath: readonly HighlightSegment[] | null;
}

/**
 * Quick open rows in the node's ranked order, highlighted where `query`
 * matched. Files only: the Files panel tells a folder from a file by its own
 * listing, so a folder picked before that listing loaded would open as a file
 * it cannot read.
 */
export function buildQuickOpenRows(
  entries: ReadonlyArray<ProjectEntry>,
  query: string,
): readonly QuickOpenRow[] {
  return buildWorkspaceFileSearchRows(entries)
    .filter((row) => row.kind === "file")
    .map((row) => {
      const ranges = workspacePathMatchRanges(row.path, query);
      return {
        path: row.path,
        name: splitHighlightSegments(row.name, ranges, row.path.length - row.name.length),
        parentPath: row.parentPath === null ? null : splitHighlightSegments(row.parentPath, ranges),
      };
    });
}

/** What quick open says besides its rows. */
export interface QuickOpenStatus {
  /** Shown in place of rows when there are none. */
  readonly text: string;
  /** The search failed and can be retried; also shown under rows left from an earlier search. */
  readonly failed: boolean;
  /** A note under the rows. */
  readonly footnote: string | null;
}

/**
 * Empty, loading, failed and partial presentation of quick open. A search it
 * sent reports its failure with a retry instead of looking like no matches.
 */
export function resolveQuickOpenStatus(input: {
  /** The routed thread's workspace folder is known. */
  readonly hasWorkspace: boolean;
  /** Whether the node lets this connection search, and why not (hosted). */
  readonly access: { readonly allowed: boolean; readonly reason: string | null };
  readonly requestsSearch: boolean;
  readonly isLoading: boolean;
  readonly hasResults: boolean;
  readonly error: Error | null;
  readonly partial: boolean;
}): QuickOpenStatus {
  if (!input.hasWorkspace) {
    return { text: "Open a thread to search its files.", failed: false, footnote: null };
  }
  if (!input.access.allowed) {
    return {
      text: input.access.reason ?? "Searching files is unavailable.",
      failed: false,
      footnote: null,
    };
  }
  const footnote = input.partial ? "Showing results from part of the workspace." : null;
  if (input.requestsSearch && input.error !== null && !input.isLoading) {
    return { text: "Couldn't search files.", failed: true, footnote };
  }
  if (input.isLoading) {
    // The first search of a workspace usually waits for its index to build.
    const text = input.hasResults ? "Searching files…" : "Indexing workspace…";
    return { text, failed: false, footnote };
  }
  const text = input.requestsSearch ? "No matching files." : "Type to search files.";
  return { text, failed: false, footnote };
}
