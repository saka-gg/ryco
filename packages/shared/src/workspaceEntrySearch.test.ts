import { describe, expect, it } from "vite-plus/test";

import { scoreQueryMatch } from "./searchRanking.ts";
import {
  normalizeWorkspaceEntryQuery,
  rankWorkspaceEntries,
  scoreWorkspaceEntry,
  workspaceEntryDepth,
  workspaceEntryParentPath,
  type WorkspaceEntrySearchKey,
} from "./workspaceEntrySearch.ts";

function entry(path: string, kind: "file" | "directory" = "file"): WorkspaceEntrySearchKey {
  return { path, kind, normalizedPath: path.toLowerCase() };
}

const ENTRIES = [
  entry("src", "directory"),
  entry("src/components", "directory"),
  entry("src/components/Composer.tsx"),
  entry("src/components/composePrompt.ts"),
  entry("docs/composition.md"),
  entry("docs", "directory"),
  entry("README.md"),
];

describe("workspaceEntrySearch", () => {
  it("normalizes queries like the server always has", () => {
    expect(normalizeWorkspaceEntryQuery("  @./Src/Comp ")).toBe("src/comp");
    expect(normalizeWorkspaceEntryQuery("   ")).toBe("");
  });

  it("derives depth and parent paths", () => {
    expect(workspaceEntryDepth("a")).toBe(0);
    expect(workspaceEntryDepth("a/b/c.ts")).toBe(2);
    expect(workspaceEntryParentPath("a")).toBeUndefined();
    expect(workspaceEntryParentPath("a/b/c.ts")).toBe("a/b");
  });

  it("ranks the shallowest entries first, directories before files, for an empty query", () => {
    const ranked = rankWorkspaceEntries(ENTRIES, "", 4);
    expect(ranked.entries.map((item) => item.path)).toEqual([
      "docs",
      "src",
      "README.md",
      "src/components",
    ]);
    expect(ranked.matchedCount).toBe(ENTRIES.length);
  });

  it("prefers an exact basename over broader path matches", () => {
    const ranked = rankWorkspaceEntries(
      [entry("docs/composer.tsx-notes.md"), entry("src/components/Composer.tsx")],
      "composer.tsx",
      5,
    );
    expect(ranked.entries[0]?.path).toBe("src/components/Composer.tsx");
  });

  it("scores like the best of the basename and path tiers, skipping the basename on a path miss", () => {
    const bestOfBoth = (candidate: WorkspaceEntrySearchKey, query: string) => {
      const name = candidate.normalizedPath.slice(candidate.normalizedPath.lastIndexOf("/") + 1);
      const scores = [
        scoreQueryMatch({
          value: name,
          query,
          exactBase: 0,
          prefixBase: 2,
          includesBase: 5,
          fuzzyBase: 100,
        }),
        scoreQueryMatch({
          value: candidate.normalizedPath,
          query,
          exactBase: 1,
          prefixBase: 3,
          boundaryBase: 4,
          includesBase: 6,
          fuzzyBase: 200,
          boundaryMarkers: ["/"],
        }),
      ].filter((score): score is number => score !== null);
      return scores.length === 0 ? null : Math.min(...scores);
    };
    for (const candidate of ENTRIES) {
      for (const query of ["comp", "cmp", "readme", "readme.md", "xyz", "src/c", "md"]) {
        expect(scoreWorkspaceEntry(candidate, query)).toBe(bestOfBoth(candidate, query));
      }
    }
  });

  it("counts every match while keeping only the best within the limit", () => {
    const ranked = rankWorkspaceEntries(ENTRIES, "cmp", 1);
    expect(ranked.entries).toHaveLength(1);
    expect(ranked.matchedCount).toBeGreaterThan(1);
  });

  it("does not depend on the order of the input", () => {
    const forward = rankWorkspaceEntries(ENTRIES, "co", 3).entries.map((item) => item.path);
    const reversed = rankWorkspaceEntries(ENTRIES.toReversed(), "co", 3).entries.map(
      (item) => item.path,
    );
    expect(reversed).toEqual(forward);
  });

  it("narrows a complete prefix result to exactly what a full search returns", () => {
    for (const [prefix, query] of [
      ["", "comp"],
      ["c", "comp"],
      ["co", "compo"],
      ["src", "src/comp"],
    ] as const) {
      const complete = rankWorkspaceEntries(ENTRIES, prefix, 100);
      expect(complete.matchedCount).toBeLessThanOrEqual(100);
      const narrowed = rankWorkspaceEntries(complete.entries, query, 3);
      const full = rankWorkspaceEntries(ENTRIES, query, 3);
      expect(narrowed.entries.map((item) => item.path)).toEqual(
        full.entries.map((item) => item.path),
      );
      expect(narrowed.matchedCount).toBe(full.matchedCount);
    }
  });
});
