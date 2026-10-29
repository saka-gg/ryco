import { describe, expect, it } from "vite-plus/test";

import {
  buildDiffSearchIndex,
  createDiffSearchRecordCache,
  DEFAULT_DIFF_SEARCH_OPTIONS,
  deriveDiffSearchFileIndexes,
  deriveDiffSearchListedFileIndexes,
  diffSearchMatchKey,
  doesDiffSearchMatchRenderedLine,
  type DiffSearchFile,
  type DiffSearchOptions,
  findDiffSearchMatches,
  getDiffSearchMatchRenderedLineIndex,
  getNextDiffSearchMatchIndex,
  isWholeWordMatch,
  parseDiffRenderedLineIndexes,
  searchDiffIndex,
} from "./diffSearch";

const files = [
  {
    name: "b/src/alpha.ts",
    prevName: "a/src/alpha.ts",
    additionLines: ["Alpha beta", "literal .* pattern"],
    deletionLines: ["removed alpha"],
  },
  {
    name: "b/src/bravo.ts",
    prevName: "a/src/bravo.ts",
    additionLines: ["bravo ALPHA"],
    deletionLines: ["unchanged"],
  },
] satisfies DiffSearchFile[];

describe("findDiffSearchMatches", () => {
  it("finds matches across file paths and hunk lines case-insensitively by default", () => {
    const matches = findDiffSearchMatches(files, "alpha");
    expect(matches.map((match) => [match.fileIndex, match.field, match.lineIndex])).toEqual([
      [0, "path", undefined],
      [0, "previousPath", undefined],
      [0, "addition", 0],
      [0, "deletion", 0],
      [1, "addition", 0],
    ]);
    expect(deriveDiffSearchFileIndexes(matches)).toEqual([0, 1]);
  });

  it("honors case-sensitive search when requested", () => {
    expect(findDiffSearchMatches(files, "Alpha", { caseSensitive: true })).toEqual([
      {
        fileIndex: 0,
        field: "addition",
        lineIndex: 0,
        side: "additions",
        lineNumber: 1,
        start: 0,
        end: 5,
      },
    ]);
  });

  it("returns no matches for an empty query", () => {
    expect(findDiffSearchMatches(files, "")).toEqual([]);
    expect(findDiffSearchMatches(files, "   ")).toEqual([]);
  });

  it("treats multibyte characters and regex syntax as literal text", () => {
    const matches = findDiffSearchMatches(
      [
        {
          name: "b/src/café.ts",
          additionLines: ["const label = 'naïve .* pattern';"],
          deletionLines: [],
        },
      ],
      "naïve .*",
    );

    expect(matches).toEqual([
      {
        fileIndex: 0,
        field: "addition",
        lineIndex: 0,
        side: "additions",
        lineNumber: 1,
        start: 15,
        end: 23,
      },
    ]);
    expect(findDiffSearchMatches(matchesFileWithCafePath(), "café")).toHaveLength(1);
  });
});

describe("buildDiffSearchIndex", () => {
  const hunkBackedFiles = [
    {
      name: "b/src/sample.ts",
      additionLines: ["shared context", "new alpha", "tail context"],
      deletionLines: ["shared context", "old alpha", "tail context"],
      hunks: [
        {
          unifiedLineStart: 0,
          splitLineStart: 0,
          hunkContent: [
            {
              type: "context",
              lines: 1,
              additionLineIndex: 0,
              deletionLineIndex: 0,
            },
            {
              type: "change",
              deletions: 1,
              deletionLineIndex: 1,
              additions: 1,
              additionLineIndex: 1,
            },
            {
              type: "context",
              lines: 1,
              additionLineIndex: 2,
              deletionLineIndex: 2,
            },
          ],
        },
      ],
    },
  ] satisfies DiffSearchFile[];

  it("indexes context lines once from hunk metadata", () => {
    const matches = findDiffSearchMatches(buildDiffSearchIndex(hunkBackedFiles), "context");

    expect(matches.map((match) => [match.field, match.lineIndex])).toEqual([
      ["context", 0],
      ["context", 2],
    ]);
  });

  it("maps hunk line matches to stacked and split rendered rows", () => {
    const matches = findDiffSearchMatches(buildDiffSearchIndex(hunkBackedFiles), "alpha");

    expect(
      matches.map((match) => [
        match.field,
        getDiffSearchMatchRenderedLineIndex(match, "stacked"),
        getDiffSearchMatchRenderedLineIndex(match, "split"),
      ]),
    ).toEqual([
      ["deletion", 1, 1],
      ["addition", 2, 1],
    ]);
    expect(
      doesDiffSearchMatchRenderedLine(matches[1]!, {
        renderMode: "split",
        lineIndexes: { stacked: 2, split: 1 },
        lineType: "change-addition",
      }),
    ).toBe(true);
    expect(
      doesDiffSearchMatchRenderedLine(matches[0]!, {
        renderMode: "split",
        lineIndexes: { stacked: 2, split: 1 },
        lineType: "change-addition",
      }),
    ).toBe(false);
  });

  it("parses Pierre's composite rendered line indexes", () => {
    expect(parseDiffRenderedLineIndexes("2,1")).toEqual({ stacked: 2, split: 1 });
    expect(parseDiffRenderedLineIndexes("2")).toEqual({ stacked: 2, split: 2 });
    expect(parseDiffRenderedLineIndexes("bad")).toBeNull();
  });
});

