import { describe, expect, it } from "vite-plus/test";

import { indexForgejoDiffLines, lastForgejoDiffHunkLine } from "./forgejoDiffLines.ts";
import {
  forgejoLeftHunk,
  forgejoPullRequestDiff,
  forgejoRightHunk,
} from "./forgejoPullRequestPage.fixtures.ts";

describe("lastForgejoDiffHunkLine", () => {
  it("reads the commented head-side line from the end of the excerpt", () => {
    expect(lastForgejoDiffHunkLine(forgejoRightHunk, "right")).toEqual({
      line: 12,
      text: "  const c = 4;",
    });
    // An added line has no base-side number.
    expect(lastForgejoDiffHunkLine(forgejoRightHunk, "left")).toBeNull();
  });

  it("reads the commented base-side line of a deletion", () => {
    expect(lastForgejoDiffHunkLine(forgejoLeftHunk, "left")).toEqual({
      line: 5,
      text: "legacy();",
    });
    expect(lastForgejoDiffHunkLine(forgejoLeftHunk, "right")).toBeNull();
  });

  it("numbers both sides of a context line", () => {
    const hunk = "@@ -7,2 +9,2 @@\n kept();\n also();";
    expect(lastForgejoDiffHunkLine(hunk, "right")).toEqual({ line: 10, text: "also();" });
    expect(lastForgejoDiffHunkLine(hunk, "left")).toEqual({ line: 8, text: "also();" });
  });

  it("follows an uncut hunk whose header counts the whole hunk", () => {
    // Forgejo returns short hunks whole, keeping the original header.
    const hunk = "@@ -1,9 +1,9 @@ header\n a\n+b";
    expect(lastForgejoDiffHunkLine(hunk, "right")).toEqual({ line: 2, text: "b" });
  });

  it("returns null without a usable excerpt", () => {
    expect(lastForgejoDiffHunkLine("", "right")).toBeNull();
    expect(lastForgejoDiffHunkLine(null, "right")).toBeNull();
    expect(lastForgejoDiffHunkLine("not a hunk", "right")).toBeNull();
  });
});

describe("indexForgejoDiffLines", () => {
  it("indexes every shown line by path, side, and number", () => {
    const index = indexForgejoDiffLines(forgejoPullRequestDiff);
    expect(index.lineText("src/app.ts", "right", 12)).toBe("  const c = 4;");
    expect(index.lineText("src/app.ts", "right", 13)).toBe("  const d = 5;");
    expect(index.lineText("src/app.ts", "left", 11)).toBe("  const b = 2;");
    expect(index.lineText("src/app.ts", "left", 10)).toBe("  const a = 1;");
    expect(index.lineText("src/setup.ts", "left", 5)).toBe("legacy();");
    expect(index.lineText("src/setup.ts", "right", 5)).toBe("modern();");
    expect(index.lineText("src/setup.ts", "right", 6)).toBeNull();
    expect(index.lineText("missing.ts", "right", 1)).toBeNull();
  });

  it("keeps deleted files under their old path and new files under their new one", () => {
    const index = indexForgejoDiffLines(
      [
        "diff --git a/gone.ts b/gone.ts",
        "deleted file mode 100644",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-bye",
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1,2 @@",
        "+hello",
        "+",
      ].join("\n"),
    );
    expect(index.lineText("gone.ts", "left", 1)).toBe("bye");
    expect(index.lineText("new.ts", "right", 1)).toBe("hello");
    expect(index.lineText("new.ts", "right", 2)).toBe("");
  });

  it("treats a stripped empty context line as context", () => {
    const index = indexForgejoDiffLines(
      ["--- a/x.ts", "+++ b/x.ts", "@@ -1,3 +1,3 @@", " a", "", "-b", "+c"].join("\n"),
    );
    expect(index.lineText("x.ts", "right", 2)).toBe("");
    expect(index.lineText("x.ts", "right", 3)).toBe("c");
    expect(index.lineText("x.ts", "left", 3)).toBe("b");
  });
});
