import { describe, expect, it } from "vitest";

import {
  availablePullRequestOnlyOptions,
  pullRequestFilterChips,
  togglePullRequestLabelFilter,
} from "./pullRequestListFilters.logic";

describe("availablePullRequestOnlyOptions", () => {
  const values = (input: Parameters<typeof availablePullRequestOnlyOptions>[0]) =>
    availablePullRequestOnlyOptions(input).map((option) => option.value);

  it("offers every filter on a host with involvement reads and check rollups", () => {
    expect(values({ involvementSupported: true, checkRollup: true })).toEqual([
      "review",
      "mine",
      "failing",
    ]);
  });

  it("hides filters that would always come up empty on the host", () => {
    expect(values({ involvementSupported: false, checkRollup: true })).toEqual(["failing"]);
    expect(values({ involvementSupported: false, checkRollup: false })).toEqual([]);
  });
});

describe("pullRequestFilterChips", () => {
  it("shows nothing while every filter is at its default", () => {
    expect(pullRequestFilterChips({})).toEqual([]);
    expect(pullRequestFilterChips({ state: "open", sort: "readiness" })).toEqual([]);
  });

  it("names each filter that is off its default, with a patch that removes only it", () => {
    const chips = pullRequestFilterChips(
      { state: "all", only: "failing", label: ["bug", "web"], sort: "updated" },
      [{ name: "web", color: "1f6feb" }],
    );
    expect(chips.map((chip) => [chip.key, chip.label, chip.clear])).toEqual([
      ["state", "All states", { state: undefined }],
      ["only", "Failing checks", { only: undefined }],
      ["label:bug", "bug", { label: ["web"] }],
      ["label:web", "web", { label: ["bug"] }],
      ["sort", "Recently updated", { sort: undefined }],
    ]);
    expect(chips.find((chip) => chip.key === "label:web")?.color).toBe("1f6feb");
  });

  it("clears the label param when the last label goes", () => {
    expect(pullRequestFilterChips({ label: ["bug"] })[0]?.clear).toEqual({ label: undefined });
  });
});

describe("togglePullRequestLabelFilter", () => {
  it("adds labels in sorted order and drops the param when empty", () => {
    expect(togglePullRequestLabelFilter(undefined, "web")).toEqual(["web"]);
    expect(togglePullRequestLabelFilter(["web"], "bug")).toEqual(["bug", "web"]);
    expect(togglePullRequestLabelFilter(["web"], "web")).toBeUndefined();
  });
});
