/**
 * Find in files over one workspace (`projects.searchContent`), shared by every
 * client. The controller debounces typing, aborts superseded requests, pages
 * with the node's cursor and caps what it holds; the apps only render its
 * snapshot. Plain TypeScript: no React, DOM or React Native.
 */
import type {
  ProjectContentMatch,
  ProjectSearchContentFailureReason,
  ProjectSearchContentInput,
  ProjectSearchContentResult,
  ServerConfig,
} from "@ryco/contracts";

import { workspaceFileBasename, workspaceFileParentPath } from "./paths.ts";

/** Matching lines per page; the contract allows up to 500. */
export const CONTENT_SEARCH_PAGE_LIMIT = 200;

export const CONTENT_SEARCH_DEBOUNCE_MS = 150;

/** A single character matches nearly every line, so it searches nothing. */
export const CONTENT_SEARCH_MIN_QUERY_LENGTH = 2;

/** Contract cap on `ProjectSearchContentInput.query`. */
export const CONTENT_SEARCH_QUERY_MAX_LENGTH = 256;

/** Paging stops once this many matches are loaded. */
export const CONTENT_SEARCH_MAX_LOADED_MATCHES = 2_000;

/** Whether the node advertises `projects.searchContent`. */
export function selectProjectContentSearchSupported(config: ServerConfig | null): boolean {
  return config?.environment.capabilities.projectContentSearch === true;
}

/**
 * Shapes raw input into a query the node accepts, or "" for no search. Not
 * trimmed: whitespace is part of what is searched. Whitespace-only and
 * too-short input searches nothing, and so does a line break or NUL, since a
 * match never spans lines. Longer input is cut to the contract's cap without
 * splitting a surrogate pair.
 */
export function normalizeContentSearchQuery(raw: string): string {
  if (raw.length < CONTENT_SEARCH_MIN_QUERY_LENGTH || raw.trim().length === 0) return "";
  if (/[\r\n\0]/.test(raw)) return "";
  if (raw.length <= CONTENT_SEARCH_QUERY_MAX_LENGTH) return raw;
  const cut = raw.slice(0, CONTENT_SEARCH_QUERY_MAX_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export interface ContentSearchFileGroup {
  readonly path: string;
  readonly name: string;
  readonly parentPath: string | null;
  readonly matches: readonly ProjectContentMatch[];
}

/**
 * Groups matches by file, in the order the files first appear. The node sends
 * whole files in path order, so this keeps its order; a file that shows up
 * twice in a malformed payload still gets one group.
 */
export function groupContentSearchMatches(
  matches: ReadonlyArray<ProjectContentMatch>,
): readonly ContentSearchFileGroup[] {
  const groups = new Map<string, ProjectContentMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.path);
    if (group === undefined) groups.set(match.path, [match]);
    else group.push(match);
  }
  return Array.from(groups, ([path, fileMatches]) => ({
    path,
    name: workspaceFileBasename(path),
    parentPath: workspaceFileParentPath(path),
    matches: fileMatches,
  }));
}

export interface ContentSearchOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
}

export const DEFAULT_CONTENT_SEARCH_OPTIONS: ContentSearchOptions = {
  caseSensitive: false,
  wholeWord: false,
};

export interface WorkspaceContentSearchFailure {
  /** `cursor`: the node can't continue this search, so retrying starts it over. */
  readonly reason: ProjectSearchContentFailureReason;
  readonly message: string;
}

/**
 * - `idle`: nothing to search (empty or whitespace-only input);
 * - `tooShort`: the input normalizes to no query (see {@link normalizeContentSearchQuery});
 * - `searching`: the first page is debouncing or in flight;
 * - `ready`: at least the first page arrived;
 * - `error`: a page failed; `retry` repeats it.
 */
export type WorkspaceContentSearchStatus = "idle" | "tooShort" | "searching" | "ready" | "error";

