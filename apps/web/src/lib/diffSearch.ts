/**
 * Find in a diff: an index of the rendered lines (and file paths) of parsed
 * diff files, searched as plain text, whole words or a regular expression.
 * Pure: no DOM, no renderer import, so it runs in Node tests and benchmarks.
 */

export type DiffSearchLineKind = "addition" | "deletion" | "context";
export type DiffSearchField = "path" | "previousPath" | DiffSearchLineKind;
export type DiffSearchRenderMode = "stacked" | "split";
/** The column a line belongs to; context lines count as the new file's. */
export type DiffSearchSide = "additions" | "deletions";

interface DiffSearchContextContent {
  readonly type: "context";
  readonly lines: number;
  readonly additionLineIndex: number;
  readonly deletionLineIndex: number;
}

interface DiffSearchChangeContent {
  readonly type: "change";
  readonly deletions: number;
  readonly deletionLineIndex: number;
  readonly additions: number;
  readonly additionLineIndex: number;
}

interface DiffSearchHunk {
  readonly hunkContent: readonly (DiffSearchContextContent | DiffSearchChangeContent)[];
  readonly splitLineStart: number;
  readonly unifiedLineStart: number;
  /** First new-file line number of the hunk (`+X` in its header). */
  readonly additionStart?: number;
  /** First old-file line number of the hunk (`-X` in its header). */
  readonly deletionStart?: number;
}

export interface DiffSearchFile {
  readonly name?: string | null;
  readonly prevName?: string | null;
  readonly additionLines: readonly string[];
  readonly deletionLines: readonly string[];
  readonly hunks?: readonly DiffSearchHunk[];
}

export interface DiffSearchOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly regex: boolean;
}

export const DEFAULT_DIFF_SEARCH_OPTIONS: DiffSearchOptions = Object.freeze({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
});

/** Matches kept per search (T3 Code's `MAX_SEARCH_MATCHES`); a one-letter query stays bounded. */
export const DIFF_SEARCH_MAX_MATCHES = 100_000;

/**
 * How long one regular-expression search may run before it stops with what it
 * found. A pattern that backtracks badly would otherwise freeze the page.
 */
export const DIFF_SEARCH_REGEX_TIME_BUDGET_MS = 100;

/**
 * Records searched between two clock reads while a time budget applies. Small,
 * because a slow pattern can spend milliseconds on each line; a clock read
 * costs far less than one `exec`.
 */
const TIME_BUDGET_CHECK_INTERVAL = 16;

export interface DiffSearchIndexOptions {
  /** Index file paths too (default). A view whose file tree filters paths can leave them out. */
  readonly includePaths?: boolean;
}

export interface DiffSearchMatch {
  readonly fileIndex: number;
  readonly field: DiffSearchField;
  readonly lineIndex?: number | undefined;
  readonly unifiedLineIndex?: number | undefined;
  readonly splitLineIndex?: number | undefined;
  /** Column a reveal scrolls to (line matches only). */
  readonly side?: DiffSearchSide | undefined;
  /** 1-based file line number on `side`. */
  readonly lineNumber?: number | undefined;
  readonly start: number;
  readonly end: number;
}

/**
 * One searchable text: a path or a rendered line. Every record has the same
 * fields (unset ones are undefined), so the index is one compact shape.
 */
export interface DiffSearchIndexRecord {
  readonly field: DiffSearchField;
  readonly lineIndex: number | undefined;
  readonly unifiedLineIndex: number | undefined;
  readonly splitLineIndex: number | undefined;
  /** 1-based line number in the old file for a deletion, in the new file otherwise. */
  readonly lineNumber: number | undefined;
  readonly text: string;
  /**
   * `text` lowercased for case-insensitive search, or null when lowercasing
   * changes its length (`"İ".toLowerCase()` is two code units): offsets found
   * in the lowercased copy would then miss the rendered text.
   */
  readonly normalizedText: string | null;
}

export interface DiffSearchIndex {
  /** Each file's records, at the file's position in the searched list. */
  readonly files: readonly (readonly DiffSearchIndexRecord[])[];
}

/** Stand-in while no search is active, so large patches are indexed only on demand. */
export const EMPTY_DIFF_SEARCH_INDEX: DiffSearchIndex = Object.freeze({ files: [] });

/**
 * Records of files already indexed during one search session, keyed by the
 * file object. A refreshed patch that reuses unchanged file objects only
 * indexes the new ones. Drop it when the search ends so nothing outlives it.
 */
export type DiffSearchRecordCache = WeakMap<
  DiffSearchFile,
  { readonly key: string; readonly records: readonly DiffSearchIndexRecord[] }
