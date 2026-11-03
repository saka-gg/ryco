import { describe, expect, it } from "vitest";

import { gitDiffPaths } from "./gitDiffPaths.ts";

function segment(...lines: ReadonlyArray<string>): string {
  return lines.join("\n");
}

describe("gitDiffPaths", () => {
  it("reads the path from the ---/+++ headers", () => {
    expect(
      gitDiffPaths(
        segment(
          "diff --git a/src/a.ts b/src/a.ts",
          "index 1111111..2222222 100644",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ),
      ),
    ).toEqual({ name: "src/a.ts" });
  });

  it("names added and deleted files by their surviving side", () => {
    expect(
      gitDiffPaths(segment("diff --git a/n.ts b/n.ts", "--- /dev/null", "+++ b/n.ts", "@@")),
    ).toEqual({ name: "n.ts" });
    expect(
      gitDiffPaths(segment("diff --git a/d.ts b/d.ts", "--- a/d.ts", "+++ /dev/null", "@@")),
    ).toEqual({ name: "d.ts" });
  });

  it("keeps the previous path of a rename", () => {
    expect(
      gitDiffPaths(segment("diff --git a/old.ts b/new.ts", "--- a/old.ts", "+++ b/new.ts")),
    ).toEqual({ name: "new.ts", prevName: "old.ts" });
    // A pure rename has no ---/+++ headers: the diff --git line decides.
    expect(
      gitDiffPaths(
        segment(
          "diff --git a/old.ts b/new.ts",
          "similarity index 100%",
          "rename from old.ts",
          "rename to new.ts",
        ),
      ),
    ).toEqual({ name: "new.ts", prevName: "old.ts" });
  });

  it("decodes C-quoted paths and the tab after a path with spaces", () => {
    expect(
      gitDiffPaths(
        segment(
          'diff --git "a/caf\\303\\251.md" "b/caf\\303\\251.md"',
          '--- "a/caf\\303\\251.md"',
          '+++ "b/caf\\303\\251.md"',
        ),
      ),
    ).toEqual({ name: "café.md" });
    expect(
      gitDiffPaths(segment("diff --git a/a b.ts b/a b.ts", "--- a/a b.ts\t", "+++ b/a b.ts\t")),
    ).toEqual({ name: "a b.ts" });
  });

  it("refuses headers it cannot resolve without guessing", () => {
    expect(gitDiffPaths("not a diff")).toBeNull();
    expect(gitDiffPaths(segment("diff --git x y", "--- x", "+++ y"))).toBeNull();
  });
});