/** What a results view renders. Replaced, never mutated, so `useSyncExternalStore` can compare. */
export interface WorkspaceContentSearchSnapshot {
  /** What is searched; "" when nothing is. */
  readonly query: string;
  readonly options: ContentSearchOptions;
  readonly status: WorkspaceContentSearchStatus;
  /**
   * Loaded matches, whole files in path order. While a changed query or
   * option searches, the previous search's matches stay until its first page
   * replaces them; a failed first page clears them.
   */
  readonly matches: readonly ProjectContentMatch[];
  /** The node has more matches after these. */
  readonly hasMore: boolean;
  /** A next page is in flight. */
  readonly loadingMore: boolean;
  /** The last page ran out of time before it filled. */
  readonly timedOut: boolean;
  /**
   * The last page ran out of time without finding anything, so the search
   * waits for `keepSearching` instead of paging on.
   */
  readonly stoppedEarly: boolean;
  /** The node searched only part of the workspace (its file index is capped). */
  readonly partial: boolean;
  /** `hasMore`, but the loaded-match cap is reached: paging stopped. */
  readonly capped: boolean;
  readonly error: WorkspaceContentSearchFailure | null;
}

export interface WorkspaceContentSearch {
  readonly getSnapshot: () => WorkspaceContentSearchSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** The typed input; searched after the debounce once it changes the query. */
  readonly setQuery: (raw: string) => void;
  /** Searches again at once when an option changed. */
  readonly setOptions: (patch: Partial<ContentSearchOptions>) => void;
  /**
   * Loads the next page, for a list's end sentinel: only while nothing is in
   * flight, below the loaded-match cap, and unless the search stopped early.
   */
  readonly loadMore: () => void;
  /** Continues a search that stopped early (the user asked for it). */
  readonly keepSearching: () => void;
  /** Repeats the page that failed; a search the node can't continue starts over. */
  readonly retry: () => void;
  /** Aborts what is in flight; nothing is published afterwards. */
  readonly dispose: () => void;
}

const IDLE_PAGING = {
  hasMore: false,
  loadingMore: false,
  timedOut: false,
  stoppedEarly: false,
  partial: false,
  error: null,
} as const;

/**
 * One workspace's find-in-files state. A `query` given here (with its
 * `options`) is searched at once, without the debounce: a reopened dialog
 * restoring its last search.
 */
