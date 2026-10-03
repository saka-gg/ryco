import { describe, expect, it } from "vitest";

import {
  parsePullRequestsSearch,
  resolvePullRequestsTab,
  selectPullRequestSearch,
} from "./pullRequestsSearch";

describe("parsePullRequestsSearch", () => {
  it("keeps defaults out of the parsed search", () => {
    expect(parsePullRequestsSearch({ tab: "conversation", state: "open" })).toEqual({});
  });

  it("parses a deep link to a review thread in a commit-scoped diff", () => {
    expect(
      parsePullRequestsSearch({
        env: "env-1",
        project: "project-1",
        pr: "703",
        tab: "files",
        state: "all",
        commit: "ABCDEF1",
        file: "apps/web/src/index.css",
        thread: "PRRT_kwDO",
      }),
    ).toEqual({
      env: "env-1",
      project: "project-1",
      pr: 703,
      tab: "files",
      state: "all",
      commit: "abcdef1",
      file: "apps/web/src/index.css",
      thread: "PRRT_kwDO",
    });
  });

  it("drops invalid values", () => {
    expect(
      parsePullRequestsSearch({
        pr: "-3",
        tab: "nope",
        state: "draft",
        q: "   ",
        commit: "not-a-sha",
      }),
    ).toEqual({});
  });

  it("ignores PR-scoped params without a selected PR", () => {
    expect(parsePullRequestsSearch({ file: "a.ts", commit: "abcdef12", thread: "t" })).toEqual({});
  });

  it("parses list filters and line reveals", () => {
    expect(
      parsePullRequestsSearch({
        only: "review",
        label: ["b", "a", "a"],
        sort: "updated",
        pr: 5,
        file: "x.ts",
        line: "12",
        side: "left",
        job: "123",
      }),
    ).toEqual({
      only: "review",
      label: ["a", "b"],
      sort: "updated",
      pr: 5,
      file: "x.ts",
      line: 12,
      side: "left",
      job: "123",
    });
    expect(
      parsePullRequestsSearch({ sort: "readiness", pr: 5, file: "x", line: 3, side: "right" }),
    ).toEqual({ pr: 5, file: "x", line: 3 });
  });

  it("drops PR-scoped params when switching pull requests", () => {
    expect(
      selectPullRequestSearch(
        { q: "x", only: "mine", pr: 1, tab: "files", file: "a", line: 2, thread: "t", job: "j" },
        2,
      ),
    ).toEqual({ q: "x", only: "mine", pr: 2, tab: "files" });
    expect(selectPullRequestSearch({ pr: 1, tab: "checks" }, undefined)).toEqual({});
  });

  it("accepts numeric pr values from the router", () => {
    expect(parsePullRequestsSearch({ pr: 12 })).toEqual({ pr: 12 });
    expect(resolvePullRequestsTab({ pr: 12 })).toBe("conversation");
  });
});
