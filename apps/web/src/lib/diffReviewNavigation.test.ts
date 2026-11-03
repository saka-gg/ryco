import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import {
  adjacentDiffHunkIndex,
  areAllDiffFilesCollapsed,
  buildDiffHunkAnchors,
  diffPatchTotals,
  DIFF_CHANGE_MARKER_HEIGHT_PX,
  layoutDiffChangeMarkers,
  toggleAllDiffFiles,
} from "./diffReviewNavigation";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,4 +1,4 @@",
  " one",
  "-two",
  "+TWO",
  " three",
  " four",
  "@@ -20,3 +20,5 @@",
  " twenty",
  " twenty-one",
  "+added one",
  "+added two",
  " twenty-two",
  "diff --git a/src/b.ts b/src/b.ts",
  "deleted file mode 100644",
  "index 3333333..0000000",
  "--- a/src/b.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-gone",
  "-also gone",
  "",
].join("\n");

const files = parsePatchFiles(PATCH, "navigation-test")
  .flatMap((patch) => patch.files)
  .map((fileDiff, fileIndex) => ({ fileIndex, fileDiff }));

describe("hunk anchors", () => {
  it("anchors each hunk on its first changed row, deletions first", () => {
    const anchors = buildDiffHunkAnchors(files, "unified");
    expect(
      anchors.map(({ fileIndex, hunkIndex, side, line, kind }) => ({
        fileIndex,
        hunkIndex,
        side,
        line,
        kind,
      })),
    ).toEqual([
      { fileIndex: 0, hunkIndex: 0, side: "deletions", line: 2, kind: "modified" },
      { fileIndex: 0, hunkIndex: 1, side: "additions", line: 22, kind: "added" },
      { fileIndex: 1, hunkIndex: 0, side: "deletions", line: 1, kind: "removed" },
    ]);
    expect(anchors[0]!.offset).toBe(0);
    expect(anchors[1]!.offset).toBeGreaterThan(0);
    expect(anchors[1]!.offset).toBeLessThan(1);
  });

  it("skips folded files", () => {
    expect(
      buildDiffHunkAnchors(files, "split", (fileIndex) => fileIndex === 0).map(
        (anchor) => anchor.fileIndex,
      ),
    ).toEqual([1]);
  });
});

describe("previous and next hunk", () => {
  // Hunks 0 and 1 start at or above the reading line; 2 and 3 below it.
  const isBelow = (index: number) => index >= 2;

  it("steps from the current hunk, the last one at or above the reading line", () => {
    expect(adjacentDiffHunkIndex({ count: 4, direction: 1, cursor: null, isBelow })).toBe(2);
    expect(adjacentDiffHunkIndex({ count: 4, direction: -1, cursor: null, isBelow })).toBe(0);
  });

  it("starts at the first hunk above all of them and stops at both ends", () => {
    const allBelow = () => true;
    const noneBelow = () => false;
    expect(adjacentDiffHunkIndex({ count: 3, direction: 1, cursor: null, isBelow: allBelow })).toBe(
      0,
    );
    expect(
      adjacentDiffHunkIndex({ count: 3, direction: -1, cursor: null, isBelow: allBelow }),
    ).toBeNull();
    expect(
      adjacentDiffHunkIndex({ count: 3, direction: 1, cursor: null, isBelow: noneBelow }),
    ).toBeNull();
    expect(adjacentDiffHunkIndex({ count: 0, direction: 1, cursor: null, isBelow })).toBeNull();
  });

  it("steps from the last revealed hunk while the reader has not scrolled", () => {
    // The last screen: hunk 2 was revealed but cannot reach the reading line.
    expect(adjacentDiffHunkIndex({ count: 4, direction: 1, cursor: 2, isBelow })).toBe(3);
    expect(adjacentDiffHunkIndex({ count: 4, direction: -1, cursor: 2, isBelow })).toBe(1);
    expect(adjacentDiffHunkIndex({ count: 4, direction: 1, cursor: 3, isBelow })).toBeNull();
    // A cursor outside the list (the patch changed) falls back to the reading line.
    expect(adjacentDiffHunkIndex({ count: 4, direction: 1, cursor: 9, isBelow })).toBe(2);
  });

  it("reads the layout logarithmically", () => {
    let reads = 0;
    adjacentDiffHunkIndex({
      count: 1024,
      direction: 1,
      cursor: null,
      isBelow: (index) => {
        reads++;
        return index >= 700;
      },
    });
    expect(reads).toBeLessThanOrEqual(11);
  });
});

describe("scrollbar markers", () => {
  it("scales hunk offsets to the track and merges markers that would overlap", () => {
    const anchors = [
      { kind: "modified" as const },
      { kind: "added" as const },
      { kind: "removed" as const },
      { kind: "added" as const },
    ];
    const offsets = [0, 10, 500, null];
    expect(
      layoutDiffChangeMarkers({
        anchors,
        contentTop: (index) => offsets[index] ?? null,
        scrollHeight: 1000,
        trackHeight: 200,
      }),
    ).toEqual([
      { index: 0, kind: "modified", top: 0 },
      { index: 2, kind: "removed", top: 100 },
    ]);
    expect(
      layoutDiffChangeMarkers({
        anchors,
        contentTop: () => 1000,
        scrollHeight: 1000,
        trackHeight: 200,
      })[0]!.top,
    ).toBe(200 - DIFF_CHANGE_MARKER_HEIGHT_PX);
    expect(
      layoutDiffChangeMarkers({ anchors, contentTop: () => 0, scrollHeight: 0, trackHeight: 200 }),
    ).toEqual([]);
  });
});

describe("totals and collapse all", () => {
  it("sums the patch's files and lines", () => {
    expect(diffPatchTotals(files.map((file) => file.fileDiff))).toEqual({
      files: 2,
      additions: 3,
      deletions: 3,
    });
  });

  it("collapses the listed files, then expands them, keeping files a filter hides", () => {
    const keys = ["a", "b"];
    expect(areAllDiffFilesCollapsed(keys, new Set(["a"]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
    const collapsed = toggleAllDiffFiles(keys, new Set(["a", "hidden"]));
    expect([...collapsed].toSorted()).toEqual(["a", "b", "hidden"]);
    expect(areAllDiffFilesCollapsed(keys, collapsed)).toBe(true);
    expect([...toggleAllDiffFiles(keys, collapsed)]).toEqual(["hidden"]);
  });
});
