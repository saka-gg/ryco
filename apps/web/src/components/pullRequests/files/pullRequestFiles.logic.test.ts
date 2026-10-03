import { parsePatchFiles } from "@pierre/diffs";
import type { ChangeRequestReviewThread } from "@ryco/contracts";
import type { ReviewDraftComment } from "@ryco/client-runtime/state/pull-request-review";
import { describe, expect, it } from "vite-plus/test";

import {
  adjacentFilePath,
  adjacentThreadStop,
  appendSuggestionBlock,
  buildFileLineAnnotations,
  buildReviewFileTree,
  commitScopedReviewThreads,
  diffLineText,
  fileAtHeadUrl,
  fileDiffStat,
  fileStatusOf,
  filterFilePaths,
  flattenReviewFileTree,
  isOversizedDiffError,
  isSameCommit,
  lineCommentTarget,
  lineCommentTargetLabel,
  lineCommentTargetRange,
  lineCommentTargetTexts,
  nextUnviewedPath,
  pendingReviewCount,
  reviewFileTreePaths,
  splitFilePath,
  suggestionSourceLines,
  unresolvedThreadStops,
  viewedProgress,
  type FileViewedState,
} from "./pullRequestFiles.logic";

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
  "",
].join("\n");

function parsedFile() {
  const file = parsePatchFiles(PATCH, "test").flatMap((patch) => patch.files)[0];
  if (!file) throw new Error("patch did not parse");
  return file;
}

