import { describe, expect, it } from "vite-plus/test";

import {
  buildMatchPreview,
  decodeContentSearchCursor,
  encodeContentSearchCursor,
  makeLiteralMatcher,
} from "./contentSearchText.ts";

const findLines = (
  text: string,
  query: string,
  options: { caseSensitive?: boolean; wholeWord?: boolean } = {},
  maxLines = 100,
) =>
  makeLiteralMatcher(query, {
    caseSensitive: options.caseSensitive ?? false,
    wholeWord: options.wholeWord ?? false,
  })
    .findMatches("notes.txt", text, maxLines)
    .map(({ lineNumber, preview, ranges }) => ({ lineNumber, preview, ranges }));

const highlighted = (text: string, query: string, options?: Parameters<typeof findLines>[2]) =>
  findLines(text, query, options).flatMap((line) =>
    line.ranges.map((range) => line.preview.slice(range.start, range.end)),
  );

describe("makeLiteralMatcher", () => {
  it("numbers matching lines from 1 and keeps each line's ranges", () => {
    expect(findLines("alpha\nneedle one\n\nsecond needle, needle\n", "needle")).toEqual([
      { lineNumber: 2, preview: "needle one", ranges: [{ start: 0, end: 6 }] },
      {
        lineNumber: 4,
        preview: "second needle, needle",
        ranges: [
          { start: 7, end: 13 },
          { start: 15, end: 21 },
        ],
      },
    ]);
  });

  it("splits lines at \\n only and leaves a trailing \\r out of the preview", () => {
    expect(findLines("one\r\ntwo needle\r\n", "needle")).toEqual([
      { lineNumber: 2, preview: "two needle", ranges: [{ start: 4, end: 10 }] },
    ]);
    // A lone \r does not end a line, as in git.
    expect(findLines("a\rneedle", "needle")[0]?.lineNumber).toBe(1);
  });

  it("ignores case unless asked, with Unicode case folding", () => {
    expect(highlighted("Needle NEEDLE needle", "needle")).toEqual(["Needle", "NEEDLE", "needle"]);
    expect(highlighted("Needle NEEDLE needle", "needle", { caseSensitive: true })).toEqual([
      "needle",
    ]);
    expect(highlighted("ÄRGER ärger", "ärger")).toEqual(["ÄRGER", "ärger"]);
  });

  it("treats the query as literal text", () => {
    expect(highlighted("a.b axb (x)+ [y]", "a.b")).toEqual(["a.b"]);
    expect(highlighted("a.b axb (x)+ [y]", "(x)+")).toEqual(["(x)+"]);
    expect(highlighted("path/to\\file", "to\\f")).toEqual(["to\\f"]);
  });

  it("reports non-overlapping hits left to right", () => {
    expect(findLines("aaaaa", "aa")[0]?.ranges).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("uses git's ASCII word characters for whole words", () => {
    expect(highlighted("foo foo_bar barfoo (foo) foo", "foo", { wholeWord: true })).toEqual([
      "foo",
      "foo",
      "foo",
    ]);
    // Non-ASCII letters are boundaries, as in `git grep -w`.
    expect(highlighted("éfoo", "foo", { wholeWord: true })).toEqual(["foo"]);
    // A later whole word on the line is still found after a rejected one.
    expect(findLines("foo_foo foo", "foo", { wholeWord: true })[0]?.ranges).toEqual([
      { start: 8, end: 11 },
    ]);
    expect(findLines("prefoo", "foo", { wholeWord: true })).toEqual([]);
  });

  it("steps over astral characters when a whole word is rejected", () => {
    // The first is glued to a word character; the search resumes on the next code point.
    expect(findLines("x😀😀 😀", "😀", { wholeWord: true })[0]?.ranges).toEqual([
      { start: 3, end: 5 },
      { start: 6, end: 8 },
    ]);
    expect(highlighted("a😀b 😀", "😀")).toEqual(["😀", "😀"]);
  });

  it("caps highlighted ranges per line and matching lines per file", () => {
    const line = "x ".repeat(40);
    expect(findLines(line, "x")[0]?.ranges).toHaveLength(32);
    expect(findLines(`${line}\nx\nx\nx`, "x", {}, 2).map((match) => match.lineNumber)).toEqual([
      1, 2,
    ]);
  });

  it("finds nothing in text without the query", () => {
    expect(findLines("nothing to see\nhere", "needle")).toEqual([]);
  });
});

describe("matchFoundLine", () => {
  const foundLine = (text: string, matchStart: number, cut = { start: false, end: false }) => ({
    lineNumber: 7,
    text,
    matchStart,
    cutStart: cut.start,
    cutEnd: cut.end,
  });
  const matcher = makeLiteralMatcher("needle", { caseSensitive: false, wholeWord: false });

  it("highlights every occurrence on a line git reported", () => {
    expect(matcher.matchFoundLine("a.ts", foundLine("Needle and needle", 0))).toEqual({
      path: "a.ts",
      lineNumber: 7,
      preview: "Needle and needle",
      ranges: [
        { start: 0, end: 6 },
        { start: 11, end: 17 },
      ],
    });
  });

  it("falls back to git's first match where case folding differs", () => {
    // No occurrence by this matcher's folding; git's column still marks the hit.
    expect(matcher.matchFoundLine("a.ts", foundLine("x NEEDLX y", 2)).ranges).toEqual([
      { start: 2, end: 8 },
    ]);
  });

  it("marks the edges git cut off a long line", () => {
    const { preview, ranges } = matcher.matchFoundLine(
      "a.ts",
      foundLine("abc needle def", 4, { start: true, end: true }),
    );
    expect(preview).toBe("…abc needle def…");
    expect(preview.slice(ranges[0]?.start, ranges[0]?.end)).toBe("needle");
  });
});

describe("buildMatchPreview", () => {
  it("keeps a short line whole", () => {
    expect(buildMatchPreview("short line", [{ start: 0, end: 5 }])).toEqual({
      preview: "short line",
      ranges: [{ start: 0, end: 5 }],
    });
  });

  it("cuts a long line to a window around its first match and moves the ranges", () => {
    const line = `${"a".repeat(5_000)}needle${"b".repeat(5_000)}`;
    const { preview, ranges } = buildMatchPreview(line, [
      { start: 5_000, end: 5_006 },
      { start: 9_000, end: 9_006 },
    ]);
    expect(preview.length).toBeLessThanOrEqual(1_024);
    expect(preview.startsWith("…")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    expect(ranges).toEqual([{ start: 121, end: 127 }]);
    expect(preview.slice(121, 127)).toBe("needle");
  });

  it("fills the window at the end of a line and never splits a surrogate pair", () => {
    const atEnd = buildMatchPreview(`${"😀".repeat(1_000)}needle.`, [{ start: 2_000, end: 2_006 }]);
    expect(atEnd.preview.length).toBeLessThanOrEqual(1_024);
    expect(atEnd.preview.endsWith("needle.")).toBe(true);
    expect(atEnd.preview.slice(atEnd.ranges[0]?.start, atEnd.ranges[0]?.end)).toBe("needle");
    expect(atEnd.preview.slice(1)).toMatch(/^😀/);

    const atStart = buildMatchPreview(`needle!${"😀".repeat(1_000)}`, [{ start: 0, end: 6 }]);
    expect(atStart.preview.endsWith("😀…")).toBe(true);
  });

  it("keeps a match at the start of a long line without a leading marker", () => {
    const line = `needle${"b".repeat(5_000)}`;
    const { preview, ranges } = buildMatchPreview(line, [{ start: 0, end: 6 }]);
    expect(preview.startsWith("needle")).toBe(true);
    expect(preview.endsWith("…")).toBe(true);
    expect(ranges).toEqual([{ start: 0, end: 6 }]);
  });
});

describe("content search cursors", () => {
  it("round-trips the path a page ended at and whether to scan the index", () => {
    for (const afterPath of ["", "src/a.ts", "dir with spaces/ü.ts", "v1:odd", "s:odd"]) {
      for (const scanIndex of [false, true]) {
        const cursor = { afterPath, scanIndex };
        expect(decodeContentSearchCursor(encodeContentSearchCursor(cursor))).toEqual(cursor);
      }
    }
  });

  it("rejects a cursor this node did not issue", () => {
    expect(decodeContentSearchCursor("src/a.ts")).toBeNull();
    expect(decodeContentSearchCursor("v2:src/a.ts")).toBeNull();
  });
});
