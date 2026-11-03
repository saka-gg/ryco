import type { ProjectEntry } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkspaceFileSearchRows,
  normalizeWorkspaceFileSearchQuery,
  WORKSPACE_FILE_SEARCH_DEBOUNCE_MS,
  WORKSPACE_FILE_SEARCH_LIMIT,
  WORKSPACE_FILE_SEARCH_QUERY_MAX_LENGTH,
  workspacePathMatchRanges,
} from "./search.ts";

function entry(path: string, kind: ProjectEntry["kind"] = "file"): ProjectEntry {
  return { path, kind };
}

describe("workspace file search constants", () => {
  it("stays inside the contract's caps", () => {
    expect(WORKSPACE_FILE_SEARCH_LIMIT).toBe(80);
    expect(WORKSPACE_FILE_SEARCH_LIMIT).toBeLessThanOrEqual(200);
    expect(WORKSPACE_FILE_SEARCH_QUERY_MAX_LENGTH).toBe(256);
    expect(WORKSPACE_FILE_SEARCH_DEBOUNCE_MS).toBe(250);
  });
});

describe("normalizeWorkspaceFileSearchQuery", () => {
  it("trims and treats whitespace-only input as no search", () => {
    expect(normalizeWorkspaceFileSearchQuery("  cn.ts  ")).toBe("cn.ts");
    expect(normalizeWorkspaceFileSearchQuery("")).toBe("");
    expect(normalizeWorkspaceFileSearchQuery("   ")).toBe("");
  });

  it("caps the query and keeps the result trimmed", () => {
    const overlong = "a".repeat(WORKSPACE_FILE_SEARCH_QUERY_MAX_LENGTH + 20);
    expect(normalizeWorkspaceFileSearchQuery(overlong)).toHaveLength(
      WORKSPACE_FILE_SEARCH_QUERY_MAX_LENGTH,
    );

    const cutAtWhitespace = `${"a".repeat(WORKSPACE_FILE_SEARCH_QUERY_MAX_LENGTH - 1)} tail`;
    expect(normalizeWorkspaceFileSearchQuery(cutAtWhitespace)).toBe(
      "a".repeat(WORKSPACE_FILE_SEARCH_QUERY_MAX_LENGTH - 1),
    );
  });
});

describe("buildWorkspaceFileSearchRows", () => {
  it("keeps the node's ranking and derives the display parts", () => {
    const rows = buildWorkspaceFileSearchRows([
      entry("src/lib/cn.ts"),
      entry("cn.ts"),
      entry("src/lib", "directory"),
    ]);

    expect(rows).toEqual([
      { path: "src/lib/cn.ts", name: "cn.ts", parentPath: "src/lib", kind: "file" },
      { path: "cn.ts", name: "cn.ts", parentPath: null, kind: "file" },
      { path: "src/lib", name: "lib", parentPath: "src", kind: "directory" },
    ]);
  });

  it("drops unnormalizable paths and duplicate keys", () => {
    const rows = buildWorkspaceFileSearchRows([
      entry("../outside.ts"),
      entry("./src/a.ts"),
      entry("src/a.ts"),
      entry("/etc/passwd"),
    ]);

    expect(rows.map((row) => row.path)).toEqual(["src/a.ts"]);
  });
});

describe("workspacePathMatchRanges", () => {
  const marked = (path: string, query: string) =>
    workspacePathMatchRanges(path, query).map((range) => path.slice(range.start, range.end));

  it("marks a contiguous match in the name before one in the folders", () => {
    expect(workspacePathMatchRanges("panel/src/PreviewPanel.tsx", "pan")).toEqual([
      { start: 17, end: 20 },
    ]);
    expect(marked("src/Button/index.ts", "button")).toEqual(["Button"]);
  });

  it("prefers the path's start, then a folder boundary, for a match beyond the name", () => {
    expect(workspacePathMatchRanges("src/lib/cn.ts", "src/l")).toEqual([{ start: 0, end: 5 }]);
    expect(workspacePathMatchRanges("app/subsrc/src/a.ts", "src/")).toEqual([
      { start: 11, end: 15 },
    ]);
  });

  it("falls back to a subsequence of the name, then of the path, merging adjacent characters", () => {
    expect(marked("src/components/PreviewPanel.tsx", "prevpan")).toEqual(["Prev", "Pan"]);
    expect(marked("apps/web/main.ts", "awm")).toEqual(["a", "w", "m"]);
  });

  it("normalizes the query like the node's ranking", () => {
    expect(marked("src/lib/cn.ts", "  @./CN ")).toEqual(["cn"]);
  });

  it("marks nothing for an empty query or a path the query does not match", () => {
    expect(workspacePathMatchRanges("src/a.ts", "")).toEqual([]);
    expect(workspacePathMatchRanges("src/a.ts", "zz")).toEqual([]);
  });
});