export function createWorkspaceContentSearch(input: {
  readonly cwd: string;
  /** `EnvironmentApi.projects.searchContent`; aborting `signal` must withdraw the request. */
  readonly search: (
    request: ProjectSearchContentInput,
    options: { readonly signal: AbortSignal },
  ) => Promise<ProjectSearchContentResult>;
  readonly query?: string;
  readonly options?: ContentSearchOptions;
  readonly debounceMs?: number;
  readonly pageLimit?: number;
  readonly maxLoadedMatches?: number;
}): WorkspaceContentSearch {
  const debounceMs = input.debounceMs ?? CONTENT_SEARCH_DEBOUNCE_MS;
  const pageLimit = input.pageLimit ?? CONTENT_SEARCH_PAGE_LIMIT;
  const maxLoadedMatches = input.maxLoadedMatches ?? CONTENT_SEARCH_MAX_LOADED_MATCHES;
  const listeners = new Set<() => void>();
  let snapshot: WorkspaceContentSearchSnapshot = {
    query: "",
    options: input.options ?? DEFAULT_CONTENT_SEARCH_OPTIONS,
    status: "idle",
    matches: [],
    ...IDLE_PAGING,
    capped: false,
  };
  // The node's cursor after the loaded matches: null before the first page and at the end.
  let cursor: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // Aborts the request in flight; replaced by every request, so a late answer is recognized.
  let inFlight: AbortController | null = null;
  let disposed = false;

  const publish = (patch: Partial<WorkspaceContentSearchSnapshot>) => {
    if (disposed) return;
    const next = { ...snapshot, ...patch };
    snapshot = { ...next, capped: next.hasMore && next.matches.length >= maxLoadedMatches };
    for (const listener of listeners) listener();
  };

  const cancel = () => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    inFlight?.abort();
    inFlight = null;
  };

  /** Sends one page; `apply` runs only if no later request or cancel superseded it. */
  const request = (
    pageCursor: string | null,
    apply: (outcome: { result: ProjectSearchContentResult } | { error: unknown }) => void,
  ) => {
    const controller = new AbortController();
    inFlight = controller;
    const { caseSensitive, wholeWord } = snapshot.options;
    const page: ProjectSearchContentInput = {
      cwd: input.cwd,
      query: snapshot.query,
      limit: pageLimit,
      ...(caseSensitive ? { caseSensitive } : {}),
      ...(wholeWord ? { wholeWord } : {}),
      ...(pageCursor === null ? {} : { cursor: pageCursor }),
    };
    void Promise.resolve()
      .then(() => input.search(page, { signal: controller.signal }))
      .then(
        (result) => ({ result }),
        (error: unknown) => ({ error }),
      )
      .then((outcome) => {
        if (inFlight !== controller) return;
        inFlight = null;
        apply(outcome);
      });
  };

  const applyPage = (result: ProjectSearchContentResult, matches: ProjectContentMatch[]) => {
    cursor = result.nextCursor ?? null;
    const timedOut = result.timedOut === true;
    publish({
      status: "ready",
      matches,
      hasMore: cursor !== null,
      loadingMore: false,
      timedOut,
      stoppedEarly: timedOut && result.matches.length === 0 && cursor !== null,
      partial: snapshot.partial || result.partial === true,
      error: null,
    });
  };

  const searchFirstPage = () => {
    debounceTimer = null;
    request(null, (outcome) => {
      if ("result" in outcome) applyPage(outcome.result, [...outcome.result.matches]);
      else publish({ status: "error", matches: [], error: readFailure(outcome.error) });
    });
  };

  const searchNextPage = (pageCursor: string, patch: Partial<WorkspaceContentSearchSnapshot>) => {
    if (disposed) return;
    publish({ ...patch, loadingMore: true });
    request(pageCursor, (outcome) => {
      if ("result" in outcome) {
        applyPage(outcome.result, [...snapshot.matches, ...outcome.result.matches]);
      } else {
        publish({ status: "error", loadingMore: false, error: readFailure(outcome.error) });
      }
    });
  };

  /**
   * Searches from the first page with `patch` applied, keeping the shown
   * matches until it answers.
   */
  const restart = (patch: Partial<WorkspaceContentSearchSnapshot>, debounce: boolean) => {
    if (disposed) return;
    cancel();
    cursor = null;
    publish({ ...patch, status: "searching", ...IDLE_PAGING });
    if (debounce) debounceTimer = setTimeout(searchFirstPage, debounceMs);
    else searchFirstPage();
  };

  const setQuery = (raw: string, debounce: boolean) => {
    const query = normalizeContentSearchQuery(raw);
    if (query === "") {
      cancel();
      cursor = null;
      const status = raw.trim().length === 0 ? "idle" : "tooShort";
      if (snapshot.query !== "" || snapshot.status !== status) {
        publish({ query, status, matches: [], ...IDLE_PAGING });
      }
      return;
    }
    if (query !== snapshot.query) restart({ query }, debounce);
  };

  // Once the first page arrived, while nothing is in flight and below the cap.
  const canPage = () => snapshot.status === "ready" && !snapshot.loadingMore && !snapshot.capped;

  if (input.query !== undefined) setQuery(input.query, false);

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setQuery: (raw) => setQuery(raw, true),
    setOptions: (patch) => {
      const options = { ...snapshot.options, ...patch };
      if (
        options.caseSensitive === snapshot.options.caseSensitive &&
        options.wholeWord === snapshot.options.wholeWord
      ) {
        return;
      }
      if (snapshot.query === "") publish({ options });
      else restart({ options }, false);
    },
    loadMore: () => {
      if (canPage() && cursor !== null && !snapshot.stoppedEarly) searchNextPage(cursor, {});
    },
    keepSearching: () => {
      if (canPage() && cursor !== null && snapshot.stoppedEarly) searchNextPage(cursor, {});
    },
    retry: () => {
      if (snapshot.status !== "error") return;
      // A failed first page left no cursor; a cursor the node rejected can't be retried.
      if (cursor === null || snapshot.error?.reason === "cursor") restart({}, false);
      else searchNextPage(cursor, { status: "ready", error: null });
    },
    dispose: () => {
      cancel();
      disposed = true;
      listeners.clear();
    },
  };
}

/** Reads the error's tag and reason, never its message, to tell a cursor the node rejected. */
function readFailure(error: unknown): WorkspaceContentSearchFailure {
  const { _tag, reason } = (typeof error === "object" && error !== null ? error : {}) as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
  };
  return {
    reason:
      _tag === "ProjectSearchContentError" &&
      reason === ("cursor" satisfies ProjectSearchContentFailureReason)
        ? "cursor"
        : "failed",
    message: error instanceof Error ? error.message : String(error),
  };
}
