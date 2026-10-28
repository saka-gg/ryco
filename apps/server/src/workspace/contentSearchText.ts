import type { ProjectContentMatch, ProjectContentMatchRange } from "@ryco/contracts";

import type { VcsWorkspaceContentLine } from "../vcs/VcsDriver.ts";

/** Ranges highlighted per matching line; the line itself is still one match. */
const MAX_RANGES_PER_LINE = 32;
/** A longer line is cut to a window around its first match. */
const PREVIEW_MAX_LENGTH = 1_024;
/** How much of a cut line is kept before its first match. */
const PREVIEW_LEADING_CONTEXT = 120;
const PREVIEW_ELLIPSIS = "…";
const CURSOR_PREFIX = "v1:";
const SCAN_CURSOR_PREFIX = "v1s:";
const REGEXP_SYNTAX_CHARACTERS = /[\\^$.*+?()[\]{}|/]/g;

export interface ContentSearchOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
}

export interface LiteralMatcher {
  /**
   * The first `maxLines` matching lines of the file at `path`, numbered from 1.
   * Lines end at `\n` only, as in git; a trailing `\r` stays out of the preview.
   */
  readonly findMatches: (path: string, text: string, maxLines: number) => ProjectContentMatch[];
  /**
   * A line git found the query on, highlighted as this matcher finds it there.
   * Where the two fold case differently, git's first match is highlighted.
   */
  readonly matchFoundLine: (path: string, line: VcsWorkspaceContentLine) => ProjectContentMatch;
}

/** Whether a line is already cut short at either end before its preview is built. */
export interface MatchPreviewCut {
  readonly cutStart: boolean;
  readonly cutEnd: boolean;
}

const UNCUT: MatchPreviewCut = { cutStart: false, cutEnd: false };

