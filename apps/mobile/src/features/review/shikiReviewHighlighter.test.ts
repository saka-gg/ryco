import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import typescriptLanguage from "@shikijs/langs/typescript";
import githubLightDefault from "@shikijs/themes/github-light-default";
import { beforeEach, expect, it } from "vite-plus/test";
import type { ReviewRenderableFile } from "./reviewModel";
import {
  clearReviewHighlightFileCache,
  getCachedHighlightedReviewFile,
  highlightReviewFile,
  highlightSourceFile,
  streamHighlightReviewFile,
} from "./shikiReviewHighlighter";

function file(key: string, lines: string[], path = "sample.txt"): ReviewRenderableFile {
  return {
    id: key,
    cacheKey: key,
    path,
    previousPath: null,
    changeType: "change",
    additions: lines.length,
    deletions: 0,
    languageHint: null,
    additionLines: lines,
    deletionLines: [],
    rows: [],
  };
}

beforeEach(clearReviewHighlightFileCache);

it("does not retain an oversized result or evict a useful small result for it", async () => {
  const small = file("small", ["hello\n"]);
  const smallResult = await highlightReviewFile(small, "light");
  const large = file("large", ["x".repeat(3 * 1024 * 1024)]);
  expect((await highlightReviewFile(large, "light")).additionLines[0]?.[0]?.content.length).toBe(
    3 * 1024 * 1024,
  );
  expect(getCachedHighlightedReviewFile(large, "light")).toBeNull();
  expect(getCachedHighlightedReviewFile(small, "light")).toBe(smallResult);
});

it("evicts by retained bytes even below the entry count cap", async () => {
  const files = [0, 1, 2].map((key) => file(String(key), ["x".repeat(800_000)]));
  for (const entry of files) await highlightReviewFile(entry, "dark");
  expect(getCachedHighlightedReviewFile(files[0]!, "dark")).toBeNull();
  expect(getCachedHighlightedReviewFile(files[2]!, "dark")).not.toBeNull();
});

it("yields during long highlights and preserves every line through adaptive chunks", async () => {
  const lines = Array.from({ length: 420 }, (_, index) => `const item${index} = ${index};`);
  let yielded = false;
  const timer = setTimeout(() => {
    yielded = true;
  }, 0);
  try {
    const tokens = await highlightSourceFile({
      path: "sample.ts",
      contents: lines.join("\n"),
      theme: "light",
    });
    expect(yielded).toBe(true);
    expect(tokens.map((line) => line.map((token) => token.content).join(""))).toEqual(lines);
    const progress: number[] = [];
    const streamed = await streamHighlightReviewFile(
      file(
        "stream",
        lines.map((line) => `${line}\n`),
        "sample.ts",
      ),
      "light",
      (value) => {
        progress.push(value.highlightedLineCount);
      },
    );
    expect(
      streamed.additionLines.map((line) => line.map((token) => token.content).join("")),
    ).toEqual(lines);
    expect(progress.length).toBe(1);
    expect(progress.at(-1)).toBe(lines.length);
  } finally {
    clearTimeout(timer);
  }
});

it("matches single-pass grammar across adaptive comment and template literal boundaries", async () => {
  const reference = await createHighlighterCore({
    themes: [githubLightDefault],
    langs: [typescriptLanguage],
    engine: createJavaScriptRegexEngine(),
  });
  try {
    const lines = [
      "/*",
      ...Array.from({ length: 34 }, () => "const commented = 1;"),
      "*/",
      "const template = `",
      ...Array.from({ length: 40 }, () => "text ${42} tail"),
      "`;",
      "const after = true;",
    ];
    const expected = reference
      .codeToTokensBase(lines.join("\n"), {
        lang: "typescript",
        theme: "github-light-default",
      })
      .map((line) =>
        line.map((token) => ({
          content: token.content,
          color: token.color ?? null,
          fontStyle: token.fontStyle ?? null,
        })),
      );
    expect(
      await highlightSourceFile({ path: "sample.ts", contents: lines.join("\n"), theme: "light" }),
    ).toEqual(expected);
    const sample = file(
      "multiline",
      lines.map((line) => `${line}\n`),
      "sample.ts",
    );
    expect((await highlightReviewFile(sample, "light")).additionLines).toEqual(expected);
    clearReviewHighlightFileCache();
    expect((await streamHighlightReviewFile(sample, "light", () => {})).additionLines).toEqual(
      expected,
    );
  } finally {
    reference.dispose();
  }
});

it("resets grammar after an oversized plain fallback line in either chunk path", async () => {
  const codeLine = "const after = true;";
  const longLine = `${"x".repeat(1_001)} */`;
  const lines = ["/*", ...Array.from({ length: 17 }, () => "comment text"), longLine, codeLine];
  const expectedLast = (
    await highlightSourceFile({ path: "sample.ts", contents: codeLine, theme: "light" })
  )[0];
  const tokens = await highlightSourceFile({
    path: "sample.ts",
    contents: lines.join("\n"),
    theme: "light",
  });
  expect(tokens.at(-2)).toEqual([{ content: longLine, color: null, fontStyle: null }]);
  expect(tokens.at(-1)).toEqual(expectedLast);
  const streamed = await streamHighlightReviewFile(
    file(
      "long-boundary",
      lines.map((line) => `${line}\n`),
      "sample.ts",
    ),
    "light",
    () => {},
  );
  expect(streamed.additionLines).toEqual(tokens);
});
