import { describe, expect, it } from "vitest";

import {
  checkRingSegments,
  describeCheckCounts,
  shortCheckCounts,
} from "./pullRequestCheckRingModel";
import { pullRequestLabelColor, pullRequestStateGlyph } from "./pullRequestGlyphModel";
import { countPullRequestTabFilters, pullRequestTabListFilters } from "./pullRequestListModel";
import {
  DEFAULT_PULL_REQUEST_TAB_STATE,
  sanitizePullRequestTabState,
  selectPullRequestMachine,
  selectPullRequestRepository,
} from "./pullRequestTabStateModel";

describe("check ring", () => {
  it("draws passed, failed and running arcs in order with gaps between them", () => {
    const segments = checkRingSegments({ total: 10, passed: 7, failed: 1, running: 2 }, 100);
    expect(segments.map((segment) => segment.kind)).toEqual(["passed", "failed", "running"]);
    expect(segments[0]).toMatchObject({ offset: 0 });
    expect(segments[1]?.offset).toBeCloseTo(70);
    expect(segments[2]?.offset).toBeCloseTo(80);
    expect(segments[0]?.length).toBeCloseTo(68.8);
  });

  it("draws one full arc without a gap, and nothing without checks", () => {
    expect(checkRingSegments({ total: 3, passed: 3, failed: 0, running: 0 }, 60)).toEqual([
      { kind: "passed", length: 60, offset: 0 },
    ]);
    expect(checkRingSegments({ total: 0, passed: 0, failed: 0, running: 0 }, 60)).toEqual([]);
  });

  it("says the counts", () => {
    expect(describeCheckCounts({ total: 9, passed: 7, failed: 0, running: 2 })).toBe(
      "7 of 9 checks passed, 2 running",
    );
    expect(shortCheckCounts({ total: 9, passed: 6, failed: 1, running: 2 })).toBe(
      "6 of 9 passed · 1 failing · 2 running",
    );
    expect(shortCheckCounts({ total: 4, passed: 4, failed: 0, running: 0 })).toBe("All 4 passed");
  });
});

describe("glyphs", () => {
  it("reads drafts apart from open pull requests", () => {
    expect(pullRequestStateGlyph({ state: "open", isDraft: true }).tone).toBe("draft");
    expect(pullRequestStateGlyph({ state: "open", isDraft: false }).tone).toBe("open");
    expect(pullRequestStateGlyph({ state: "merged", isDraft: true }).tone).toBe("merged");
  });

  it("accepts host label colours with or without #", () => {
    expect(pullRequestLabelColor("D73A4A")).toBe("#d73a4a");
    expect(pullRequestLabelColor("#0e8a16")).toBe("#0e8a16");
    expect(pullRequestLabelColor("red")).toBeNull();
    expect(pullRequestLabelColor(undefined)).toBeNull();
  });
});

describe("tab filters", () => {
  it("turns the segment into the shared 'only' filter", () => {
    expect(pullRequestTabListFilters({ segment: "mine" })).toEqual({ only: "mine" });
    expect(pullRequestTabListFilters({ segment: "review", q: "  fix " })).toEqual({
      only: "review",
      q: "fix",
    });
    expect(pullRequestTabListFilters({ segment: "all", state: "merged", label: [] })).toEqual({
      state: "merged",
    });
  });

  it("counts the settings off their defaults", () => {
    expect(countPullRequestTabFilters({ segment: "mine", state: "open" })).toBe(0);
    expect(
      countPullRequestTabFilters({
        segment: "all",
        state: "closed",
        sort: "updated",
        label: ["a", "b"],
        failingOnly: true,
        hideDrafts: true,
      }),
    ).toBe(6);
  });
});

describe("tab state", () => {
  it("keeps only what it understands", () => {
    expect(sanitizePullRequestTabState(null)).toEqual(DEFAULT_PULL_REQUEST_TAB_STATE);
    expect(
      sanitizePullRequestTabState({
        repositoryKey: "github.com/acme/app",
        filters: {
          segment: "review",
          state: "bogus",
          sort: "updated",
          label: ["bug", 3, ""],
          failingOnly: true,
          hideDrafts: "yes",
        },
      }),
    ).toEqual({
      environmentId: null,
      repositoryKey: "github.com/acme/app",
      filters: { segment: "review", sort: "updated", label: ["bug"], failingOnly: true },
    });
    expect(sanitizePullRequestTabState({ environmentId: "mini", filters: {} }).environmentId).toBe(
      "mini",
    );
    expect(sanitizePullRequestTabState({ environmentId: 7 }).environmentId).toBeNull();
  });

  it("drops labels when the repository changes", () => {
    const state = {
      environmentId: "mini",
      repositoryKey: "a",
      filters: { segment: "mine" as const, label: ["bug"], hideDrafts: true },
    };
    expect(selectPullRequestRepository(state, "a")).toBe(state);
    expect(selectPullRequestRepository(state, "b")).toEqual({
      environmentId: "mini",
      repositoryKey: "b",
      filters: { segment: "mine", hideDrafts: true },
    });
  });

  it("keeps the repository and drops its labels when the machine changes", () => {
    const state = {
      environmentId: null,
      repositoryKey: "a",
      filters: { segment: "all" as const, label: ["bug"] },
    };
    expect(selectPullRequestMachine(state, null)).toBe(state);
    expect(selectPullRequestMachine(state, "mini")).toEqual({
      environmentId: "mini",
      repositoryKey: "a",
      filters: { segment: "all" },
    });
  });
});
