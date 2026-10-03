import type { ChangeRequest } from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  describePullRequestsListError,
  derivePullRequestSelectionThreads,
  derivePullRequestsLayoutMetrics,
  derivePullRequestsList,
  mergeChangeRequestLists,
  pullRequestSelectionRefreshPhase,
} from "./pullRequestsModel.logic";

function row(number: number, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    provider: "github",
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    baseRefName: "main",
    headRefName: `feature-${number}`,
    state: "open",
    updatedAt: Option.some(DateTime.makeUnsafe(Date.UTC(2026, 0, 1, 0, number))),
    author: "someone",
    ...overrides,
  };
}

describe("derivePullRequestsList", () => {
  const stateList = [row(1, { author: "me" }), row(2), row(3, { labels: [{ name: "bug" }] })];

  it("groups by involvement and names the viewer from the authored read", () => {
    const list = derivePullRequestsList({
      stateList,
      authoredList: [row(1, { author: "me" })],
      reviewRequestedList: [row(2)],
      involvementSupported: true,
      search: {},
    });
    expect(list.viewerLogin).toBe("me");
    expect(
      list.groups.map((group) => [group.key, group.entries.map((entry) => entry.number)]),
    ).toEqual([
      ["needs-your-review", [2]],
      ["yours", [1]],
      ["others", [3]],
    ]);
    expect(list.ordered.map((entry) => entry.number)).toEqual([2, 1, 3]);
    expect(list.labels.map((label) => label.name)).toEqual(["bug"]);
  });

  it("applies quick filters and label filters", () => {
    const base = {
      stateList,
      authoredList: [row(1, { author: "me" })],
      reviewRequestedList: [row(2)],
      involvementSupported: true,
    };
    expect(
      derivePullRequestsList({ ...base, search: { only: "mine" } }).ordered.map(
        (entry) => entry.number,
      ),
    ).toEqual([1]);
    expect(
      derivePullRequestsList({ ...base, search: { only: "review" } }).ordered.map(
        (entry) => entry.number,
      ),
    ).toEqual([2]);
    expect(
      derivePullRequestsList({ ...base, search: { label: ["bug"] } }).ordered.map(
        (entry) => entry.number,
      ),
    ).toEqual([3]);
  });

  it("falls back to one group without involvement support", () => {
    const list = derivePullRequestsList({
      stateList,
      authoredList: null,
      reviewRequestedList: null,
      involvementSupported: false,
      search: {},
    });
    expect(list.groups.map((group) => group.key)).toEqual(["others"]);
  });

  it("merges duplicate rows from the parallel reads", () => {
    const merged = mergeChangeRequestLists([row(1)], [row(1, { reviewDecision: "approved" })]);
    expect(merged.size).toBe(1);
    expect(merged.get(1)?.reviewDecision).toBe("approved");
  });

  it("keeps the existing row object when a later read adds nothing", () => {
    const first = row(1);
    const merged = mergeChangeRequestLists([first], [{ ...first }]);
    // Same identity, so memoized list rows skip re-rendering.
    expect(merged.get(1)).toBe(first);
  });
});

describe("pullRequestSelectionRefreshPhase", () => {
  const check = (status: string, conclusion: string | null) => ({
    kind: "check-run" as const,
    name: `job-${status}`,
    status: Option.some(status),
    conclusion: conclusion === null ? Option.none() : Option.some(conclusion),
    url: Option.none(),
    startedAt: Option.none(),
    completedAt: Option.none(),
  });

  it("polls only an open change request whose checks are running (spec §6)", () => {
    const running = row(1, { checkRollup: [check("IN_PROGRESS", null)] } as Partial<ChangeRequest>);
    const green = row(1, {
      checkRollup: [check("COMPLETED", "SUCCESS")],
    } as Partial<ChangeRequest>);
    expect(pullRequestSelectionRefreshPhase({ detail: null, summary: running })).toBe("active");
    // Idle and open: settled (lifecycle, focus and mutations still refresh it).
    expect(pullRequestSelectionRefreshPhase({ detail: null, summary: green })).toBe("settled");
    expect(pullRequestSelectionRefreshPhase({ detail: null, summary: row(1) })).toBe("settled");
    expect(
      pullRequestSelectionRefreshPhase({
        detail: null,
        summary: { ...running, state: "merged" },
      }),
    ).toBe("settled");
  });
});

describe("derivePullRequestSelectionThreads", () => {
  it("returns one shared empty index until activity loads", () => {
    expect(derivePullRequestSelectionThreads(null)).toBe(derivePullRequestSelectionThreads(null));
  });
});

describe("derivePullRequestsLayoutMetrics", () => {
  it("docks the list on wide pages and gives Files the full width", () => {
    const wide = derivePullRequestsLayoutMetrics({
      pageWidth: 1192,
      listWidth: 304,
      listHidden: false,
      hasSelection: true,
      tab: "conversation",
    });
    expect(wide).toMatchObject({
      listVisible: true,
      readerWidth: 887,
      railDocked: true,
      leadingRegion: "list",
    });
    const files = derivePullRequestsLayoutMetrics({
      pageWidth: 1192,
      listWidth: 304,
      listHidden: false,
      hasSelection: true,
      tab: "files",
    });
    expect(files).toMatchObject({ listDocked: false, readerWidth: 1192, leadingRegion: "reader" });
  });

  it("lets the list fill a narrow page with nothing selected", () => {
    expect(
      derivePullRequestsLayoutMetrics({
        pageWidth: 672,
        listWidth: 304,
        listHidden: false,
        hasSelection: false,
        tab: "conversation",
      }),
    ).toMatchObject({
      listDocked: false,
      listFillsPage: true,
      barCompact: false,
      leadingRegion: "list",
    });
  });
});

describe("describePullRequestsListError", () => {
  it("names the next step for common provider failures", () => {
    expect(
      describePullRequestsListError(
        "Source control provider unknown failed in detectProvider: Failed to detect source control provider for /x.",
      ),
    ).toMatch(/Pick another repository/u);
    expect(describePullRequestsListError("API rate limit exceeded")).toMatch(/rate limit/u);
    expect(describePullRequestsListError("Something else")).toBe("Something else");
  });
});
