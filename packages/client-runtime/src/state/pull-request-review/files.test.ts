import { describe, expect, it } from "vitest";

import {
  adjacentFilePath,
  buildReviewFileTree,
  fileAtHeadUrl,
  filterFilePaths,
  flattenReviewFileTree,
  isOversizedDiffError,
  reviewFileTreePaths,
  splitFilePath,
} from "./files.ts";

describe("files", () => {
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
