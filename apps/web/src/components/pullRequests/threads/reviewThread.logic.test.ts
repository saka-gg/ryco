import { describe, expect, it } from "vite-plus/test";

import {
  commentSnippet,
  diffHunkExcerpt,
  hasSuggestion,
  parseDiffHunk,
  splitSuggestionBlocks,
  suggestionBaseLines,
  threadLocationLabel,
} from "./reviewThread.logic";

const HUNK = [
  "@@ -40,5 +40,6 @@ export function planStackMerge(",
  "   const layers = stackLayers(stack);",
  "-  const target = layers[0];",
  "+  const target = layers.at(-1);",
  "+  if (target?.entry.isDraft) return;",
  "   return target;",
  "\\ No newline at end of file",
].join("\n");

describe("suggestion blocks", () => {
  it("splits prose and suggestions in order", () => {
    expect(
      splitSuggestionBlocks("Use this:\n\n```suggestion\nconst a = 1;\n```\n\nThanks!"),
    ).toEqual([
      { kind: "markdown", text: "Use this:\n" },
      { kind: "suggestion", lines: ["const a = 1;"] },
      { kind: "markdown", text: "\nThanks!" },
    ]);
  });

  it("runs an unterminated block to the end and accepts tilde fences", () => {
    expect(splitSuggestionBlocks("~~~ suggestion\nx\ny")).toEqual([
      { kind: "suggestion", lines: ["x", "y"] },
    ]);
    expect(hasSuggestion("```ts\nnot one\n```")).toBe(false);
  });

  it("keeps an empty suggestion (a deletion)", () => {
    expect(splitSuggestionBlocks("```suggestion\n```")).toEqual([
      { kind: "suggestion", lines: [] },
    ]);
  });
});

describe("hunks", () => {
  it("parses body lines without the header or no-newline marker", () => {
    expect(parseDiffHunk(HUNK).map((line) => line.kind)).toEqual([
      "ctx",
      "del",
      "add",
      "add",
      "ctx",
    ]);
    expect(parseDiffHunk(undefined)).toEqual([]);
  });

  it("excerpts the last lines, ending at the commented line", () => {
    expect(diffHunkExcerpt(HUNK, 2)).toEqual([
      { kind: "add", text: "  if (target?.entry.isDraft) return;" },
      { kind: "ctx", text: "  return target;" },
    ]);
  });

  it("recovers the head lines a suggestion replaces", () => {
    expect(
      suggestionBaseLines({
        diffHunk: HUNK,
        side: "right",
        line: 43,
        startLine: 42,
        originalLine: 43,
        originalStartLine: 42,
      }),
    ).toEqual(["  if (target?.entry.isDraft) return;", "  return target;"]);
    expect(suggestionBaseLines({ diffHunk: HUNK, side: "left", line: 41 })).toBeNull();
  });
});

describe("labels", () => {
  it("names a thread's location", () => {
    const base = { path: "src/a.ts", subjectType: "line" as const };
    expect(threadLocationLabel({ ...base, line: 12 })).toBe("src/a.ts:12");
    expect(threadLocationLabel({ ...base, line: 14, startLine: 12 })).toBe("src/a.ts:12–14");
    expect(threadLocationLabel({ ...base, line: null, originalLine: 9 })).toBe("src/a.ts:9");
    expect(threadLocationLabel({ ...base, subjectType: "file", line: null })).toBe("src/a.ts");
  });

  it("flattens markdown into a one-line snippet", () => {
    expect(commentSnippet("**nit:** use `aria-current` — see [docs](https://x.y)\n\nthanks")).toBe(
      "nit: use aria-current — see docs thanks",
    );
    expect(commentSnippet("a".repeat(200), 10)).toBe(`${"a".repeat(9)}…`);
  });
});