>;

export function createDiffSearchRecordCache(): DiffSearchRecordCache {
  return new WeakMap();
}

export interface DiffSearchResult {
  readonly matches: readonly DiffSearchMatch[];
  /** More matches exist than `DIFF_SEARCH_MAX_MATCHES`. */
  readonly truncated: boolean;
  /** The regular expression did not compile. */
  readonly invalidPattern: boolean;
  /** The search ran out of time (a slow pattern); later files were not searched. */
  readonly stopped: boolean;
  /**
   * Files searched to their end, counted from the first. Files from this index
   * on were not searched completely (`truncated` or `stopped`), so they may
   * still hold matches.
   */
  readonly searchedFileCount: number;
}

export const EMPTY_DIFF_SEARCH_RESULT: DiffSearchResult = Object.freeze({
  matches: [],
  truncated: false,
  invalidPattern: false,
  stopped: false,
  searchedFileCount: 0,
});

export interface DiffSearchLimits {
  readonly maxMatches?: number;
  /** Applies to regular expressions only; plain and whole-word search are linear. */
  readonly regexTimeBudgetMs?: number;
  /** Clock override for tests. */
  readonly now?: () => number;
}

export interface DiffRenderedLineIndexes {
  readonly stacked: number;
  readonly split: number;
}

export function resolveDiffFilePath(fileDiff: Pick<DiffSearchFile, "name" | "prevName">): string {
  // Renderer metadata already uses repository-relative paths, including real a/ and b/ directories.
  return fileDiff.name ?? fileDiff.prevName ?? "";
}

/**
 * Whether a typed query searches at all. It is not trimmed (leading spaces
 * find indentation), but a blank query or one spanning lines finds nothing.
 */
export function isSearchableDiffQuery(query: string): boolean {
  return query.trim().length > 0 && !query.includes("\n");
}

const REGEXP_SYNTAX_CHARACTERS = /[\\^$.*+?()[\]{}|/]/g;

/** `text` as a regular expression that matches it literally. */
export function escapeDiffSearchRegExp(text: string): string {
  return text.replace(REGEXP_SYNTAX_CHARACTERS, "\\$&");
}

/** `git grep -w` word characters: ASCII letters, digits and `_`. Anything else is a boundary. */
function isWordCharacter(codeUnit: number): boolean {
  return (
    (codeUnit >= 0x30 && codeUnit <= 0x39) ||
    (codeUnit >= 0x41 && codeUnit <= 0x5a) ||
    (codeUnit >= 0x61 && codeUnit <= 0x7a) ||
    codeUnit === 0x5f
  );
}

/** Whether `[start, end)` of `text` is a whole word: a boundary or the line edge on both sides. */
export function isWholeWordMatch(text: string, start: number, end: number): boolean {
  return (
    (start <= 0 || !isWordCharacter(text.charCodeAt(start - 1))) &&
    (end >= text.length || !isWordCharacter(text.charCodeAt(end)))
  );
}

/** Where the code point after the one at `index` starts. */
function nextCodePointIndex(text: string, index: number): number {
  const codeUnit = text.charCodeAt(index);
  if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
    const next = text.charCodeAt(index + 1);
    if (next >= 0xdc00 && next <= 0xdfff) return index + 2;
  }
  return index + 1;
}

function appendSearchRecord(
  records: DiffSearchIndexRecord[],
  field: DiffSearchField,
  text: string | undefined,
  lineIndex?: number,
  unifiedLineIndex?: number,
  splitLineIndex?: number,
  lineNumber?: number,
): void {
  if (text === undefined) return;
  const lowered = text.toLowerCase();
  records.push({
    field,
    lineIndex,
    unifiedLineIndex,
    splitLineIndex,
    lineNumber,
    text,
    normalizedText: lowered.length === text.length ? lowered : null,
  });
}

function appendFallbackLineRecords(records: DiffSearchIndexRecord[], file: DiffSearchFile): void {
  file.additionLines.forEach((line, lineIndex) => {
    appendSearchRecord(records, "addition", line, lineIndex, undefined, undefined, lineIndex + 1);
  });
  file.deletionLines.forEach((line, lineIndex) => {
    appendSearchRecord(records, "deletion", line, lineIndex, undefined, undefined, lineIndex + 1);
  });
}