interface Occurrence {
  readonly start: number;
  readonly end: number;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
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

function isWholeWord(text: string, occurrence: Occurrence): boolean {
  return (
    (occurrence.start === 0 || !isWordCharacter(text.charCodeAt(occurrence.start - 1))) &&
    (occurrence.end >= text.length || !isWordCharacter(text.charCodeAt(occurrence.end)))
  );
}

/** Where the code point after the one at `index` starts. */
function nextCodePointIndex(text: string, index: number): number {
  return isHighSurrogate(text.charCodeAt(index)) && isLowSurrogate(text.charCodeAt(index + 1))
    ? index + 2
    : index + 1;
}

/**
 * Matches a literal query the way `git grep -F [-i] [-w]` does: case-insensitive
 * matching folds case, and a whole word needs a non-word character or the line
 * edge on both sides. Matches on one line never overlap.
 */
export function makeLiteralMatcher(query: string, options: ContentSearchOptions): LiteralMatcher {
  const foldedPattern = options.caseSensitive
    ? null
    : new RegExp(query.replace(REGEXP_SYNTAX_CHARACTERS, "\\$&"), "giu");

  const nextOccurrence = (text: string, from: number): Occurrence | null => {
    if (foldedPattern === null) {
      const start = text.indexOf(query, from);
      return start === -1 ? null : { start, end: start + query.length };
    }
    foldedPattern.lastIndex = from;
    const match = foldedPattern.exec(text);
    return match === null ? null : { start: match.index, end: match.index + match[0].length };
  };

  /** The next occurrence that passes the whole-word rule, when it applies. */
  const nextHit = (text: string, from: number): Occurrence | null => {
    let occurrence = nextOccurrence(text, from);
    while (occurrence !== null && options.wholeWord && !isWholeWord(text, occurrence)) {
      occurrence = nextOccurrence(text, nextCodePointIndex(text, occurrence.start));
    }
    return occurrence;
  };

  return {
    findMatches: (path, text, maxLines) => {
      const matches: ProjectContentMatch[] = [];
      let lineNumber = 1;
      let lineStart = 0;
      let hit = nextHit(text, 0);
      while (hit !== null && matches.length < maxLines) {
        for (
          let newline = text.indexOf("\n", lineStart);
          newline !== -1 && newline < hit.start;
          newline = text.indexOf("\n", lineStart)
        ) {
          lineNumber += 1;
          lineStart = newline + 1;
        }
        const newline = text.indexOf("\n", hit.start);
        const lineEnd = newline === -1 ? text.length : newline;
        const ranges: ProjectContentMatchRange[] = [];
        while (hit !== null && hit.start < lineEnd && ranges.length < MAX_RANGES_PER_LINE) {
          ranges.push({ start: hit.start - lineStart, end: hit.end - lineStart });
          hit = nextHit(text, hit.end);
        }
        const previewEnd = text.charCodeAt(lineEnd - 1) === 0x0d ? lineEnd - 1 : lineEnd;
        matches.push({
          path,
          lineNumber,
          ...buildMatchPreview(text.slice(lineStart, previewEnd), ranges),
        });
        if (hit !== null && hit.start < lineEnd) hit = nextHit(text, lineEnd);
      }
      return matches;
    },
    matchFoundLine: (path, line) => {
      const ranges: ProjectContentMatchRange[] = [];
      for (
        let hit = nextHit(line.text, 0);
        hit !== null && ranges.length < MAX_RANGES_PER_LINE;
        hit = nextHit(line.text, hit.end)
      ) {
        ranges.push(hit);
      }
      if (ranges.length === 0 && line.matchStart < line.text.length) {
        ranges.push({
          start: line.matchStart,
          end: Math.min(line.text.length, line.matchStart + query.length),
        });
      }
      return { path, lineNumber: line.lineNumber, ...buildMatchPreview(line.text, ranges, line) };
    },
  };
}

/**
 * The line itself, or past 1,024 characters a window starting a little before
 * its first range, with `…` at each cut edge, including edges `cut` reports
 * for a line that arrived cut short. Ranges move with the window, and those
 * outside it are dropped.
 */
export function buildMatchPreview(
  line: string,
  ranges: ReadonlyArray<ProjectContentMatchRange>,
  cut: MatchPreviewCut = UNCUT,
): Pick<ProjectContentMatch, "preview" | "ranges"> {
  if (line.length <= PREVIEW_MAX_LENGTH && !cut.cutStart && !cut.cutEnd) {
    return { preview: line, ranges };
  }
  const windowLength = PREVIEW_MAX_LENGTH - 2 * PREVIEW_ELLIPSIS.length;
  let start = Math.max(
    0,
    Math.min((ranges[0]?.start ?? 0) - PREVIEW_LEADING_CONTEXT, line.length - windowLength),
  );
  if (isLowSurrogate(line.charCodeAt(start))) start += 1;
  let end = Math.min(line.length, start + windowLength);
  if (end < line.length && isHighSurrogate(line.charCodeAt(end - 1))) end -= 1;
  const prefix = start > 0 || cut.cutStart ? PREVIEW_ELLIPSIS : "";
  const suffix = end < line.length || cut.cutEnd ? PREVIEW_ELLIPSIS : "";
  const shift = prefix.length - start;
  const shifted: ProjectContentMatchRange[] = [];
  for (const range of ranges) {
    const rangeStart = Math.max(range.start, start);
    const rangeEnd = Math.min(range.end, end);
    if (rangeStart < rangeEnd) shifted.push({ start: rangeStart + shift, end: rangeEnd + shift });
  }
  return { preview: `${prefix}${line.slice(start, end)}${suffix}`, ranges: shifted };
}

export interface ContentSearchCursor {
  /** The page resumes after this path in UTF-8 byte order; "" resumes from the first file. */
  readonly afterPath: string;
  /** Scan the index even where git could search: git ran out of time or failed on an earlier page. */
  readonly scanIndex: boolean;
}

export function encodeContentSearchCursor(cursor: ContentSearchCursor): string {
  return `${cursor.scanIndex ? SCAN_CURSOR_PREFIX : CURSOR_PREFIX}${cursor.afterPath}`;
}

/** Where a cursor resumes, or null for a cursor this node did not issue. */
export function decodeContentSearchCursor(cursor: string): ContentSearchCursor | null {
  if (cursor.startsWith(SCAN_CURSOR_PREFIX)) {
    return { afterPath: cursor.slice(SCAN_CURSOR_PREFIX.length), scanIndex: true };
  }
  if (cursor.startsWith(CURSOR_PREFIX)) {
    return { afterPath: cursor.slice(CURSOR_PREFIX.length), scanIndex: false };
  }
  return null;
}