describe("getNextDiffSearchMatchIndex", () => {
  it("wraps next navigation from the last match to the first", () => {
    expect(getNextDiffSearchMatchIndex(2, 3, 1)).toBe(0);
  });

  it("wraps previous navigation from the first match to the last", () => {
    expect(getNextDiffSearchMatchIndex(0, 3, -1)).toBe(2);
  });

  it("returns zero when there are no matches", () => {
    expect(getNextDiffSearchMatchIndex(3, 0, 1)).toBe(0);
  });
});

function matchesFileWithCafePath(): DiffSearchFile[] {
  return [
    {
      name: "b/src/café.ts",
      additionLines: [],
      deletionLines: [],
    },
  ];
}

/** T3 Code's `@@ -20,3 +21,3 @@` fixture, built by hand so this file needs no renderer. */
const numberedHunkFile = {
  name: "src/a.ts",
  additionLines: ["ctx20 name", "add22 names", "ctx22"],
  deletionLines: ["ctx20 name", "del21 Name", "ctx22"],
  hunks: [
    {
      unifiedLineStart: 0,
      splitLineStart: 0,
      additionStart: 21,
      deletionStart: 20,
      hunkContent: [
        { type: "context", lines: 1, additionLineIndex: 0, deletionLineIndex: 0 },
        { type: "change", deletions: 1, deletionLineIndex: 1, additions: 1, additionLineIndex: 1 },
        { type: "context", lines: 1, additionLineIndex: 2, deletionLineIndex: 2 },
      ],
    },
  ],
} satisfies DiffSearchFile;

function lineFile(lines: readonly string[]): DiffSearchFile {
  return { name: "f.ts", additionLines: lines, deletionLines: [] };
}

function search(
  files: readonly DiffSearchFile[],
  query: string,
  options: Partial<DiffSearchOptions> = {},
  limits?: Parameters<typeof searchDiffIndex>[3],
) {
  return searchDiffIndex(
    buildDiffSearchIndex(files, { includePaths: false }),
    query,
    { ...DEFAULT_DIFF_SEARCH_OPTIONS, ...options },
    limits,
  );
}

