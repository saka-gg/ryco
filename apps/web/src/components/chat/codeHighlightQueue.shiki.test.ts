import { getSharedHighlighter } from "@pierre/diffs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDiffThemeName } from "../../lib/diffRendering";
import {
  createHighlightCacheKey,
  requestCodeHighlight,
  resetCodeHighlightQueueForTests,
} from "./codeHighlightQueue";

afterEach(() => {
  resetCodeHighlightQueueForTests();
});

// Multi-line constructs straddle the 100-line slice boundaries.
const UNIT = [
  "/**",
  " * A block comment that spans",
  " * several lines.",
  " */",
  "export function value(input: number): string {",
  "  const template = `first",
  "second ${input}",
  "third`;",
  "  return template;",
  "}",
  "",
];

async function expectSlicedMatchesWhole(code: string): Promise<void> {
  const themeName = resolveDiffThemeName("dark");
  const highlighter = await getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: ["tsx"],
    preferredHighlighter: "shiki-js",
  });
  const whole = highlighter.codeToHtml(code, {
    lang: "tsx",
    theme: themeName,
    tokenizeMaxLineLength: 1_000,
  });

  const onReady = vi.fn();
  requestCodeHighlight(
    { key: createHighlightCacheKey(code, "tsx", themeName), code, language: "tsx", themeName },
    onReady,
  );

  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  expect(onReady.mock.calls[0]![0]).toBe(whole);
}

describe("sliced highlighting with Shiki", () => {
  it("renders a large block exactly like one pass over it", async () => {
    const code = Array.from({ length: 33 }, () => UNIT.join("\n")).join("\n");
    expect(code.split("\n").length).toBeGreaterThan(300);
    await expectSlicedMatchesWhole(code);
  });

  it("renders a large CRLF block exactly like one pass over it", async () => {
    const code = Array.from({ length: 33 }, () => UNIT.join("\r\n")).join("\r\n");
    expect(code.split("\r\n").length).toBeGreaterThan(300);
    await expectSlicedMatchesWhole(code);
  });
});
