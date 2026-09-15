export type DiffSearchLineKind = "addition" | "deletion" | "context";
export type DiffSearchField = "path" | "previousPath" | DiffSearchLineKind;
export type DiffSearchRenderMode = "stacked" | "split";

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
}

export interface DiffSearchFile {
  readonly name?: string | null;
  readonly prevName?: string | null;
  readonly additionLines: readonly string[];
  readonly deletionLines: readonly string[];
  readonly hunks?: readonly DiffSearchHunk[];
}

export interface DiffSearchMatch {
  readonly fileIndex: number;
  readonly field: DiffSearchField;
  readonly lineIndex?: number;
  readonly unifiedLineIndex?: number;
  readonly splitLineIndex?: number;
  readonly start: number;
  readonly end: number;
}

export interface DiffSearchIndexRecord {
  readonly fileIndex: number;
  readonly field: DiffSearchField;
  readonly lineIndex?: number;
  readonly unifiedLineIndex?: number;
  readonly splitLineIndex?: number;
  readonly text: string;
  readonly normalizedText: string;
}

export interface DiffSearchIndex {
  readonly records: readonly DiffSearchIndexRecord[];
}

export interface DiffRenderedLineIndexes {
  readonly stacked: number;
  readonly split: number;
}

export function resolveDiffFilePath(fileDiff: Pick<DiffSearchFile, "name" | "prevName">): string {
  // Renderer metadata already uses repository-relative paths, including real a/ and b/ directories.
  return fileDiff.name ?? fileDiff.prevName ?? "";
}

export function normalizeDiffSearchQuery(query: string, caseSensitive = false): string {
  const trimmed = query.trim();
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

function appendSearchRecord(
  records: DiffSearchIndexRecord[],
  input: {
    readonly fileIndex: number;
    readonly field: DiffSearchField;
    readonly text: string | undefined;
    readonly lineIndex?: number;
    readonly unifiedLineIndex?: number;
    readonly splitLineIndex?: number;
  },
): void {
  if (input.text === undefined) return;
  records.push({
    fileIndex: input.fileIndex,
    field: input.field,
    text: input.text,
    normalizedText: input.text.toLowerCase(),
    ...(input.lineIndex === undefined ? {} : { lineIndex: input.lineIndex }),
    ...(input.unifiedLineIndex === undefined ? {} : { unifiedLineIndex: input.unifiedLineIndex }),
    ...(input.splitLineIndex === undefined ? {} : { splitLineIndex: input.splitLineIndex }),
  });
}

function appendFallbackLineRecords(
  records: DiffSearchIndexRecord[],
  file: DiffSearchFile,
  fileIndex: number,
): void {
  file.additionLines.forEach((line, lineIndex) => {
    appendSearchRecord(records, {
      fileIndex,
      field: "addition",
      lineIndex,
      text: line,
    });
  });
  file.deletionLines.forEach((line, lineIndex) => {
    appendSearchRecord(records, {
      fileIndex,
      field: "deletion",
      lineIndex,
      text: line,
    });
  });
}

function appendHunkLineRecords(
  records: DiffSearchIndexRecord[],
  file: DiffSearchFile,
  fileIndex: number,
): boolean {
  if (!file.hunks || file.hunks.length === 0) {
    return false;
  }

  for (const hunk of file.hunks) {
    let unifiedLineCursor = hunk.unifiedLineStart;
    let splitLineCursor = hunk.splitLineStart;

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        for (let offset = 0; offset < content.lines; offset += 1) {
          const additionLineIndex = content.additionLineIndex + offset;
          const deletionLineIndex = content.deletionLineIndex + offset;
          appendSearchRecord(records, {
            fileIndex,
            field: "context",
            lineIndex: additionLineIndex,
            unifiedLineIndex: unifiedLineCursor + offset,
            splitLineIndex: splitLineCursor + offset,
            text: file.additionLines[additionLineIndex] ?? file.deletionLines[deletionLineIndex],
          });
        }
        unifiedLineCursor += content.lines;
        splitLineCursor += content.lines;
        continue;
      }

      for (let offset = 0; offset < content.deletions; offset += 1) {
        const deletionLineIndex = content.deletionLineIndex + offset;
        appendSearchRecord(records, {
          fileIndex,
          field: "deletion",
          lineIndex: deletionLineIndex,
          unifiedLineIndex: unifiedLineCursor + offset,
          splitLineIndex: splitLineCursor + offset,
          text: file.deletionLines[deletionLineIndex],
        });
      }
      for (let offset = 0; offset < content.additions; offset += 1) {
        const additionLineIndex = content.additionLineIndex + offset;
        appendSearchRecord(records, {
          fileIndex,
          field: "addition",
          lineIndex: additionLineIndex,
          unifiedLineIndex: unifiedLineCursor + content.deletions + offset,
          splitLineIndex: splitLineCursor + offset,
          text: file.additionLines[additionLineIndex],
        });
      }

      unifiedLineCursor += content.deletions + content.additions;
      splitLineCursor += Math.max(content.deletions, content.additions);
    }
  }

  return true;
}

