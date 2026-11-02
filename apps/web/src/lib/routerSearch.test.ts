import { PROMPT_LINK_PARAM_KEYS } from "@ryco/shared/promptLinks";
import { describe, expect, it } from "vite-plus/test";

import { parsePullRequestsSearch } from "../components/pullRequests/pullRequestsSearch";
import {
  parseRouterSearch,
  PROMPT_LINK_SEARCH_KEYS,
  stringifyRouterSearch,
  validatePromptLinkSearch,
} from "./routerSearch";

describe("router search", () => {
  it("names the same keys as the prompt link parser", () => {
    expect([...PROMPT_LINK_SEARCH_KEYS]).toEqual([...PROMPT_LINK_PARAM_KEYS]);
  });

  it("reads and writes a prompt link's keys as their text", () => {
    for (const prompt of ["123", '"fix it"', "true", "null", '{"a":1}', "-5", "1e3"]) {
      const query = `?${new URLSearchParams({ prompt, model: "5.5" }).toString()}`;
      const search = validatePromptLinkSearch(parseRouterSearch(query));
      expect(search).toEqual({ prompt, model: "5.5" });
      // The address the router writes back reads the same.
      expect(validatePromptLinkSearch(parseRouterSearch(stringifyRouterSearch(search)))).toEqual(
        search,
      );
    }
  });

  it("keeps the default JSON handling for every other key", () => {
    expect(parseRouterSearch("?line=12&open=true&tab=%22files%22")).toEqual({
      line: 12,
      open: true,
      tab: "files",
    });
    expect(stringifyRouterSearch({ line: 12, label: ["a", "b"], q: "x y" })).toBe(
      "?line=12&label=%5B%22a%22%2C%22b%22%5D&q=x+y",
    );
    expect(stringifyRouterSearch({})).toBe("");
    // The pull requests page shares the `pr` key and still reads its number.
    expect(parsePullRequestsSearch(parseRouterSearch("?pr=12")).pr).toBe(12);
  });
});
