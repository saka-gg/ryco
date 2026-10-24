import { describe, expect, it } from "vite-plus/test";

import { resolveComposerPathMenuEmptyState } from "./composerPathMenu";

const retry = () => undefined;

describe("resolveComposerPathMenuEmptyState", () => {
  const base = {
    requestsSearch: true,
    triggerQuery: "",
    hasResults: false,
    error: null,
    partial: false,
    onRetry: retry,
  };

  it("reports a failed bare @ listing with a retry instead of an empty result", () => {
    const state = resolveComposerPathMenuEmptyState({ ...base, error: new Error("git failed") });
    expect(state.errorText).toBe("Couldn't search workspace files.");
    expect(state.onRetry).toBe(retry);
  });

  it("reports a failed typed search with a retry", () => {
    const state = resolveComposerPathMenuEmptyState({
      ...base,
      triggerQuery: "src",
      error: new Error("boom"),
    });
    expect(state.errorText).toBe("Couldn't search workspace files.");
  });

  it("asks for input on a server that cannot list the workspace, ignoring older errors", () => {
    const state = resolveComposerPathMenuEmptyState({
      ...base,
      requestsSearch: false,
      error: new Error("from an earlier query"),
    });
    expect(state.text).toBe("Type to search files and folders.");
    expect(state.errorText).toBeUndefined();
  });

  it("says indexing until the scope has results, then searching", () => {
    expect(resolveComposerPathMenuEmptyState(base).loadingText).toBe("Indexing workspace…");
    expect(resolveComposerPathMenuEmptyState({ ...base, hasResults: true }).loadingText).toBe(
      "Searching workspace files…",
    );
    expect(resolveComposerPathMenuEmptyState(base).text).toBe("No matching files or folders.");
  });

  it("notes results from part of the workspace", () => {
    expect(resolveComposerPathMenuEmptyState({ ...base, partial: true }).footnote).toBe(
      "Showing results from part of the workspace.",
    );
    expect(resolveComposerPathMenuEmptyState(base).footnote).toBeUndefined();
  });
});
