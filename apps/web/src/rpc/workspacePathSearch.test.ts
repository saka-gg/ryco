import type { ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isRelatedPathQuery,
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
