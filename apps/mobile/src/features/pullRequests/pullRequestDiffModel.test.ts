import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildPullRequestFileView,
  describePullRequestDiffPresentation,
  formatPullRequestDiffStat,
  parsePullRequestDiffRows,
  pullRequestDiffRowTokens,
  pullRequestDiffSides,
  PULL_REQUEST_DIFF_EXCERPT_ROWS,
  pullRequestDiffRowMarker,
  pullRequestTokenSpans,
  splitPullRequestPatch,
} from "./pullRequestDiffModel";

const lines = (...parts: ReadonlyArray<string>) => parts.join("\n");

const MODIFIED = lines(
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
  "@@ -40,2 +41,2 @@",
  "-old tail",
  "+new tail",
  "\\ No newline at end of file",
);

const ADDED_TEST = lines(
  "diff --git a/src/rail.test.ts b/src/rail.test.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/rail.test.ts",
  "@@ -0,0 +1,2 @@",
  "+import { rail } from './rail';",
  "+test('rail', () => rail());",
);

const DELETED_DOC = lines(
  "diff --git a/docs/old.md b/docs/old.md",
  "deleted file mode 100644",
  "--- a/docs/old.md",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-# Old",
);

const RENAMED = lines(
  "diff --git a/src/a.ts b/src/b.ts",
  "similarity index 100%",
  "rename from src/a.ts",
  "rename to src/b.ts",
);

const BINARY = lines(
  "diff --git a/assets/logo.png b/assets/logo.png",
  "index 4444444..5555555 100644",
  "Binary files a/assets/logo.png and b/assets/logo.png differ",
);

