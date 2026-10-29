import { useDebouncedValue } from "@tanstack/react-pacer";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildDiffSearchIndex,
  createDiffSearchRecordCache,
  DEFAULT_DIFF_SEARCH_OPTIONS,
  deriveDiffSearchListedFileIndexes,
  diffSearchMatchKey,
  EMPTY_DIFF_SEARCH_INDEX,
  EMPTY_DIFF_SEARCH_RESULT,
  escapeDiffSearchRegExp,
  firstDiffSearchMatchIndexFrom,
  getNextDiffSearchMatchIndex,
  groupDiffSearchMatchesByFileIndex,
  isSearchableDiffQuery,
  searchDiffIndex,
  type DiffSearchFile,
  type DiffSearchIndexOptions,
  type DiffSearchMatch,
  type DiffSearchOptions,
  type DiffSearchReadingPosition,
  type DiffSearchRenderMode,
  type DiffSearchResult,
} from "~/lib/diffSearch";

import { readDiffSearchReadingPosition, readDiffSearchSeedSelection } from "./diffSearchDom";
import { useDiffSearchHighlights } from "./useDiffSearchHighlights";

/** Typing settles this long before a search runs. */
export const DIFF_SEARCH_DEBOUNCE_MS = 150;

export interface UseDiffSearchInput {
  /** Searched files, in reading order. */
  readonly files: readonly DiffSearchFile[];
  /** Holds the rendered `[data-diff-file-index]` files; highlights are painted inside it. */
  readonly rootRef: RefObject<HTMLElement | null>;
  readonly renderMode: DiffSearchRenderMode;
  /** Highlight registry prefix, distinct per surface (`ryco-diff-search`). */
  readonly highlightName: string;
  /** Paint the current match apart from the others (default true). */
  readonly paintCurrent?: boolean;
  /** A stable object (module constant); a new one re-indexes. */
  readonly indexOptions?: DiffSearchIndexOptions;
  /**
   * Bring a match into view: open its file if folded (never fold), then
   * scroll to it. The signal aborts when another reveal starts or on unmount.
   */
  readonly revealMatch: (match: DiffSearchMatch, signal: AbortSignal) => Promise<void>;
  /** A file's path, for match identity across refreshes. */
  readonly filePathOf: (fileIndex: number) => string;
  /**
   * Start a new search at the first match from where the reader is (the first
   * file and row on screen) instead of the top of the diff (T3 Code). For a
   * view that shows every file; the Diff panel lists only matching files.
   */
  readonly startAtReadingPosition?: boolean;
  /** A new value clears the query: the view now shows another diff (a commit scope). */
  readonly scopeKey?: string | null;
}

export interface DiffSearchController {
  readonly query: string;
  readonly setQuery: (next: string) => void;
  readonly options: DiffSearchOptions;
  readonly toggleOption: (option: keyof DiffSearchOptions) => void;
  /** A searchable query has settled and the search ran. */
  readonly searching: boolean;
  /** `searching` and the pattern compiled: the matches can filter and highlight. */
  readonly active: boolean;
  readonly result: DiffSearchResult;
  readonly matchesByFileIndex: ReadonlyMap<number, readonly DiffSearchMatch[]>;
  /**
   * Files a list filtered by the search shows, in file order: those with a
   * match, plus those a partial search (truncated or stopped) did not finish.
   */
  readonly listedFileIndexes: readonly number[];
  readonly currentIndex: number;
  readonly current: DiffSearchMatch | null;
  /** Enter / Shift+Enter: the first Enter reveals the match the counter shows. */
  readonly goTo: (delta: 1 | -1) => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  /**
   * The find key: seed the query from a one-line selection inside the searched
   * view, then focus and select the field.
   */
  readonly focusFind: () => void;
  /** Clear the query; the options stay. */
  readonly clear: () => void;
  /** Clear the query and turn the options off (a new opening of the view). */
  readonly reset: () => void;
}

interface SearchPosition {
  readonly searchKey: string;
  readonly result: DiffSearchResult;
  readonly index: number;
  /** The match at `index` was brought into view since the search started. */
  readonly revealed: boolean;
  /** Identity of the match at `index`, to find it again after the files change. */
  readonly matchKey: string | null;
}

const EMPTY_MATCHES_BY_FILE: ReadonlyMap<number, readonly DiffSearchMatch[]> = new Map();

