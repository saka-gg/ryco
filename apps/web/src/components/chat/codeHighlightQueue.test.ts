import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { codeToHtmlMock, getLastGrammarStateMock, getSharedHighlighterMock } = vi.hoisted(() => {
  // A stand-in for Shiki: one span per line, and a grammar state that names the
  // slice's last line, recorded on the root its transformers see.
  const grammarStates = new WeakMap<object, string>();
  const codeToHtmlMock = vi.fn(
    (
      code: string,
      options: {
        lang: string;
        transformers?: ReadonlyArray<{ root?: (node: object) => void }>;
      },
    ) => {
      const lines = code.split("\n");
      const root = { type: "root" };
      for (const transformer of options.transformers ?? []) transformer.root?.(root);
      grammarStates.set(root, `after:${lines.at(-1)}`);
      return `<pre class="shiki" data-lang="${options.lang}"><code>${lines
        .map((line) => `<span class="line">${line}</span>`)
        .join("\n")}</code></pre>`;
    },
  );
  const getLastGrammarStateMock = vi.fn((root: object) => grammarStates.get(root));
  return {
    codeToHtmlMock,
    getLastGrammarStateMock,
    getSharedHighlighterMock: vi.fn(async (input: { langs: ReadonlyArray<string> }) => {
      if (input.langs.includes("not-a-language")) throw new Error("unknown language");
      return { codeToHtml: codeToHtmlMock, getLastGrammarState: getLastGrammarStateMock };
    }),
  };
});

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter: getSharedHighlighterMock,
}));

import {
  createHighlightCacheKey,
  readHighlightedCode,
  requestCodeHighlight,
  resetCodeHighlightQueueForTests,
} from "./codeHighlightQueue";

function job(code: string, language = "ts") {
  return {
    key: createHighlightCacheKey(code, language, "pierre-dark"),
    code,
    language,
    themeName: "pierre-dark" as const,
  };
}

afterEach(() => {
  resetCodeHighlightQueueForTests();
  codeToHtmlMock.mockClear();
  getLastGrammarStateMock.mockClear();
  getSharedHighlighterMock.mockClear();
});

describe("requestCodeHighlight", () => {
  it("highlights off the calling task and caches the result", async () => {
    const onReady = vi.fn();
    const request = job("const a = 1;");

    requestCodeHighlight(request, onReady);
    expect(codeToHtmlMock).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(codeToHtmlMock).toHaveBeenCalledWith("const a = 1;", {
      lang: "ts",
      theme: "pierre-dark",
      // A minified line is not tokenized, like in the diff and file previews.
      tokenizeMaxLineLength: 1_000,
    });
    expect(readHighlightedCode(request.key)).toBe(onReady.mock.calls[0]![0]);

    const cachedListener = vi.fn();
    requestCodeHighlight(request, cachedListener);
    expect(cachedListener).toHaveBeenCalledWith(onReady.mock.calls[0]![0]);
    expect(codeToHtmlMock).toHaveBeenCalledTimes(1);
  });

  it("runs one highlight for identical blocks", async () => {
    const first = vi.fn();
    const second = vi.fn();
    requestCodeHighlight(job("same"), first);
    requestCodeHighlight(job("same"), second);

    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).toHaveBeenCalledTimes(1);
    expect(codeToHtmlMock).toHaveBeenCalledTimes(1);
  });

  it("drops a job whose blocks unmounted before it ran", async () => {
    const onReady = vi.fn();
    const cancel = requestCodeHighlight(job("gone"), onReady);
    cancel();
    const keep = vi.fn();
    requestCodeHighlight(job("kept"), keep);

    await vi.waitFor(() => expect(keep).toHaveBeenCalledTimes(1));
    expect(onReady).not.toHaveBeenCalled();
    expect(codeToHtmlMock).not.toHaveBeenCalledWith("gone", expect.anything());
  });

  it("falls back to plain text for an unsupported language", async () => {
    const onReady = vi.fn();
    requestCodeHighlight(job("x", "not-a-language"), onReady);

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(getSharedHighlighterMock).toHaveBeenCalledWith(
      expect.objectContaining({ langs: ["text"] }),
    );
  });

  it("highlights a large block a slice per step, carrying the grammar state", async () => {
    const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
    const onReady = vi.fn();
    requestCodeHighlight(job(lines.join("\n")), onReady);

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    const slices = codeToHtmlMock.mock.calls.map(([code, options]) => ({
      lines: code.split("\n"),
      grammarState: (options as { grammarState?: unknown }).grammarState,
    }));
    expect(slices.map((slice) => slice.lines.length)).toEqual([100, 100, 50]);
    expect(slices.map((slice) => slice.grammarState)).toEqual([
      undefined,
      "after:line 99",
      "after:line 199",
    ]);
    // The slices join into what one call over the whole block renders.
    expect(onReady).toHaveBeenCalledWith(
      `<pre class="shiki" data-lang="ts"><code>${lines
        .map((line) => `<span class="line">${line}</span>`)
        .join("\n")}</code></pre>`,
    );
  });

  it("bounds a slice by characters as well as lines", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(5_000, "x"));
    const onReady = vi.fn();
    requestCodeHighlight(job(lines.join("\n")), onReady);

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    for (const [code] of codeToHtmlMock.mock.calls) {
      expect(code.length).toBeLessThanOrEqual(16_000);
    }
    expect(codeToHtmlMock.mock.calls.length).toBeGreaterThan(1);
  });
});
