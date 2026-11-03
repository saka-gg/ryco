import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  diffFileReference,
  diffLineSelection,
  fileContentsReference,
  fileLineSelection,
  fileLineSelectionRange,
  mapDiffLineAcrossSides,
} from "./fileReferenceSelection";

// Two hunks: line 11 of the old side becomes 11-12 of the new one, then a
// collapsed stretch, then one more removed line (old 40 → gone).
const PATCH = [
  "diff --git a/src/rail.ts b/src/rail.ts",
  "index 1111111..2222222 100644",
  "--- a/src/rail.ts",
  "+++ b/src/rail.ts",
  "@@ -10,4 +10,5 @@ export function rail() {",
  "   const a = 1;",
  "-  const b = 2;",
  "+  const b = 3;",
  "+  const c = 4;",
  "   return a + b;",
  " }",
  "@@ -39,3 +40,2 @@",
  " // tail",
  "-const unused = 0;",
  " export {};",
  "",
].join("\n");

function parsedFile() {
  const file = parsePatchFiles(PATCH, "test").flatMap((patch) => patch.files)[0];
  if (!file) throw new Error("patch did not parse");
  return file;
}

describe("mapDiffLineAcrossSides", () => {
  it("maps unchanged rows one to one and changed ones to the other side's first line", () => {
    const file = parsedFile();
    expect(mapDiffLineAcrossSides(file, "deletions", 10)).toBe(10);
    expect(mapDiffLineAcrossSides(file, "deletions", 11)).toBe(11);
    expect(mapDiffLineAcrossSides(file, "deletions", 12)).toBe(13);
    // Between hunks (collapsed): offset by the first hunk's extra line.
    expect(mapDiffLineAcrossSides(file, "deletions", 20)).toBe(21);
    // A removed line with nothing added maps to where it was.
    expect(mapDiffLineAcrossSides(file, "deletions", 40)).toBe(41);
    expect(mapDiffLineAcrossSides(file, "deletions", 60)).toBe(60);
    expect(mapDiffLineAcrossSides(file, "additions", 13)).toBe(12);
    expect(mapDiffLineAcrossSides(file, "deletions", 2)).toBe(2);
  });
});

describe("diffLineSelection", () => {
  it("keeps same-side ranges on their side, ordered", () => {
    const file = parsedFile();
    expect(
      diffLineSelection(file, "src/rail.ts", { start: 12, end: 10, side: "additions" }),
    ).toEqual({ path: "src/rail.ts", lineStart: 10, lineEnd: 12, side: "new" });
    expect(
      diffLineSelection(file, "src/rail.ts", { start: 11, end: 11, side: "deletions" }),
    ).toEqual({ path: "src/rail.ts", lineStart: 11, lineEnd: 11, side: "old" });
    // Pierre leaves the side out on a single-sided view; additions are assumed.
    expect(diffLineSelection(file, "src/rail.ts", { start: 3, end: 4 })).toMatchObject({
      side: "new",
    });
  });

  it("turns a range crossing from removed into added lines into new-version lines", () => {
    const file = parsedFile();
    expect(
      diffLineSelection(file, "src/rail.ts", {
        start: 11,
        side: "deletions",
        end: 12,
        endSide: "additions",
      }),
    ).toEqual({ path: "src/rail.ts", lineStart: 11, lineEnd: 12, side: "new" });
  });
});

describe("diffFileReference", () => {
  it("captures the side's text and stops at the first line the patch lacks", () => {
    const file = parsedFile();
    expect(
      diffFileReference({
        fileDiff: file,
        selection: { path: "src/rail.ts", lineStart: 10, lineEnd: 12, side: "new" },
        comment: "Why c?",
      }),
    ).toEqual({
      path: "src/rail.ts",
      lineStart: 10,
      lineEnd: 12,
      side: "new",
      snippet: "  const a = 1;\n  const b = 3;\n  const c = 4;",
      truncated: false,
      comment: "Why c?",
    });
    expect(
      diffFileReference({
        fileDiff: file,
        selection: { path: "src/rail.ts", lineStart: 13, lineEnd: 20, side: "new" },
      }),
    ).toMatchObject({ snippet: "  return a + b;\n}", truncated: true });
    expect(
      diffFileReference({
        fileDiff: file,
        selection: { path: "src/rail.ts", lineStart: 11, lineEnd: 11, side: "old" },
      }),
    ).toMatchObject({ snippet: "  const b = 2;", side: "old", truncated: false });
  });
});

describe("file view selections", () => {
  it("orders the range and reads its lines whatever the line endings", () => {
    const selection = fileLineSelection("README.md", { start: 3, end: 2 });
    expect(selection).toEqual({ path: "README.md", lineStart: 2, lineEnd: 3 });
    expect(fileLineSelectionRange(selection)).toEqual({ start: 2, end: 3 });
    expect(fileContentsReference({ contents: "one\r\ntwo\rthree\nfour", selection })?.snippet).toBe(
      "two\nthree",
    );
    expect(fileLineSelectionRange({ path: "a.ts", lineStart: 1, lineEnd: 2, side: "old" })).toEqual(
      { start: 1, end: 2, side: "deletions", endSide: "deletions" },
    );
  });
});