function keyOf(
  result: DiffSearchResult,
  index: number,
  filePathOf: (fileIndex: number) => string,
): string | null {
  const match = result.matches[index];
  return match ? diffSearchMatchKey(match, filePathOf(match.fileIndex)) : null;
}

/**
 * Where the current match is once the search or its result changed. A new
 * query or option starts over at `startIndex` (the first match, or the first
 * from the reading position); a refresh of the same search (a patch update)
 * keeps the match when its text is still there.
 */
function nextSearchPosition(
  previous: SearchPosition,
  searchKey: string,
  result: DiffSearchResult,
  filePathOf: (fileIndex: number) => string,
  startIndex: (matches: readonly DiffSearchMatch[]) => number,
): SearchPosition {
  if (previous.searchKey !== searchKey || previous.matchKey === null) {
    const index = startIndex(result.matches);
    return {
      searchKey,
      result,
      index,
      revealed: false,
      matchKey: keyOf(result, index, filePathOf),
    };
  }
  const matches = result.matches;
  const previousMatch = previous.result.matches[previous.index];
  let index = -1;
  if (keyOf(result, previous.index, filePathOf) === previous.matchKey) {
    index = previous.index;
  } else if (previousMatch) {
    // Only matches at the same offsets can be the same match; skip building other keys.
    index = matches.findIndex(
      (match) =>
        match.start === previousMatch.start &&
        match.end === previousMatch.end &&
        match.field === previousMatch.field &&
        diffSearchMatchKey(match, filePathOf(match.fileIndex)) === previous.matchKey,
    );
  }
  if (index === -1) index = Math.max(0, Math.min(previous.index, matches.length - 1));
  return {
    searchKey,
    result,
    index,
    revealed: previous.revealed,
    matchKey: keyOf(result, index, filePathOf),
  };
}

/**
 * Find in a diff surface: the query and its options, a lazily built index
 * (only while a query is active), the current match, navigation with a
 * reveal, and the highlights. Shared by the Diff panel and pull request files.
 */
