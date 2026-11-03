import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDiffThemeName } from "../../lib/diffRendering";
import { getMainThreadSyntaxHighlighter } from "../../lib/syntaxHighlighterType";
import {
  createHighlightCacheKey,
  requestCodeHighlight,
  resetCodeHighlightQueueForTests,
} from "./codeHighlightQueue";

afterEach(() => {
  resetCodeHighlightQueueForTests();
});

async function highlightInQueue(code: string): Promise<HTMLElement> {
  const themeName = resolveDiffThemeName("dark");
  const onReady = vi.fn();
  requestCodeHighlight(
    { key: createHighlightCacheKey(code, "ts", themeName), code, language: "ts", themeName },
    onReady,
  );
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1), { timeout: 10_000 });
  const container = document.createElement("div");
  container.innerHTML = onReady.mock.calls[0]![0] as string;
  return container;
}

function tokenColors(container: HTMLElement): ReadonlySet<string> {
  return new Set(
    [...container.querySelectorAll<HTMLElement>("pre.diffs span[style]")].map(
      (span) => span.style.color,
    ),
  );
}

describe("chat code highlighting in the browser", () => {
  it("highlights on the main thread with Highlights' WASM lexers", async () => {
    expect(getMainThreadSyntaxHighlighter()).toBe("highlights");

    const container = await highlightInQueue(
      "const answer: number = 42;\nexport function value() {\n  return `${answer}`;\n}",
    );

    expect(container.querySelectorAll("pre.diffs span.line")).toHaveLength(4);
    expect(tokenColors(container).size).toBeGreaterThan(2);
  });

  it("highlights a block too large for one step through the stream tokenizer", async () => {
    const unit = ["/**", " * Spans lines.", " */", "export const value = `a", "b`;", ""];
    const code = Array.from({ length: 60 }, () => unit.join("\n")).join("\n");

    const container = await highlightInQueue(code);

    expect(container.querySelectorAll("pre.diffs span.line")).toHaveLength(code.split("\n").length);
    expect(tokenColors(container).size).toBeGreaterThan(2);
  });
});
