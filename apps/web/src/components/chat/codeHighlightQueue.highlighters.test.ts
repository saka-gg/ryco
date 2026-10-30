import { disposeHighlighter, getSharedHighlighter } from "@pierre/diffs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { resolveDiffThemeName } from "../../lib/diffRendering";
import type { SyntaxHighlighterType } from "../../lib/syntaxHighlighterType";
import {
  createHighlightCacheKey,
  requestCodeHighlight,
  resetCodeHighlightQueueForTests,
} from "./codeHighlightQueue";

const mainThread = vi.hoisted(() => ({ highlighter: "highlights" as SyntaxHighlighterType }));

vi.mock("../../lib/syntaxHighlighterType", () => ({
  getMainThreadSyntaxHighlighter: () => mainThread.highlighter,
}));

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

async function expectSlicedMatchesWhole(type: SyntaxHighlighterType, code: string): Promise<void> {
  const themeName = resolveDiffThemeName("dark");
  const highlighter = await getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: ["tsx"],
    preferredHighlighter: type,
  });
  expect(highlighter.name).toBe(type);
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

describe.each(["highlights", "shiki-js"] as const)("sliced highlighting with %s", (type) => {
  beforeAll(async () => {
    // A thread holds one highlighter type at a time.
    await disposeHighlighter();
    mainThread.highlighter = type;
  });

  it("renders a large block exactly like one pass over it", async () => {
    const code = Array.from({ length: 33 }, () => UNIT.join("\n")).join("\n");
    expect(code.split("\n").length).toBeGreaterThan(300);
    await expectSlicedMatchesWhole(type, code);
  });

  it("renders a large CRLF block exactly like one pass over it", async () => {
    const code = Array.from({ length: 33 }, () => UNIT.join("\r\n")).join("\r\n");
    expect(code.split("\r\n").length).toBeGreaterThan(300);
    await expectSlicedMatchesWhole(type, code);
  });
});