function thread(overrides: Partial<ChangeRequestReviewThread>): ChangeRequestReviewThread {
  return {
    id: "t",
    path: "src/rail.ts",
    subjectType: "line",
    side: "right",
    line: 11,
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

function draft(overrides: Partial<ReviewDraftComment>): ReviewDraftComment {
  return {
    id: "d",
    path: "src/rail.ts",
    subjectType: "line",
    line: 12,
    side: "right",
    body: "nit",
    headSha: "head",
    createdAt: 0,
    ...overrides,
  };
}

describe("files", () => {
  it("reads status and stats from a parsed patch", () => {
    const file = parsedFile();
    expect(fileStatusOf(file)).toBe("modified");
    expect(fileDiffStat(file)).toEqual({ additions: 2, deletions: 1 });
  });

  it("splits a path into its directory and name", () => {
    expect(splitFilePath("apps/web/src/index.css")).toEqual({
      directory: "apps/web/src/",
      name: "index.css",
    });
    expect(splitFilePath("bun.lock")).toEqual({ directory: "", name: "bun.lock" });
  });

  it("links a file at the head commit from the pull request URL", () => {
    expect(fileAtHeadUrl("https://github.com/o/r/pull/7", "abc", "src/a b.ts")).toBe(
      "https://github.com/o/r/blob/abc/src/a%20b.ts",
    );
    expect(fileAtHeadUrl("https://github.com/o/r/pull/7/files", null, "a.ts")).toBeNull();
    expect(fileAtHeadUrl("https://example.com/merge_requests/7", "abc", "a.ts")).toBeNull();
  });
});

describe("comment targets", () => {
  it("anchors a single line or a range to its last line", () => {
    expect(lineCommentTarget("a.ts", { start: 12, end: 12, side: "additions" })).toEqual({
      path: "a.ts",
      line: 12,
      side: "right",
    });
    // A range dragged upward still reads top to bottom.
    expect(lineCommentTarget("a.ts", { start: 14, end: 11, side: "additions" })).toEqual({
      path: "a.ts",
      line: 14,
      side: "right",
      startLine: 11,
      startSide: "right",
    });
    expect(
      lineCommentTarget("a.ts", { start: 11, end: 12, side: "deletions", endSide: "additions" }),
    ).toEqual({ path: "a.ts", line: 12, side: "right", startLine: 11, startSide: "left" });
  });

  it("round-trips a target to a pierre selection and a label", () => {
    const target = lineCommentTarget("a.ts", { start: 10, end: 12, side: "additions" });
    expect(lineCommentTargetRange(target)).toEqual({
      start: 10,
      side: "additions",
      end: 12,
      endSide: "additions",
    });
    expect(lineCommentTargetLabel(target)).toBe("lines 10–12");
    expect(lineCommentTargetLabel({ path: "a.ts", line: 11, side: "left" })).toBe("line L11");
  });
});

describe("line text", () => {
  it("reads lines of a patch-parsed file through its hunks", () => {
    const file = parsedFile();
    expect(diffLineText(file, "additions", 11)).toBe("  const b = 3;");
    expect(diffLineText(file, "deletions", 11)).toBe("  const b = 2;");
    expect(diffLineText(file, "additions", 99)).toBeNull();
  });

  it("collects the head lines a suggestion replaces", () => {
    const file = parsedFile();
    expect(
      suggestionSourceLines(file, { path: "a", line: 12, side: "right", startLine: 11 }),
    ).toEqual(["  const b = 3;", "  const c = 4;"]);
    expect(suggestionSourceLines(file, { path: "a", line: 11, side: "left" })).toBeNull();
    expect(lineCommentTargetTexts(file, { path: "a", line: 11, side: "left" })).toEqual([
      "  const b = 2;",
    ]);
  });

  it("appends a suggestion block after what is already written", () => {
    expect(appendSuggestionBlock("", ["x"])).toBe("```suggestion\nx\n```\n");
    expect(appendSuggestionBlock("Rename:  \n", ["y"])).toBe("Rename:\n\n```suggestion\ny\n```\n");
  });
});

describe("annotations", () => {
  it("groups threads, drafts and the composer under their lines", () => {
    const annotations = buildFileLineAnnotations({
      threads: [
        thread({ id: "a", line: 12 }),
        thread({ id: "b", line: 11, side: "left" }),
        thread({ id: "outdated", line: null, isOutdated: true, originalLine: 11 }),
        thread({ id: "file", subjectType: "file", line: null }),
      ],
      drafts: [draft({ id: "d1", line: 12 }), draft({ id: "old", line: 13, headSha: "older" })],
      headSha: "head",
      composer: { path: "src/rail.ts", line: 12, side: "right" },
    });
    expect(annotations.map((entry) => entry.metadata.key)).toEqual([
      "deletions:11",
      "additions:12",
      "additions:13",
    ]);
    expect(annotations[1]?.metadata.items.map((item) => item.kind)).toEqual([
      "thread",
      "draft",
      "composer",
    ]);
    expect(annotations[2]?.metadata.items[0]).toMatchObject({ kind: "draft", outdated: true });
  });

  it("anchors on the original commit when a commit scope is active", () => {
    const annotations = buildFileLineAnnotations({
      threads: [thread({ id: "o", line: null, isOutdated: true, originalLine: 11 })],
      mode: "original",
    });
    expect(annotations.map((entry) => entry.metadata.key)).toEqual(["additions:11"]);
  });
});

describe("tree", () => {
  const paths = [
    "apps/web/src/components/pullRequests/MergeBox.tsx",
    "apps/web/src/components/pullRequests/StackRail.tsx",
    "apps/web/src/index.css",
    "packages/client-runtime/src/state/stack.ts",
    "apps/web/src/components/pullRequests/stack.test.ts",
    "bun.lock",
  ];

  it("keeps reading order, groups directories where they first appear, and compacts chains", () => {
    const tree = buildReviewFileTree(paths);
    const rows = flattenReviewFileTree(tree).map((row) =>
      row.kind === "directory"
        ? `${"  ".repeat(row.depth)}${row.name}/`
        : `${"  ".repeat(row.depth)}${row.name}`,
    );
    expect(rows).toEqual([
      "apps/web/src/",
      "  components/pullRequests/",
      "    MergeBox.tsx",
      "    StackRail.tsx",
      "    stack.test.ts",
      "  index.css",
      "packages/client-runtime/src/state/",
      "  stack.ts",
      "bun.lock",
    ]);
    expect(reviewFileTreePaths(tree)).toEqual([
      paths[0],
      paths[1],
      paths[4],
      paths[2],
      paths[3],
      paths[5],
    ]);
  });

  it("filters by every term", () => {
    expect(filterFilePaths(paths, "rail tsx")).toEqual([paths[1]]);
    expect(filterFilePaths(paths, "  ")).toBe(paths);
  });

  it("steps between files without wrapping", () => {
    expect(adjacentFilePath(paths, paths[0] ?? null, 1)).toBe(paths[1]);
    expect(adjacentFilePath(paths, paths[0] ?? null, -1)).toBeNull();
    expect(adjacentFilePath(paths, null, -1)).toBe("bun.lock");
  });
});

describe("viewed and threads", () => {
  const paths = ["a", "b", "c"];
  const states = new Map<string, FileViewedState>([
    ["a", "viewed"],
    ["b", "stale"],
  ]);

  it("counts viewed files and finds the next one to read", () => {
    expect(viewedProgress(paths, states)).toEqual({ viewed: 1, total: 3 });
    expect(nextUnviewedPath(paths, states, "a")).toBe("b");
    expect(nextUnviewedPath(paths, new Map([["b", "viewed"]]), "c")).toBe("a");
  });

  it("walks unresolved threads in reading order from where the reader is", () => {
    const anchored = new Map([
      ["a", [{ thread: thread({ id: "a1" }) }, { thread: thread({ id: "a2", isResolved: true }) }]],
      ["c", [{ thread: thread({ id: "c1" }) }]],
    ]);
    const stops = unresolvedThreadStops(paths, anchored);
    expect(stops.map((stop) => stop.threadId)).toEqual(["a1", "c1"]);
    expect(adjacentThreadStop(stops, paths, { threadId: null, path: "b" }, 1)?.threadId).toBe("c1");
    expect(adjacentThreadStop(stops, paths, { threadId: null, path: "b" }, -1)?.threadId).toBe(
      "a1",
    );
    expect(adjacentThreadStop(stops, paths, { threadId: "c1", path: "c" }, 1)?.threadId).toBe("a1");
  });

  it("counts the pending review across local drafts and the host", () => {
    expect(pendingReviewCount([draft({})], { commentsCount: 2 })).toBe(3);
    expect(pendingReviewCount([], null)).toBe(0);
  });
});

describe("oversized diffs", () => {
  it("recognizes the host's size refusals", () => {
    expect(
      isOversizedDiffError(
        "HTTP 406: Sorry, the diff exceeded the maximum number of lines (20000)",
      ),
    ).toBe(true);
    expect(isOversizedDiffError("Pull request changed while loading the diff.")).toBe(false);
    expect(isOversizedDiffError(null)).toBe(false);
  });
});

describe("commit scope", () => {
  const COMMIT = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const OTHER = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  it("names a commit by its full or abbreviated id", () => {
    expect(isSameCommit(COMMIT, COMMIT)).toBe(true);
    expect(isSameCommit(COMMIT, COMMIT.slice(0, 7))).toBe(true);
    expect(isSameCommit(COMMIT.slice(0, 7).toUpperCase(), COMMIT)).toBe(true);
    expect(isSameCommit(COMMIT, COMMIT.slice(0, 4))).toBe(false);
    expect(isSameCommit(COMMIT, OTHER)).toBe(false);
  });

  it("keeps only threads written on the commit, on lines its diff contains", () => {
    const file = parsedFile();
    const threads = [
      // Written on this commit at line 11; the head has since moved it to 40.
      thread({ id: "here", originalCommitOid: COMMIT, originalLine: 11, line: 40 }),
      thread({ id: "other-commit", originalCommitOid: OTHER, originalLine: 11 }),
      thread({ id: "unknown-commit", originalLine: 11 }),
      thread({ id: "outside-hunks", originalCommitOid: COMMIT, originalLine: 120 }),
      thread({ id: "file-level", originalCommitOid: COMMIT, subjectType: "file", line: null }),
      thread({ id: "other-file", path: "src/other.ts", originalCommitOid: COMMIT }),
      thread({
        id: "deleted-line",
        originalCommitOid: COMMIT,
        side: "left",
        line: null,
        originalLine: 11,
        isOutdated: true,
      }),
    ];
    const fileDiffFor = (path: string) => (path === "src/rail.ts" ? file : undefined);
    expect(
      commitScopedReviewThreads(threads, COMMIT, fileDiffFor).map((entry) => entry.id),
    ).toEqual(["here", "file-level", "deleted-line"]);
    expect(
      commitScopedReviewThreads(threads, COMMIT.slice(0, 7), fileDiffFor).map((entry) => entry.id),
    ).toEqual(["here", "file-level", "deleted-line"]);
  });
});
