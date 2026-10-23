import {
  buildWorkspaceFileSearchRows,
  CONTENT_SEARCH_MIN_QUERY_LENGTH,
  groupContentSearchMatches,
  splitHighlightSegments,
  workspacePathMatchRanges,
  type ContentSearchOptions,
  type HighlightSegment,
  type TextRange,
  type WorkspaceContentSearchSnapshot,
} from "@ryco/client-runtime/state/files";
import type { EnvironmentId, ProjectContentMatch, ProjectEntry } from "@ryco/contracts";

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

/** Matches rendered at first, and added each time the end of the list scrolls into view. */
export const CONTENT_SEARCH_RENDER_WINDOW = 100;

/** Text kept before a line's first match; anything earlier is cut. */
const PREVIEW_CONTEXT_CHARS = 32;

/** One matching line under its file. */
export interface ContentSearchResultRow {
  /** The list value: one per file and line. */
  readonly value: string;
  readonly path: string;
  readonly lineNumber: number;
  readonly preview: readonly HighlightSegment[];
  /** What a screen reader reads for the row: where it is, then the line. */
  readonly label: string;
}

export interface ContentSearchResultGroup {
  readonly path: string;
  readonly name: string;
  readonly parentPath: string | null;
  /** The file's loaded matches, also those past the rendered ones. */
  readonly matchCount: number;
  readonly rows: readonly ContentSearchResultRow[];
}

export interface ContentSearchResults {
  /** The files of the first `renderLimit` matches, in the node's order. */
  readonly groups: readonly ContentSearchResultGroup[];
  /** Every rendered row's value, in list order. */
  readonly values: readonly string[];
  /** Files among all loaded matches. */
  readonly fileCount: number;
}

/**
 * The rendered part of a search's loaded matches, grouped by file. A repeated
 * line in a malformed payload is shown once.
 */
export function buildContentSearchResults(
  matches: ReadonlyArray<ProjectContentMatch>,
  renderLimit: number,
): ContentSearchResults {
  const files = groupContentSearchMatches(matches);
  const groups: ContentSearchResultGroup[] = [];
  const values: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (values.length >= renderLimit) break;
    const rows: ContentSearchResultRow[] = [];
    for (const match of file.matches) {
      if (values.length >= renderLimit) break;
      const value = `${match.path}:${match.lineNumber}`;
      if (seen.has(value)) continue;
      seen.add(value);
      values.push(value);
      const preview = buildPreviewSegments(match.preview, match.ranges);
      rows.push({
        value,
        path: match.path,
        lineNumber: match.lineNumber,
        preview,
        label: `${value}, ${preview.map((segment) => segment.text).join("")}`,
      });
    }
    if (rows.length === 0) continue;
    groups.push({
      path: file.path,
      name: file.name,
      parentPath: file.parentPath,
      matchCount: file.matches.length,
      rows,
    });
  }
  return { groups, values, fileCount: files.length };
}

/**
 * A matching line as highlighted runs, without its indentation, starting
 * shortly before its first match so the match stays in view on a long line.
 */
function buildPreviewSegments(
  preview: string,
  ranges: ReadonlyArray<TextRange>,
): readonly HighlightSegment[] {
  const indent = preview.length - preview.trimStart().length;
  // Ranges outside the line (a malformed payload) are ignored; NaN fails every comparison.
  const firstMatch = ranges.reduce(
    (first, range) =>
      range.start >= 0 && range.start < preview.length && range.end > range.start
        ? Math.min(first, range.start)
        : first,
    Number.POSITIVE_INFINITY,
  );
  let start = Number.isFinite(firstMatch)
    ? Math.max(indent, firstMatch - PREVIEW_CONTEXT_CHARS)
    : indent;
  const cut = start > indent;
  // Never start on the second half of a surrogate pair.
  const code = preview.charCodeAt(start);
  if (cut && code >= 0xdc00 && code <= 0xdfff) start += 1;
  const segments = splitHighlightSegments(preview.slice(start), ranges, start);
  return cut ? [{ text: "…", highlighted: false }, ...segments] : segments;
}

/**
 * Why find in files cannot search the routed workspace, or null when it can.
 * `supported` is null while the node's config is unknown.
 */
