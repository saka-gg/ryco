import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import typescriptLanguage from "@shikijs/langs/typescript";
import githubLightDefault from "@shikijs/themes/github-light-default";
import { expect, it } from "vite-plus/test";
import { highlightSourceFile } from "./shikiReviewHighlighter";

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
  } finally {
    reference.dispose();
  }
});

it("resets grammar after an oversized plain fallback line", async () => {
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
});
