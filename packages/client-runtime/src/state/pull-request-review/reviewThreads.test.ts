import type { ChangeRequestReviewThread } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import {
  annotationSideToDiffSide,
  diffSideToAnnotationSide,
  indexReviewThreads,
  reviewDraftAnchor,
  reviewThreadAnchor,
  reviewThreadLineAnnotations,
} from "./reviewThreads.ts";

function thread(
  id: string,
  overrides: Partial<ChangeRequestReviewThread> = {},
): ChangeRequestReviewThread {
  return {
    id,
    path: "src/a.ts",
    subjectType: "line",
    side: "right",
    line: 10,
    isResolved: false,
    isOutdated: false,
    viewerCanReply: true,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    comments: [],
    totalComments: 0,
    ...overrides,
  };
}

describe("review thread anchors", () => {
  it("maps diff sides to renderer annotation sides and back", () => {
    expect(diffSideToAnnotationSide("left")).toBe("deletions");
    expect(diffSideToAnnotationSide("right")).toBe("additions");
    expect(annotationSideToDiffSide("deletions")).toBe("left");
    expect(annotationSideToDiffSide("additions")).toBe("right");
  });

  it("anchors current threads on their line and ranges on their start line", () => {
    expect(reviewThreadAnchor(thread("t", { side: "left", line: 4 }))).toEqual({
      side: "deletions",
      lineNumber: 4,
      startLineNumber: null,
      startSide: null,
    });
    expect(reviewThreadAnchor(thread("t", { line: 8, startLine: 5, startSide: "right" }))).toEqual({
      side: "additions",
      lineNumber: 8,
      startLineNumber: 5,
      startSide: "additions",
    });
  });

  it("leaves outdated and unplaced threads off the current diff", () => {
    expect(reviewThreadAnchor(thread("t", { isOutdated: true, originalLine: 3 }))).toBeNull();
    expect(reviewThreadAnchor(thread("t", { line: null, originalLine: 3 }))).toBeNull();
  });

  it("anchors on the original line in original mode", () => {
    expect(
      reviewThreadAnchor(thread("t", { isOutdated: true, line: null, originalLine: 3 }), "original")
        ?.lineNumber,
    ).toBe(3);
    expect(reviewThreadAnchor(thread("t", { line: 7 }), "original")?.lineNumber).toBe(7);
  });

  it("anchors file-level threads above the first hunk", () => {
    expect(reviewThreadAnchor(thread("t", { subjectType: "file", line: null }))).toMatchObject({
      lineNumber: 0,
      side: "additions",
    });
  });
});

describe("indexReviewThreads", () => {
  it("splits anchored and off-diff threads per path and counts unresolved ones", () => {
    const index = indexReviewThreads([
      thread("a", { line: 20 }),
      thread("b", { line: 5, side: "left" }),
      thread("c", { isOutdated: true, isResolved: true }),
      thread("d", { path: "src/b.ts", line: null }),
      thread("e", { line: 5, side: "right" }),
    ]);

    expect(index.anchoredByPath.get("src/a.ts")?.map((entry) => entry.thread.id)).toEqual([
      "b",
      "e",
      "a",
    ]);
    expect(index.offDiff.map((entry) => entry.id)).toEqual(["c", "d"]);
    expect(index.offDiffByPath.get("src/b.ts")?.map((entry) => entry.id)).toEqual(["d"]);
    expect(index.byPath.get("src/a.ts")).toHaveLength(4);
    expect(index.unresolvedCountByPath.get("src/a.ts")).toBe(3);
    expect(index.unresolvedCountByPath.get("src/b.ts")).toBe(1);
    expect(index.unresolvedCount).toBe(4);
  });
});

describe("reviewThreadLineAnnotations", () => {
  it("builds sorted renderer annotations for anchorable threads only", () => {
    const annotations = reviewThreadLineAnnotations(
      [
        thread("late", { line: 30 }),
        thread("gone", { isOutdated: true }),
        thread("early", { line: 2 }),
      ],
      (entry) => ({ threadId: entry.id }),
    );
    expect(annotations).toEqual([
      { side: "additions", lineNumber: 2, metadata: { threadId: "early" } },
      { side: "additions", lineNumber: 30, metadata: { threadId: "late" } },
    ]);
  });
});

describe("reviewDraftAnchor", () => {
  it("anchors draft comments like threads", () => {
    expect(reviewDraftAnchor({ subjectType: "line", side: "left", line: 3 })).toMatchObject({
      side: "deletions",
      lineNumber: 3,
    });
    expect(reviewDraftAnchor({ subjectType: "file" })).toMatchObject({ lineNumber: 0 });
    expect(reviewDraftAnchor({ subjectType: "line" })).toBeNull();
    expect(
      reviewDraftAnchor({ subjectType: "line", line: 9, startLine: 6, side: "right" }),
    ).toMatchObject({ startLineNumber: 6, startSide: "additions" });
  });
});