function appendHunkLineRecords(records: DiffSearchIndexRecord[], file: DiffSearchFile): boolean {
  if (!file.hunks || file.hunks.length === 0) {
    return false;
  }

  for (const hunk of file.hunks) {
    let unifiedLineCursor = hunk.unifiedLineStart;
    let splitLineCursor = hunk.splitLineStart;
    // Line numbers walk from the hunk header; a hunk without one records none.
    let additionNumber = hunk.additionStart ?? Number.NaN;
    let deletionNumber = hunk.deletionStart ?? Number.NaN;
    const numbered = (value: number) => (Number.isNaN(value) ? undefined : value);

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const additionLineIndex = content.additionLineIndex + offset;
          appendSearchRecord(
            records,
            "context",
            file.additionLines[additionLineIndex] ??
              file.deletionLines[content.deletionLineIndex + offset],
            additionLineIndex,
            unifiedLineCursor + offset,
            splitLineCursor + offset,
            numbered(additionNumber + offset),
          );
        }
        unifiedLineCursor += content.lines;
        splitLineCursor += content.lines;
        additionNumber += content.lines;
        deletionNumber += content.lines;
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        const deletionLineIndex = content.deletionLineIndex + offset;
        appendSearchRecord(
          records,
          "deletion",
          file.deletionLines[deletionLineIndex],
          deletionLineIndex,
          unifiedLineCursor + offset,
          splitLineCursor + offset,
          numbered(deletionNumber + offset),
        );
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        const additionLineIndex = content.additionLineIndex + offset;
        appendSearchRecord(
          records,
          "addition",
          file.additionLines[additionLineIndex],
          additionLineIndex,
          unifiedLineCursor + content.deletions + offset,
          splitLineCursor + offset,
          numbered(additionNumber + offset),
        );
      }

      unifiedLineCursor += content.deletions + content.additions;
      splitLineCursor += Math.max(content.deletions, content.additions);
      deletionNumber += content.deletions;
      additionNumber += content.additions;
    }
  }

  return true;
}

function buildFileRecords(
  file: DiffSearchFile,
  includePaths: boolean,
): readonly DiffSearchIndexRecord[] {
  const records: DiffSearchIndexRecord[] = [];
  if (includePaths) {
    appendSearchRecord(records, "path", resolveDiffFilePath(file));
    if (file.prevName) {
      appendSearchRecord(records, "previousPath", resolveDiffFilePath({ name: file.prevName }));
    }
  }
  if (!appendHunkLineRecords(records, file)) {
    appendFallbackLineRecords(records, file);
  }
  return records;
}

export function buildDiffSearchIndex(
  files: readonly DiffSearchFile[],
  options?: DiffSearchIndexOptions,
  cache?: DiffSearchRecordCache,
): DiffSearchIndex {
  const includePaths = options?.includePaths ?? true;
  const key = includePaths ? "paths" : "lines";
  return {
    files: files.map((file) => {
      const cached = cache?.get(file);
      if (cached && cached.key === key) return cached.records;
      const records = buildFileRecords(file, includePaths);
      cache?.set(file, { key, records });
      return records;
    }),
  };
}

interface Occurrence {
  readonly start: number;
  readonly end: number;
}

/** The first occurrence at or after `from` in a record, before the whole-word rule. */
type OccurrenceFinder = (record: DiffSearchIndexRecord, from: number) => Occurrence | null;

function regExpFinder(pattern: RegExp, text: (record: DiffSearchIndexRecord) => string) {
  return (record: DiffSearchIndexRecord, from: number): Occurrence | null => {
    const haystack = text(record);
    let at = from;
    while (at <= haystack.length) {
      pattern.lastIndex = at;
      const found = pattern.exec(haystack);
      if (found === null) return null;
      // A zero-length match (`a*`, `^`) is no hit; look past it (T3 Code).
      if (found[0].length > 0) return { start: found.index, end: found.index + found[0].length };
      at = found.index + 1;
    }
    return null;
  };
}

function createOccurrenceFinder(
  query: string,
  options: DiffSearchOptions,
): OccurrenceFinder | "invalid" {
  if (options.regex) {
    let pattern: RegExp;
    try {
      // T3 Code's flags; `u` would reject escapes people type by habit (`\-`).
      pattern = new RegExp(query, options.caseSensitive ? "g" : "gi");
    } catch {
      return "invalid";
    }
    return regExpFinder(pattern, (record) => record.text);
  }
  if (options.caseSensitive) {
    return (record, from) => {
      const start = record.text.indexOf(query, from);
      return start === -1 ? null : { start, end: start + query.length };
    };
  }
  const needle = query.toLowerCase();
  let folded: OccurrenceFinder | null = null;
  return (record, from) => {
    if (record.normalizedText === null) {
      // Lowercasing moves this line's offsets; fold case in the pattern instead (Find in files).
      folded ??= regExpFinder(
        new RegExp(escapeDiffSearchRegExp(query), "giu"),
        (entry) => entry.text,
      );
      return folded(record, from);
    }
    const start = record.normalizedText.indexOf(needle, from);
    return start === -1 ? null : { start, end: start + needle.length };
  };
}

