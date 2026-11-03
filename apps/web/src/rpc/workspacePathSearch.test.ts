import type { ProjectSearchEntriesResult, ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isRelatedPathQuery,
  rememberOwnPathSearchResult,
  selectPathSearchResults,
  selectServerListsEmptyPathQuery,
  shouldRequestWorkspacePathSearch,
} from "./workspacePathSearch";

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

describe("shouldRequestWorkspacePathSearch", () => {
  it("lists a bare query only on servers that accept an empty query", () => {
    expect(
      shouldRequestWorkspacePathSearch({ enabled: true, query: "", serverListsEmptyQuery: true }),
    ).toBe(true);
    expect(
      shouldRequestWorkspacePathSearch({ enabled: true, query: "", serverListsEmptyQuery: false }),
    ).toBe(false);
  });

  it("searches typed queries on every server and nothing while the picker is closed", () => {
    expect(
      shouldRequestWorkspacePathSearch({
        enabled: true,
        query: "src",
        serverListsEmptyQuery: false,
      }),
    ).toBe(true);
    expect(
      shouldRequestWorkspacePathSearch({
        enabled: false,
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

const resultFor = (path: string): ProjectSearchEntriesResult => ({
  entries: [{ path, kind: "file" }],
  truncated: true,
});

describe("rememberOwnPathSearchResult", () => {
  const pancake = resultFor("src/pancake.ts");

  it("keeps the scope's answer to the query the picker sent", () => {
    expect(
      rememberOwnPathSearchResult(null, {
        scopeKey: "scope",
        requestedQuery: "pan",
        data: pancake,
        dataQuery: "pan",
      }),
    ).toEqual({ scopeKey: "scope", query: "pan", data: pancake });
  });

  it("ignores another picker's answer and a closed picker", () => {
    const own = { scopeKey: "scope", query: "pan", data: pancake };
    const preview = resultFor("src/preview.ts");
    expect(
      rememberOwnPathSearchResult(own, {
        scopeKey: "scope",
        requestedQuery: "pan",
        data: preview,
        dataQuery: "prev",
      }),
    ).toBe(own);
    expect(
      rememberOwnPathSearchResult(own, {
        scopeKey: "scope",
        requestedQuery: null,
        data: preview,
        dataQuery: "prev",
      }),
    ).toBe(own);
  });

  it("returns the same object for an answer it already keeps", () => {
    const own = { scopeKey: "scope", query: "pan", data: pancake };
    expect(
      rememberOwnPathSearchResult(own, {
        scopeKey: "scope",
        requestedQuery: "pan",
        data: pancake,
        dataQuery: "pan",
      }),
    ).toBe(own);
  });
});

describe("selectPathSearchResults", () => {
  const pancake = resultFor("src/pancake.ts");
  const preview = resultFor("src/preview.ts");
  const own = { scopeKey: "scope", query: "pan", data: pancake };

  it("shows the scope's answer to the typed query, whichever picker asked", () => {
    expect(
      selectPathSearchResults({
        scopeKey: "scope",
        data: preview,
        dataQuery: "prev",
        ownResult: own,
        query: "prev",
      }),
    ).toBe(preview);
  });

  it("never lets another picker's answer stand in for the typed query", () => {
    // Quick open searched "prev" on the scope the `@` menu reads for "pan".
    expect(
      selectPathSearchResults({
        scopeKey: "scope",
        data: preview,
        dataQuery: "prev",
        ownResult: own,
        query: "pan",
      }),
    ).toBe(pancake);
    expect(
      selectPathSearchResults({
        scopeKey: "scope",
        data: preview,
        dataQuery: "prev",
        ownResult: null,
        query: "pan",
      }),
    ).toBeNull();
  });

  it("lets the picker's own related results stand in, in their scope only", () => {
    const input = { scopeKey: "scope", data: pancake, dataQuery: "pan", ownResult: own };
    expect(selectPathSearchResults({ ...input, query: "panc" })).toBe(pancake);
    expect(selectPathSearchResults({ ...input, dataQuery: "", query: "panc" })).toBe(pancake);
    expect(selectPathSearchResults({ ...input, dataQuery: null, query: "" })).toBeNull();
    expect(
      selectPathSearchResults({ ...input, scopeKey: "other", dataQuery: null, query: "panc" }),
    ).toBeNull();
  });
});
