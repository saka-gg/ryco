import { describe, expect, it } from "vite-plus/test";

import {
  buildSearchSections,
  searchEmptyState,
  searchQueryOf,
  searchScopeChips,
  searchSourcesLive,
  scopesForFilter,
  SEARCH_EVERYTHING_RESULTS_PER_SCOPE,
  type SearchGroup,
  type SearchResult,
  type SearchScope,
} from "./searchModel";

function results(scope: SearchScope, count: number): SearchResult[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${scope}-${index}`,
    scope,
    icon: "bubble.left",
    title: `${scope} ${index}`,
    accessibilityLabel: `${scope} ${index}`,
    open: () => undefined,
  }));
}

const AVAILABLE = new Set<SearchScope>(["chats", "messages"]);

describe("search scopes", () => {
  it("offers Everything and only the scopes a source serves, in order", () => {
    expect(searchScopeChips(AVAILABLE)).toEqual(["everything", "chats", "messages"]);
    expect(searchScopeChips(new Set(["tasks", "chats"]))).toEqual(["everything", "chats", "tasks"]);
  });

  it("searches every available scope under Everything, one under its chip", () => {
    expect([...scopesForFilter("everything", AVAILABLE)]).toEqual(["chats", "messages"]);
    expect([...scopesForFilter("messages", AVAILABLE)]).toEqual(["messages"]);
    expect([...scopesForFilter("tasks", AVAILABLE)]).toEqual([]);
  });

  it("runs nothing for blank text", () => {
    expect(searchQueryOf("   ")).toBeNull();
    expect(searchQueryOf(" redirect ")).toBe("redirect");
  });
});

describe("buildSearchSections", () => {
  const groups: SearchGroup[] = [
    { scope: "messages", results: results("messages", 5), loading: false },
    { scope: "chats", results: results("chats", 2), loading: false },
    { scope: "pullRequests", results: [], loading: false },
    { scope: "tasks", results: [], loading: true },
  ];

  it("lists scopes in order, trims each under Everything and keeps a loading scope", () => {
    const sections = buildSearchSections(groups, "everything");
    expect(
      sections.map((section) => [section.scope, section.results.length, section.hiddenCount]),
    ).toEqual([
      ["chats", 2, 0],
      ["messages", SEARCH_EVERYTHING_RESULTS_PER_SCOPE, 5 - SEARCH_EVERYTHING_RESULTS_PER_SCOPE],
      ["tasks", 0, 0],
    ]);
    expect(sections[1]?.title).toBe("In messages");
  });

  it("lists one scope in full under its chip", () => {
    expect(
      buildSearchSections(groups, "messages").map((section) => [
        section.scope,
        section.results.length,
      ]),
    ).toEqual([["messages", 5]]);
  });
});

describe("searchSourcesLive", () => {
  it("keeps the sources unmounted until the first query, then for the rest of the visit", () => {
    expect(searchSourcesLive(false, null)).toBe(false);
    expect(searchSourcesLive(false, "fix")).toBe(true);
    // Clearing the field keeps them: typing again must not pay their mount twice.
    expect(searchSourcesLive(true, null)).toBe(true);
  });
});

describe("searchEmptyState", () => {
  it("prompts before a query, waits while loading, and says when nothing matched", () => {
    expect(searchEmptyState({ query: null, sections: [] })).toBe("prompt");
    const loading = buildSearchSections(
      [{ scope: "tasks", results: [], loading: true }],
      "everything",
    );
    expect(searchEmptyState({ query: "x", sections: loading })).toBe("searching");
    expect(searchEmptyState({ query: "x", sections: [] })).toBe("no-results");
    const found = buildSearchSections(
      [{ scope: "chats", results: results("chats", 1), loading: false }],
      "everything",
    );
    expect(searchEmptyState({ query: "x", sections: found })).toBeNull();
  });
});