/** The column a field's line sits in; paths have none. */
export function diffSearchFieldSide(field: DiffSearchField): DiffSearchSide | undefined {
  switch (field) {
    case "deletion":
      return "deletions";
    case "addition":
    case "context":
      return "additions";
    default:
      return undefined;
  }
}

function createMatch(
  fileIndex: number,
  record: DiffSearchIndexRecord,
  occurrence: Occurrence,
): DiffSearchMatch {
  return {
    fileIndex,
    field: record.field,
    lineIndex: record.lineIndex,
    unifiedLineIndex: record.unifiedLineIndex,
    splitLineIndex: record.splitLineIndex,
    side: diffSearchFieldSide(record.field),
    lineNumber: record.lineNumber,
    start: occurrence.start,
    end: occurrence.end,
  };
}

/**
 * Every match of `query` in the index, in file and line order. Matches on one
 * line never overlap. Stops after `maxMatches` (`truncated`), on an invalid
 * pattern (`invalidPattern`) and, for regular expressions, when the time
 * budget runs out (`stopped`).
 */
export function searchDiffIndex(
  index: DiffSearchIndex,
  query: string,
  options: DiffSearchOptions,
  limits?: DiffSearchLimits,
): DiffSearchResult {
  if (!isSearchableDiffQuery(query)) return EMPTY_DIFF_SEARCH_RESULT;
  const finder = createOccurrenceFinder(query, options);
  if (finder === "invalid") return { ...EMPTY_DIFF_SEARCH_RESULT, invalidPattern: true };

  const maxMatches = limits?.maxMatches ?? DIFF_SEARCH_MAX_MATCHES;
  const now = limits?.now ?? (() => performance.now());
  const timeBudgetMs = options.regex
    ? (limits?.regexTimeBudgetMs ?? DIFF_SEARCH_REGEX_TIME_BUDGET_MS)
    : Number.POSITIVE_INFINITY;
  const startedAt = Number.isFinite(timeBudgetMs) ? now() : 0;
  // Counted per record and per search step within a record: one long line (a minified bundle)
  // with many matches the whole-word check rejects restarts the search once per rejection.
  let stepsSinceClockRead = 0;
  const outOfTime = () => {
    if (!Number.isFinite(timeBudgetMs) || ++stepsSinceClockRead < TIME_BUDGET_CHECK_INTERVAL)
      return false;
    stepsSinceClockRead = 0;
    return now() - startedAt > timeBudgetMs;
  };

  const matches: DiffSearchMatch[] = [];
  for (let fileIndex = 0; fileIndex < index.files.length; fileIndex += 1) {
    const records = index.files[fileIndex]!;
    const stopped = (): DiffSearchResult => ({
      matches,
      truncated: false,
      invalidPattern: false,
      stopped: true,
      searchedFileCount: fileIndex,
    });
    for (const record of records) {
      if (outOfTime()) return stopped();
      let from = 0;
      while (from <= record.text.length) {
        if (from > 0 && outOfTime()) return stopped();
        const occurrence = finder(record, from);
        if (occurrence === null) break;
        if (options.wholeWord && !isWholeWordMatch(record.text, occurrence.start, occurrence.end)) {
          // A later whole word on the same line still counts.
          from = nextCodePointIndex(record.text, occurrence.start);
          continue;
        }
        if (matches.length === maxMatches) {
          return {
            matches,
            truncated: true,
            invalidPattern: false,
            stopped: false,
            searchedFileCount: fileIndex,
          };
        }
        matches.push(createMatch(fileIndex, record, occurrence));
        from = occurrence.end;
      }
    }
  }
  return {
    matches,
    truncated: false,
    invalidPattern: false,
    stopped: false,
    searchedFileCount: index.files.length,
  };
}

function isDiffSearchIndex(
  input: readonly DiffSearchFile[] | DiffSearchIndex,
): input is DiffSearchIndex {
  return !Array.isArray(input);
}

/** `searchDiffIndex(...).matches`, building the index first when given files. */
export function findDiffSearchMatches(
  source: readonly DiffSearchFile[] | DiffSearchIndex,
  query: string,
  options?: Partial<DiffSearchOptions>,
): DiffSearchMatch[] {
  const index = isDiffSearchIndex(source) ? source : buildDiffSearchIndex(source);
  return [...searchDiffIndex(index, query, { ...DEFAULT_DIFF_SEARCH_OPTIONS, ...options }).matches];
}

