import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { codeToHtmlMock, enqueuedChunks, getSharedHighlighterMock, tokensToHtmlMock } = vi.hoisted(
  () => {
    // A stand-in for the highlighters: one token per line, rendered as one span.
    type Token = { content: string; offset: number };
    const lineTokens = (line: string, offset: number): Token[] =>
      line === "" ? [] : [{ content: line, offset }];
    const tokensToHtmlMock = vi.fn(
      (_source: string, result: { tokens: Token[][] }, options: { lang: string }) =>
        `<pre class="diffs" data-lang="${options.lang}"><code>${result.tokens
          .map((line) => `<span class="line">${line.map((token) => token.content).join("")}</span>`)
          .join("\n")}</code></pre>`,
    );
    const codeToTokens = (code: string) => {
      let offset = 0;
      return {
        tokens: code.split("\n").map((line) => {
          const tokens = lineTokens(line, offset);
          offset += line.length + 1;
          return tokens;
        }),
        fg: "#fff",
        bg: "#000",
      };
    };
    const codeToHtmlMock = vi.fn((code: string, options: { lang: string }) =>
      tokensToHtmlMock(code, codeToTokens(code), options),
    );
    // Each tokenizer's chunks; a tokenizer emits a line once its break arrives.
    const enqueuedChunks: string[][] = [];
    const createStreamTokenizer = () => {
      const chunks: string[] = [];
      enqueuedChunks.push(chunks);
      let tail = "";
      let offset = 0;
      return {
        enqueue(chunk: string) {
          chunks.push(chunk);
          const lines = (tail + chunk).split("\n");
          tail = lines.pop()!;
          const stable: Token[] = [];
          for (const line of lines) {
            stable.push(...lineTokens(line, offset), {
              content: "\n",
              offset: offset + line.length,
            });
            offset += line.length + 1;
          }
          return { recall: 0, stable, unstable: lineTokens(tail, offset) };
        },
        close: () => ({ stable: lineTokens(tail, offset) }),
        dispose: vi.fn(),
      };
    };
    return {
      codeToHtmlMock,
      enqueuedChunks,
      tokensToHtmlMock,
      getSharedHighlighterMock: vi.fn(async (input: { langs: ReadonlyArray<string> }) => {
        if (input.langs.includes("not-a-language")) throw new Error("unknown language");
        return {
          name: "highlights",
          codeToHtml: codeToHtmlMock,
          codeToTokens,
          createStreamTokenizer,
        };
      }),
    };
  },
);

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter: getSharedHighlighterMock,
  tokensToHtml: tokensToHtmlMock,
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
  tokensToHtmlMock.mockClear();
  getSharedHighlighterMock.mockClear();
  enqueuedChunks.length = 0;
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

  it("asks for the main thread's highlighter: Highlights where WASM compiles", async () => {
    const onReady = vi.fn();
    requestCodeHighlight(job("const a = 1;"), onReady);

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(getSharedHighlighterMock).toHaveBeenCalledWith(
      expect.objectContaining({ preferredHighlighter: "highlights" }),
    );
  });

  it("highlights a large block a slice per step, carrying the lexer state", async () => {
    const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
    const onReady = vi.fn();
    requestCodeHighlight(job(lines.join("\n")), onReady);

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    // One tokenizer took every slice, each but the last ending in its break.
    expect(enqueuedChunks).toHaveLength(1);
    expect(enqueuedChunks[0]!.map((chunk) => chunk.split("\n").length)).toEqual([101, 101, 50]);
    expect(enqueuedChunks[0]!.join("")).toBe(lines.join("\n"));
    expect(codeToHtmlMock).not.toHaveBeenCalled();
    // The slices join into what one call over the whole block renders.
    expect(onReady).toHaveBeenCalledWith(
      `<pre class="diffs" data-lang="ts"><code>${lines
        .map((line) => `<span class="line">${line}</span>`)
        .join("\n")}</code></pre>`,
    );
  });

  it("bounds a slice by characters as well as lines", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `${index}`.padEnd(5_000, "x"));
    const onReady = vi.fn();
    requestCodeHighlight(job(lines.join("\n")), onReady);

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    for (const chunk of enqueuedChunks[0]!) {
      expect(chunk.length).toBeLessThanOrEqual(16_000);
    }
    expect(enqueuedChunks[0]!.length).toBeGreaterThan(1);
  });

  it("highlights a large ANSI block in one step, since its escapes carry state across lines", async () => {
    const lines = Array.from({ length: 250 }, (_, index) => `line ${index}`);
    const onReady = vi.fn();
    requestCodeHighlight(job(lines.join("\n"), "ansi"), onReady);

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(enqueuedChunks).toEqual([]);
    expect(codeToHtmlMock).toHaveBeenCalledTimes(1);
  });
});