describe("searchDiffIndex", () => {
  it("keeps match offsets on text whose lowercase form is longer", () => {
    // "İ".toLowerCase() is two code units; offsets from the lowercased copy drift by one.
    const [match] = findDiffSearchMatches([lineFile(["İstanbul name"])], "name");
    expect(match).toMatchObject({ start: 9, end: 13 });
    expect(search([lineFile(["İstanbul NAME"])], "name").matches).toHaveLength(1);
  });

  it("records line numbers and sides", () => {
    expect(search([numberedHunkFile], "Name", { caseSensitive: true }).matches).toEqual([
      expect.objectContaining({ field: "deletion", side: "deletions", lineNumber: 21, start: 6 }),
    ]);
    expect(search([numberedHunkFile], "names").matches).toEqual([
      expect.objectContaining({ field: "addition", side: "additions", lineNumber: 22 }),
    ]);
    expect(search([numberedHunkFile], "ctx").matches).toEqual([
      expect.objectContaining({ field: "context", side: "additions", lineNumber: 21 }),
      expect.objectContaining({ field: "context", side: "additions", lineNumber: 23 }),
    ]);
  });

  it("matches whole words only when asked", () => {
    const lines = ["name", "names", "rename", "a.name()", "my_name", "éname"];
    const hits = search([lineFile(lines)], "name", { wholeWord: true }).matches;
    expect(hits.map((match) => lines[match.lineIndex!])).toEqual(["name", "a.name()", "éname"]);
    expect(search([lineFile(lines)], "name").matches).toHaveLength(lines.length);
    expect(isWholeWordMatch("my_name", 3, 7)).toBe(false);
    expect(isWholeWordMatch("a.name()", 2, 6)).toBe(true);
  });

  it("finds a later whole word after a rejected one on the same line", () => {
    expect(
      search([lineFile(["foo_foo foo"])], "foo", { wholeWord: true }).matches.map(
        (match) => match.start,
      ),
    ).toEqual([8]);
    expect(
      search([lineFile(["foo_foo foo"])], "o+", { regex: true, wholeWord: true }).matches,
    ).toEqual([]);
    expect(
      search([lineFile(["xfoo foo"])], "fo+", { regex: true, wholeWord: true }).matches.map(
        (match) => match.start,
      ),
    ).toEqual([5]);
  });

  it("matches regular expressions", () => {
    const files = [lineFile(["const oldName = oldAlpha;"])];
    expect(
      search(files, "old\\w+", { regex: true }).matches.map((match) => [match.start, match.end]),
    ).toEqual([
      [6, 13],
      [16, 24],
    ]);
    expect(search(files, "OLD\\w+", { regex: true }).matches).toHaveLength(2);
    expect(search(files, "Old", { regex: true, caseSensitive: true }).matches).toEqual([]);
  });

  it("reports an invalid pattern", () => {
    expect(search([lineFile(["("])], "(", { regex: true })).toEqual({
      matches: [],
      truncated: false,
      invalidPattern: true,
      stopped: false,
      searchedFileCount: 0,
    });
    // Without the regex option the same text is literal.
    expect(search([lineFile(["("])], "(").matches).toHaveLength(1);
  });

  it("skips zero-length matches", () => {
    expect(search([lineFile(["aaa", "bbb"])], "a*", { regex: true }).matches).toEqual([
      expect.objectContaining({ start: 0, end: 3 }),
    ]);
    expect(search([lineFile(["aaa", "bbb"])], "^", { regex: true }).matches).toEqual([]);
  });

  it("caps matches and reports truncation", () => {
    const result = search([lineFile(["a".repeat(150_000)])], "a");
    expect(result.matches).toHaveLength(100_000);
    expect(result.truncated).toBe(true);
    // Exactly at the cap is complete.
    const exact = search([lineFile(["a".repeat(10)])], "a", {}, { maxMatches: 10 });
    expect(exact.matches).toHaveLength(10);
    expect(exact.truncated).toBe(false);
    expect(exact.searchedFileCount).toBe(1);
  });

  it("keeps the files a capped or stopped search did not finish in the list", () => {
    const fileList = [
      lineFile(["a a"]),
      lineFile(["b"]),
      lineFile(["a a a"]),
      lineFile(["b"]),
      lineFile(["a"]),
    ];
    // The cap is reached inside the third file: it and the two after it were not searched to the end.
    const capped = search(fileList, "a", {}, { maxMatches: 3 });
    expect(capped.truncated).toBe(true);
    expect(capped.searchedFileCount).toBe(2);
    expect(deriveDiffSearchFileIndexes(capped.matches)).toEqual([0, 2]);
    expect(deriveDiffSearchListedFileIndexes(capped, fileList.length)).toEqual([0, 2, 3, 4]);
    // Exactly at the cap after the first file: the next match is in the third file, unrecorded.
    const atBoundary = search(fileList, "a", {}, { maxMatches: 2 });
    expect(atBoundary.searchedFileCount).toBe(2);
    expect(deriveDiffSearchListedFileIndexes(atBoundary, fileList.length)).toEqual([0, 2, 3, 4]);
    // A complete search lists only the files with a match.
    const complete = search(fileList, "a");
    expect(complete.searchedFileCount).toBe(fileList.length);
    expect(deriveDiffSearchListedFileIndexes(complete, fileList.length)).toEqual([0, 2, 4]);
  });

  it("stops a slow regular expression at its time budget", () => {
    let clock = 0;
    const lines = Array.from({ length: 2_000 }, (_, index) => `line ${index}`);
    const result = search(
      [lineFile(lines)],
      "line",
      { regex: true },
      {
        regexTimeBudgetMs: 100,
        // Every clock read moves 60 ms on: the budget runs out on the second read.
        now: () => (clock += 60),
      },
    );
    expect(result.stopped).toBe(true);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThan(lines.length);
    // The one file was not searched to its end, so a filtered list keeps it.
    expect(result.searchedFileCount).toBe(0);
    expect(deriveDiffSearchListedFileIndexes(result, 1)).toEqual([0]);
    // Plain search has no budget.
    clock = 0;
    expect(
      search([lineFile(lines)], "line", {}, { regexTimeBudgetMs: 100, now: () => (clock += 60) })
        .matches,
    ).toHaveLength(lines.length);
  });

  it("stops within one long line whose matches the whole-word check keeps rejecting", () => {
    let clock = 0;
    // One minified line: every "ab" is inside a longer word, so each rejection searches again.
    const line = "xab ".repeat(5_000);
    const result = search(
      [lineFile([line])],
      "ab",
      { regex: true, wholeWord: true },
      { regexTimeBudgetMs: 100, now: () => (clock += 60) },
    );
    expect(result.stopped).toBe(true);
    expect(result.matches).toEqual([]);
  });

  it("does not trim the query", () => {
    expect(
      search([lineFile(["x foo", "foo"])], " foo").matches.map((match) => [
        match.lineIndex,
        match.start,
      ]),
    ).toEqual([[0, 1]]);
    expect(search([lineFile(["   "])], "   ").matches).toEqual([]);
    expect(search([lineFile(["a\nb"])], "a\nb").matches).toEqual([]);
  });

  it("excludes paths when includePaths is false", () => {
    const withPaths = searchDiffIndex(
      buildDiffSearchIndex(files),
      "alpha",
      DEFAULT_DIFF_SEARCH_OPTIONS,
    );
    const withoutPaths = searchDiffIndex(
      buildDiffSearchIndex(files, { includePaths: false }),
      "alpha",
      DEFAULT_DIFF_SEARCH_OPTIONS,
    );
    expect(withPaths.matches.some((match) => match.field === "path")).toBe(true);
    expect(withoutPaths.matches.map((match) => match.field)).toEqual([
      "addition",
      "deletion",
      "addition",
    ]);
  });

  it("reuses records of an unchanged file object within one search session", () => {
    const alpha: DiffSearchFile = files[0]!;
    const bravo: DiffSearchFile = files[1]!;
    const cache = createDiffSearchRecordCache();
    const first = buildDiffSearchIndex([alpha, bravo], undefined, cache);
    const changed: DiffSearchFile = { ...bravo, additionLines: ["bravo changed"] };
    const second = buildDiffSearchIndex([alpha, changed], undefined, cache);
    expect(second.files[0]).toBe(first.files[0]);
    expect(second.files[1]).not.toBe(first.files[1]);
    // Another index option set is built again, not served from the cache.
    expect(buildDiffSearchIndex([alpha], { includePaths: false }, cache).files[0]).not.toBe(
      first.files[0],
    );
    // Without a cache every build is fresh.
    expect(buildDiffSearchIndex([alpha]).files[0]).not.toBe(first.files[0]);
  });

  it("keys a match by its file, line and offsets", () => {
    const [match] = search([numberedHunkFile], "names").matches;
    const [again] = search([{ ...numberedHunkFile }], "names").matches;
    expect(diffSearchMatchKey(match!, "src/a.ts")).toBe(diffSearchMatchKey(again!, "src/a.ts"));
    expect(diffSearchMatchKey(match!, "src/a.ts")).not.toBe(diffSearchMatchKey(match!, "src/b.ts"));
  });
});