export function useDiffSearch(input: UseDiffSearchInput): DiffSearchController {
  const { files, filePathOf, highlightName, indexOptions, renderMode, revealMatch, rootRef } =
    input;
  const startAtReadingPosition = input.startAtReadingPosition ?? false;
  const [query, setTypedQuery] = useState("");
  const [scopeKey, setScopeKey] = useState(input.scopeKey ?? null);
  if (scopeKey !== (input.scopeKey ?? null)) {
    // Adjusted during render; a reveal still pending aborts with the search key below.
    setScopeKey(input.scopeKey ?? null);
    setTypedQuery("");
  }
  const [options, setOptions] = useState<DiffSearchOptions>(DEFAULT_DIFF_SEARCH_OPTIONS);
  // Read when the query or an option changes (not during render), so the
  // search that follows starts where the reader is at that moment.
  const [readingPosition, setReadingPosition] = useState<DiffSearchReadingPosition | null>(null);
  const noteReadingPosition = useCallback(() => {
    if (startAtReadingPosition) setReadingPosition(readDiffSearchReadingPosition(rootRef.current));
  }, [rootRef, startAtReadingPosition]);
  const setQuery = useCallback(
    (next: string) => {
      noteReadingPosition();
      setTypedQuery(next);
    },
    [noteReadingPosition],
  );
  const [debouncedQuery] = useDebouncedValue(query, { wait: DIFF_SEARCH_DEBOUNCE_MS });
  // Clearing the field stops the search at once; typing waits for the debounce.
  const effectiveQuery = isSearchableDiffQuery(query) ? debouncedQuery : "";
  const searching = isSearchableDiffQuery(effectiveQuery);

  // Records are reused while one search session lasts and dropped with it, so
  // a closed search keeps no index in memory.
  const recordCache = useMemo(
    () => (searching ? createDiffSearchRecordCache() : null),
    [searching],
  );
  const index = useMemo(
    () =>
      searching && recordCache
        ? buildDiffSearchIndex(files, indexOptions, recordCache)
        : EMPTY_DIFF_SEARCH_INDEX,
    [files, indexOptions, recordCache, searching],
  );
  const result = useMemo(
    () => (searching ? searchDiffIndex(index, effectiveQuery, options) : EMPTY_DIFF_SEARCH_RESULT),
    [effectiveQuery, index, options, searching],
  );
  const active = searching && !result.invalidPattern;
  const matchesByFileIndex = useMemo(
    () =>
      result.matches.length === 0
        ? EMPTY_MATCHES_BY_FILE
        : groupDiffSearchMatchesByFileIndex(result.matches),
    [result],
  );
  const listedFileIndexes = useMemo(
    () => deriveDiffSearchListedFileIndexes(result, files.length),
    [files.length, result],
  );

  const searchKey = searching
    ? `${effectiveQuery}\u0000${Number(options.caseSensitive)}${Number(options.wholeWord)}${Number(options.regex)}`
    : "";
  const [storedPosition, setPosition] = useState<SearchPosition>(() => ({
    searchKey,
    result,
    index: 0,
    revealed: false,
    matchKey: null,
  }));
  let position = storedPosition;
  if (position.searchKey !== searchKey || position.result !== result) {
    // Adjusted during render (React's "information from previous renders"), so
    // the counter never shows a stale index for one frame.
    position = nextSearchPosition(position, searchKey, result, filePathOf, (matches) =>
      firstDiffSearchMatchIndexFrom(matches, readingPosition, renderMode),
    );
    setPosition(position);
  }
  const currentIndex = position.index;
  const current = result.matches[currentIndex] ?? null;

  useDiffSearchHighlights({
    rootRef,
    name: highlightName,
    matchesByFileIndex,
    current,
    renderMode,
    enabled: active,
    paintCurrent: input.paintCurrent ?? true,
  });

  const revealRef = useRef<{ readonly controller: AbortController; readonly searchKey: string }>(
    null,
  );
  // A reveal still waiting for its file must not scroll once the search changed.
  useEffect(() => {
    const reveal = revealRef.current;
    if (reveal && reveal.searchKey !== searchKey) reveal.controller.abort();
  }, [searchKey]);
  useEffect(
    () => () => {
      revealRef.current?.controller.abort();
    },
    [],
  );

  const goTo = useCallback(
    (delta: 1 | -1) => {
      const matches = position.result.matches;
      if (matches.length === 0) return;
      const next =
        delta === 1 && !position.revealed
          ? position.index
          : getNextDiffSearchMatchIndex(position.index, matches.length, delta);
      setPosition({
        ...position,
        index: next,
        revealed: true,
        matchKey: keyOf(position.result, next, filePathOf),
      });
      const match = matches[next];
      revealRef.current?.controller.abort();
      if (!match) return;
      const controller = new AbortController();
      revealRef.current = { controller, searchKey: position.searchKey };
      // A reveal is best effort: the counter already shows the match.
      void revealMatch(match, controller.signal).catch(() => undefined);
    },
    [filePathOf, position, revealMatch],
  );

  const inputRef = useRef<HTMLInputElement | null>(null);
  const focusFrameRef = useRef(0);
  useEffect(() => () => window.cancelAnimationFrame(focusFrameRef.current), []);

  const focusFind = useCallback(() => {
    const field = inputRef.current;
    // In the field already, the find key selects the query instead of replacing it.
    // A field that is not mounted yet (a find bar about to open) takes the seed too.
    if (field === null || document.activeElement !== field) {
      // Only text selected in the searched view seeds it, not a selection elsewhere on the page.
      const selected = readDiffSearchSeedSelection(rootRef.current);
      if (selected !== null) {
        setQuery(options.regex ? escapeDiffSearchRegExp(selected) : selected);
      }
    }
    window.cancelAnimationFrame(focusFrameRef.current);
    // The next frame, so a seeded query is in the field before it is selected.
    focusFrameRef.current = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [options.regex, rootRef, setQuery]);

  const clear = useCallback(() => {
    revealRef.current?.controller.abort();
    setTypedQuery("");
  }, []);

  const reset = useCallback(() => {
    revealRef.current?.controller.abort();
    setTypedQuery("");
    setOptions(DEFAULT_DIFF_SEARCH_OPTIONS);
  }, []);

  const toggleOption = useCallback(
    (option: keyof DiffSearchOptions) => {
      noteReadingPosition();
      setOptions((previous) => ({ ...previous, [option]: !previous[option] }));
    },
    [noteReadingPosition],
  );

  return {
    query,
    setQuery,
    options,
    toggleOption,
    searching,
    active,
    result,
    matchesByFileIndex,
    listedFileIndexes,
    currentIndex,
    current,
    goTo,
    inputRef,
    focusFind,
    clear,
    reset,
  };
}