export function buildDiffSearchIndex(files: readonly DiffSearchFile[]): DiffSearchIndex {
  const records: DiffSearchIndexRecord[] = [];
  files.forEach((file, fileIndex) => {
    appendSearchRecord(records, {
      text: resolveDiffFilePath(file),
      fileIndex,
      field: "path",
    });
    if (file.prevName) {
      appendSearchRecord(records, {
        text: resolveDiffFilePath({ name: file.prevName }),
        fileIndex,
        field: "previousPath",
      });
    }

    if (!appendHunkLineRecords(records, file, fileIndex)) {
      appendFallbackLineRecords(records, file, fileIndex);
    }
  });

  return { records };
}

function collectRecordMatches(input: {
  readonly record: DiffSearchIndexRecord;
  readonly needle: string;
  readonly caseSensitive: boolean;
}): DiffSearchMatch[] {
  const haystack = input.caseSensitive ? input.record.text : input.record.normalizedText;
  const matches: DiffSearchMatch[] = [];
  let from = 0;
  while (true) {
    const start = haystack.indexOf(input.needle, from);
    if (start === -1) return matches;
    const end = start + input.needle.length;
    matches.push({
      fileIndex: input.record.fileIndex,
      field: input.record.field,
      ...(input.record.lineIndex === undefined ? {} : { lineIndex: input.record.lineIndex }),
      ...(input.record.unifiedLineIndex === undefined
        ? {}
        : { unifiedLineIndex: input.record.unifiedLineIndex }),
      ...(input.record.splitLineIndex === undefined
        ? {}
        : { splitLineIndex: input.record.splitLineIndex }),
      start,
      end,
    });
    from = end > start ? end : start + 1;
  }
}

function isDiffSearchIndex(
  input: readonly DiffSearchFile[] | DiffSearchIndex,
): input is DiffSearchIndex {
  return !Array.isArray(input);
}

export function findDiffSearchMatches(
  source: readonly DiffSearchFile[] | DiffSearchIndex,
  query: string,
  options?: { readonly caseSensitive?: boolean },
): DiffSearchMatch[] {
  const caseSensitive = options?.caseSensitive ?? false;
  const needle = normalizeDiffSearchQuery(query, caseSensitive);
  if (!needle) return [];

  const index = isDiffSearchIndex(source) ? source : buildDiffSearchIndex(source);
  const matches: DiffSearchMatch[] = [];
  for (const record of index.records) {
    matches.push(...collectRecordMatches({ record, needle, caseSensitive }));
  }

  return matches;
}

export function deriveDiffSearchFileIndexes(matches: readonly DiffSearchMatch[]): number[] {
  return [...new Set(matches.map((match) => match.fileIndex))];
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

  switch (match.field) {
    case "addition":
      return input.lineType === "change-addition" || input.lineType === "addition";
    case "deletion":
      return input.lineType === "change-deletion" || input.lineType === "deletion";
    case "context":
      return input.lineType === "context" || input.lineType === "context-expanded";
  }
}