describe("splitPullRequestPatch", () => {
  it("reads each file's status and stats, in the web's reading order", () => {
    const files = splitPullRequestPatch(
      `${[DELETED_DOC, BINARY, ADDED_TEST, MODIFIED, RENAMED].join("\n")}\n`,
    );
    // Source by path, a test after its source, then docs.
    expect(files.map((file) => [file.path, file.status])).toEqual([
      ["assets/logo.png", "modified"],
      ["src/b.ts", "renamed"],
      ["src/rail.ts", "modified"],
      ["src/rail.test.ts", "added"],
      ["docs/old.md", "deleted"],
    ]);
    const rail = files.find((file) => file.path === "src/rail.ts");
    expect(rail).toMatchObject({ additions: 3, deletions: 2, binary: false, previousPath: null });
    expect(rail?.patch.startsWith("diff --git a/src/rail.ts")).toBe(true);
    expect(rail?.patch.endsWith("\\ No newline at end of file")).toBe(true);
    expect(files.find((file) => file.path === "src/b.ts")?.previousPath).toBe("src/a.ts");
    expect(files.find((file) => file.path === "assets/logo.png")?.binary).toBe(true);
  });

  it("returns no files for an empty or non-git patch", () => {
    expect(splitPullRequestPatch("")).toEqual([]);
    expect(splitPullRequestPatch("just text\n")).toEqual([]);
  });

  it("keeps a file whose header paths cannot be resolved, named by its raw header", () => {
    const [file] = splitPullRequestPatch(lines("diff --git x y", "--- x", "+++ y", "@@ -1 +1 @@"));
    expect(file?.path).toBe("x y");
  });

  it("keeps no patch of its own: the bounded cache is the only place a diff lives", () => {
    // A module-level copy of the last patch (megabytes of the node's source)
    // would outlive the node's teardown, a Storage clear and the cache's
    // eviction, and Storage would not count it.
    const source = readFileSync(new URL("./pullRequestDiffModel.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^(?:let|var) /mu);
  });

  it("accepts CRLF patches", () => {
    const [file] = splitPullRequestPatch(MODIFIED.replaceAll("\n", "\r\n"));
    expect(file).toMatchObject({ path: "src/rail.ts", additions: 3, deletions: 2 });
  });
});

describe("parsePullRequestDiffRows", () => {
  it("numbers each side from the hunk headers", () => {
    const { rows, truncated, totalRows } = parsePullRequestDiffRows(MODIFIED);
    expect(truncated).toBe(false);
    expect(totalRows).toBe(rows.length);
    expect(rows.map((row) => [row.kind, row.oldLine, row.newLine, row.text])).toEqual([
      ["hunk", null, null, "@@ -10,4 +10,5 @@ export function rail() {"],
      ["context", 10, 10, "  const a = 1;"],
      ["deletion", 11, null, "  const b = 2;"],
      ["addition", null, 11, "  const b = 3;"],
      ["addition", null, 12, "  const c = 4;"],
      ["context", 12, 13, "  return a + b;"],
      ["hunk", null, null, "@@ -40,2 +41,2 @@"],
      ["deletion", 40, null, "old tail"],
      ["addition", null, 41, "new tail"],
      ["notice", null, null, "No newline at end of file"],
    ]);
  });

  it("cuts the rows at the bound but still counts them all", () => {
    const parsed = parsePullRequestDiffRows(MODIFIED, { maxRows: 3 });
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.totalRows).toBe(10);
    expect(parsed.truncated).toBe(true);
    expect(parsed.maxLineLength).toBe("@@ -10,4 +10,5 @@ export function rail() {".length);
  });

  it("has no rows for a binary or pure-rename file", () => {
    expect(parsePullRequestDiffRows(BINARY).rows).toEqual([]);
    expect(parsePullRequestDiffRows(RENAMED).rows).toEqual([]);
  });
});

describe("describePullRequestDiffPresentation", () => {
  it("highlights ordinary files and shows a plain excerpt of very large ones", () => {
    expect(
      describePullRequestDiffPresentation({ binary: false, additions: 10, deletions: 2 }),
    ).toEqual({ kind: "highlighted" });
    expect(
      describePullRequestDiffPresentation({ binary: false, additions: 1400, deletions: 200 }),
    ).toEqual({ kind: "excerpt", maxRows: PULL_REQUEST_DIFF_EXCERPT_ROWS });
    expect(
      describePullRequestDiffPresentation({ binary: true, additions: 0, deletions: 0 }),
    ).toEqual({ kind: "binary" });
  });
});

describe("pullRequestDiffSides", () => {
  it("colours every row from its own side", () => {
    const { rows } = parsePullRequestDiffRows(MODIFIED);
    const sides = pullRequestDiffSides(rows);
    expect(sides.oldLines).toEqual([
      "  const a = 1;",
      "  const b = 2;",
      "  return a + b;",
      "old tail",
    ]);
    expect(sides.newLines).toEqual([
      "  const a = 1;",
      "  const b = 3;",
      "  const c = 4;",
      "  return a + b;",
      "new tail",
    ]);
    const oldTokens = sides.oldLines.map((line) => `old:${line}`);
    const newTokens = sides.newLines.map((line) => `new:${line}`);
    const coloured = sides.sources.map((source) =>
      pullRequestDiffRowTokens(source, oldTokens, newTokens),
    );
    expect(coloured).toEqual([
      null,
      "new:  const a = 1;",
      "old:  const b = 2;",
      "new:  const b = 3;",
      "new:  const c = 4;",
      "new:  return a + b;",
      null,
      "old:old tail",
      "new:new tail",
      null,
    ]);
    // Before the tokens resolve, rows render plain.
    expect(pullRequestDiffRowTokens(sides.sources[1], null, null)).toBeNull();
  });
});

describe("formatPullRequestDiffStat", () => {
  it("leaves empty sides out", () => {
    expect(formatPullRequestDiffStat(12, 3)).toBe("+12 −3");
    expect(formatPullRequestDiffStat(0, 4)).toBe("−4");
    expect(formatPullRequestDiffStat(0, 0)).toBe("");
  });
});

describe("pullRequestTokenSpans", () => {
  it("keys spans by their offset and reads shiki's font style bits", () => {
    expect(
      pullRequestTokenSpans([
        { content: "const", color: "#f00", fontStyle: 2 },
        { content: " x", color: null, fontStyle: null },
        { content: "// note", color: "#888", fontStyle: 1 },
      ]),
    ).toEqual([
      { key: 0, content: "const", color: "#f00", italic: false, bold: true },
      { key: 5, content: " x", color: null, italic: false, bold: false },
      { key: 7, content: "// note", color: "#888", italic: true, bold: false },
    ]);
  });

  it("marks added and deleted rows", () => {
    expect(
      ["addition", "deletion", "context", "hunk"].map((kind) =>
        pullRequestDiffRowMarker(kind as Parameters<typeof pullRequestDiffRowMarker>[0]),
      ),
    ).toEqual(["+", "\u2212", " ", " "]);
  });
});

describe("buildPullRequestFileView", () => {
  it("highlights an ordinary file from both sides", () => {
    const [file] = splitPullRequestPatch(MODIFIED);
    const view = buildPullRequestFileView(file!);
    expect(view.presentation).toEqual({ kind: "highlighted" });
    expect(view.rows.rows).toHaveLength(10);
    expect(view.sides?.newLines).toHaveLength(5);
  });

  it("shows a very large file as a bounded plain excerpt", () => {
    const body = Array.from({ length: 1600 }, (_, index) => `+line ${index}`);
    const [file] = splitPullRequestPatch(
      lines(
        "diff --git a/big.txt b/big.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/big.txt",
        "@@ -0,0 +1,1600 @@",
        ...body,
      ),
    );
    const view = buildPullRequestFileView(file!);
    expect(view.presentation.kind).toBe("excerpt");
    expect(view.rows.rows).toHaveLength(PULL_REQUEST_DIFF_EXCERPT_ROWS);
    expect(view.rows.totalRows).toBe(1601);
    expect(view.rows.truncated).toBe(true);
    expect(view.sides).toBeNull();
  });
});
