import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { codeToHtmlMock, getSharedHighlighterMock } = vi.hoisted(() => {
  const codeToHtmlMock = vi.fn(
    (code: string, options: { lang: string }) =>
      `<pre class="shiki" data-lang="${options.lang}">${code}</pre>`,
  );
  return {
    codeToHtmlMock,
    getSharedHighlighterMock: vi.fn(async (input: { langs: ReadonlyArray<string> }) => {
      if (input.langs.includes("not-a-language")) throw new Error("unknown language");
      return { codeToHtml: codeToHtmlMock };
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
});