/**
 * A match's identity across re-indexing (a refreshed patch, a new head): the
 * current match survives a refresh when the same text is still there.
 */
export function diffSearchMatchKey(match: DiffSearchMatch, filePath: string): string {
  return [
    filePath,
    match.field,
    match.side ?? "",
    match.lineNumber ?? match.lineIndex ?? "",
    match.start,
    match.end,
  ].join("\u0000");
}

/** Whether two matches of the same search point at the same text. */
export function isSameDiffSearchMatch(left: DiffSearchMatch, right: DiffSearchMatch): boolean {
  return (
    left.fileIndex === right.fileIndex &&
    left.field === right.field &&
    left.lineIndex === right.lineIndex &&
    left.unifiedLineIndex === right.unifiedLineIndex &&
    left.splitLineIndex === right.splitLineIndex &&
    left.start === right.start &&
    left.end === right.end
  );
}

export function deriveDiffSearchFileIndexes(matches: readonly DiffSearchMatch[]): number[] {
  return [...new Set(matches.map((match) => match.fileIndex))];
}

/**
 * The files a list filtered by a search shows, in file order: each file with a
 * match, then every file a partial search (`truncated` or `stopped`) did not
 * finish, since those may match too.
 */
export function deriveDiffSearchListedFileIndexes(
  result: DiffSearchResult,
  fileCount: number,
): number[] {
  const listed = deriveDiffSearchFileIndexes(result.matches);
  for (let fileIndex = result.searchedFileCount; fileIndex < fileCount; fileIndex += 1) {
    // Matches are in file order, so only the last listed file can be the first unfinished one.
    if (listed.at(-1) !== fileIndex) listed.push(fileIndex);
  }
  return listed;
}

export function groupDiffSearchMatchesByFileIndex(
  matches: readonly DiffSearchMatch[],
): ReadonlyMap<number, readonly DiffSearchMatch[]> {
  const groups = new Map<number, DiffSearchMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.fileIndex);
    if (group) {
      group.push(match);
    } else {
      groups.set(match.fileIndex, [match]);
    }
  }
  return groups;
}

export function getNextDiffSearchMatchIndex(
  currentIndex: number,
  matchCount: number,
  delta: 1 | -1,
): number {
  if (matchCount <= 0) return 0;
  return (currentIndex + delta + matchCount) % matchCount;
}

export function getDiffSearchMatchRenderedLineIndex(
  match: DiffSearchMatch,
  renderMode: DiffSearchRenderMode,
): number | null {
  if (match.field === "path" || match.field === "previousPath") {
    return null;
  }
  return (
    (renderMode === "split" ? match.splitLineIndex : match.unifiedLineIndex) ??
    match.lineIndex ??
    null
  );
}

export function isDiffSearchMatchLineField(field: DiffSearchField): field is DiffSearchLineKind {
  return field === "addition" || field === "deletion" || field === "context";
}

export function parseDiffRenderedLineIndexes(value: string | null): DiffRenderedLineIndexes | null {
  if (!value) return null;
  const [stackedRaw, splitRaw] = value.split(",");
  const stacked = Number.parseInt(stackedRaw ?? "", 10);
  if (!Number.isFinite(stacked)) {
    return null;
  }
  const split = Number.parseInt(splitRaw ?? "", 10);
  return {
    stacked,
    split: Number.isFinite(split) ? split : stacked,
  };
}

/** Whether a rendered row (its line type) can show `match`; the row index is checked by the caller's lookup. */
export function doesDiffSearchMatchRenderedLineType(
  match: DiffSearchMatch,
  lineType: string | null,
): boolean {
  switch (match.field) {
    case "addition":
      return lineType === "change-addition" || lineType === "addition";
    case "deletion":
      return lineType === "change-deletion" || lineType === "deletion";
    case "context":
      return lineType === "context" || lineType === "context-expanded";
    default:
      return false;
  }
}

export function doesDiffSearchMatchRenderedLine(
  match: DiffSearchMatch,
  input: {
    readonly renderMode: DiffSearchRenderMode;
    readonly lineIndexes: DiffRenderedLineIndexes;
    readonly lineType: string | null;
  },
): boolean {
  if (!isDiffSearchMatchLineField(match.field)) {
    return false;
  }
  const renderedLineIndex = getDiffSearchMatchRenderedLineIndex(match, input.renderMode);
  const candidateLineIndex =
    input.renderMode === "split" ? input.lineIndexes.split : input.lineIndexes.stacked;
  if (renderedLineIndex !== candidateLineIndex) {
    return false;
  }
  return doesDiffSearchMatchRenderedLineType(match, input.lineType);
}
