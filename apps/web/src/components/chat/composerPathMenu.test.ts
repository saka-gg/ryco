import type { ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isRelatedPathQuery,
  resolveComposerPathMenuEmptyState,
  selectServerListsEmptyPathQuery,
  shouldRequestComposerPathSearch,
} from "./composerPathMenu";

const retry = () => undefined;

describe("selectServerListsEmptyPathQuery", () => {
  const configWith = (capabilities: Record<string, unknown>) =>
    ({ environment: { capabilities } }) as unknown as ServerConfig;

  it("is true only when the live server config advertises it", () => {
    expect(selectServerListsEmptyPathQuery(null)).toBe(false);
    expect(selectServerListsEmptyPathQuery(configWith({}))).toBe(false);
    expect(selectServerListsEmptyPathQuery(configWith({ projectSearchEmptyQuery: false }))).toBe(
      false,
    );
    expect(selectServerListsEmptyPathQuery(configWith({ projectSearchEmptyQuery: true }))).toBe(
      true,
    );
  });
});

describe("shouldRequestComposerPathSearch", () => {
  it("lists a bare @ only on servers that accept an empty query", () => {
    expect(
      shouldRequestComposerPathSearch({
        isPathTrigger: true,
        query: "",
        serverListsEmptyQuery: true,
      }),
    ).toBe(true);
    expect(
      shouldRequestComposerPathSearch({
        isPathTrigger: true,
        query: "",
        serverListsEmptyQuery: false,
      }),
    ).toBe(false);
  });

  it("searches typed queries on every server and nothing outside the path menu", () => {
    expect(
      shouldRequestComposerPathSearch({
        isPathTrigger: true,
        query: "src",
        serverListsEmptyQuery: false,
      }),
    ).toBe(true);
    expect(
      shouldRequestComposerPathSearch({
        isPathTrigger: false,
        query: "src",
        serverListsEmptyQuery: true,
      }),
    ).toBe(false);
  });
});

describe("isRelatedPathQuery", () => {
  it("never lets a typed search stand in for the bare listing or the reverse", () => {
    expect(isRelatedPathQuery(null, "")).toBe(false);
    expect(isRelatedPathQuery("", "")).toBe(true);
    expect(isRelatedPathQuery("ab", "abc")).toBe(true);
    expect(isRelatedPathQuery("ab", "")).toBe(false);
    expect(isRelatedPathQuery("", "a")).toBe(false);
  });
});

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