export function resolveContentSearchUnavailable(input: {
  readonly hasWorkspace: boolean;
  readonly access: { readonly allowed: boolean; readonly reason: string | null };
  readonly supported: boolean | null;
}): string | null {
  if (!input.hasWorkspace) return "Open a thread to search its files.";
  if (!input.access.allowed) return input.access.reason ?? "Searching files is unavailable.";
  if (input.supported === null) return "Available when this node is connected.";
  if (!input.supported) return "Update Ryco on this node to search file contents.";
  return null;
}

/** What a status line offers: repeat a failed page, or go on after a page that found nothing in time. */
export type ContentSearchAction = "retry" | "keepSearching";

/** What find in files says besides its results. */
export interface ContentSearchStatus {
  /** Shown in place of results while there are none. */
  readonly message: string | null;
  /** Shown above the results. */
  readonly summary: string | null;
  /** Follows the summary, or the message. */
  readonly notice: string | null;
  readonly action: ContentSearchAction | null;
  /** The notice reports a failure. */
  readonly failed: boolean;
  /** Notes under the results. */
  readonly footnotes: readonly string[];
}

export function resolveContentSearchStatus(input: {
  readonly snapshot: WorkspaceContentSearchSnapshot;
  readonly fileCount: number;
}): ContentSearchStatus {
  const { snapshot } = input;
  const count = snapshot.matches.length;
  const footnotes = [
    ...(snapshot.partial ? ["Showing results from part of the workspace."] : []),
    ...(snapshot.capped ? [`Showing the first ${count.toLocaleString()} results.`] : []),
  ];
  const status = (
    fields: Partial<Omit<ContentSearchStatus, "footnotes">>,
  ): ContentSearchStatus => ({
    message: null,
    summary: null,
    notice: null,
    action: null,
    failed: false,
    footnotes,
    ...fields,
  });

  if (snapshot.status === "idle") return status({ message: "Type to search in files." });
  if (snapshot.status === "tooShort") {
    return status({ message: `Type at least ${CONTENT_SEARCH_MIN_QUERY_LENGTH} characters.` });
  }
  const failed = snapshot.status === "error";
  const searching = snapshot.status === "searching" || snapshot.loadingMore;
  // Stopped early until it is asked to go on; the next page then clears it.
  const stoppedEarly = snapshot.stoppedEarly && !searching;
  if (count === 0) {
    if (failed) return status({ message: "Couldn't search files.", action: "retry", failed });
    if (stoppedEarly) return status({ message: "Search stopped early.", action: "keepSearching" });
    // More pages follow on their own while the list's end is in view.
    return status({ message: searching || snapshot.hasMore ? "Searching…" : "No results." });
  }

  const summary =
    snapshot.status === "searching"
      ? "Searching…"
      : `${count.toLocaleString()}${snapshot.hasMore ? "+" : ""} ${plural(count, "result")} in ${input.fileCount.toLocaleString()} ${plural(input.fileCount, "file")}`;
  if (failed) {
    return status({ summary, notice: "Couldn't load more results.", action: "retry", failed });
  }
  if (stoppedEarly) {
    return status({ summary, notice: "Search stopped early.", action: "keepSearching" });
  }
  return status({ summary });
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

/** A workspace find in files searches: a folder on one node. */
export interface ContentSearchWorkspace {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
}

export function contentSearchWorkspaceKey(workspace: ContentSearchWorkspace): string {
  return `${workspace.environmentId}\0${workspace.cwd}`;
}

/** A workspace's last search this session. */
export interface RememberedContentSearch {
  /** What was typed, untrimmed. */
  readonly query: string;
  readonly options: ContentSearchOptions;
}

/** Workspaces whose last search is remembered; the oldest is forgotten first. */
const REMEMBERED_CONTENT_SEARCHES_MAX = 32;

// Memory only: a search is never stored or sent anywhere else.
const rememberedContentSearches = new Map<string, RememberedContentSearch>();

export function recallContentSearch(
  workspace: ContentSearchWorkspace,
): RememberedContentSearch | undefined {
  return rememberedContentSearches.get(contentSearchWorkspaceKey(workspace));
}

export function rememberContentSearch(
  workspace: ContentSearchWorkspace,
  search: RememberedContentSearch,
): void {
  const key = contentSearchWorkspaceKey(workspace);
  rememberedContentSearches.delete(key);
  rememberedContentSearches.set(key, search);
  if (rememberedContentSearches.size > REMEMBERED_CONTENT_SEARCHES_MAX) {
    const oldest = rememberedContentSearches.keys().next().value;
    if (oldest !== undefined) rememberedContentSearches.delete(oldest);
  }
}
