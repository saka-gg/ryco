import type { ChangeRequest } from "@ryco/contracts";
import { SourceControlProviderError } from "@ryco/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { describe, expect, it } from "vitest";

import {
  derivePullRequestListScreen,
  pullRequestListReadInputs,
  type PullRequestListRead,
} from "./pullRequestListModel";

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

const read = (data: ReadonlyArray<ChangeRequest> | null, error: unknown = null) =>
  ({ data, error, isLoading: data === null && error === null }) satisfies PullRequestListRead;

const GITHUB = { kind: "github" } as const;

describe("pullRequestListReadInputs", () => {
  it("reads the involvement lists with the state list, before the host is known", () => {
    const inputs = pullRequestListReadInputs({
      checkoutKnown: true,
      provider: null,
      filters: { state: "merged" },
    });
    expect(inputs.state).toEqual({ state: "merged", limit: 100, enabled: true });
    expect(inputs.authored).toEqual({
      state: "merged",
      involvement: "authored",
      limit: 100,
      enabled: true,
    });
    expect(inputs.reviewRequested.involvement).toBe("review-requested");
  });

  it("reads nothing without a checkout, and no involvement where the host has none", () => {
    const none = pullRequestListReadInputs({ checkoutKnown: false, provider: null, filters: {} });
    expect([none.state.enabled, none.authored.enabled]).toEqual([false, false]);
    const unknownHost = pullRequestListReadInputs({
      checkoutKnown: true,
      provider: { kind: "unknown" },
      filters: {},
    });
    expect(unknownHost.state).toEqual({ state: "open", limit: 100, enabled: true });
    expect(unknownHost.authored.enabled).toBe(false);
  });
});

describe("derivePullRequestListScreen", () => {
  const stateList = [
    row(1, { author: "me", additions: 12, deletions: 3 }),
    row(2, { isDraft: true }),
    row(3, { reviewDecision: "approved", mergeStateStatus: "clean", mergeability: "mergeable" }),
  ];

  it("groups by involvement with the shared ranking and readiness labels", () => {
    const screen = derivePullRequestListScreen({
      reads: {
        state: read(stateList),
        authored: read([row(1, { author: "me" })]),
        reviewRequested: read([row(2, { isDraft: true })]),
      },
      provider: GITHUB,
      filters: {},
    });
    expect(screen.status).toBe("ready");
    expect(
      screen.sections.map((section) => [section.title, section.rows.map((r) => r.number)]),
    ).toEqual([
      ["Needs your review", [2]],
      ["Yours", [1]],
      ["Others", [3]],
    ]);
    const [review, yours, others] = screen.sections;
    // The viewer's own rows leave the author out; others name it.
    expect(yours?.rows[0]).toMatchObject({ author: null, diffStat: "+12 −3" });
    expect(review?.rows[0]).toMatchObject({
      author: "someone",
      isDraft: true,
      readinessLabel: "Draft",
    });
    expect(others?.rows[0]).toMatchObject({
      readinessLabel: "Ready to merge",
      readinessTone: "success",
    });
    expect(screen.onlyOptions.map((option) => option.value)).toEqual(["review", "mine", "failing"]);
  });

  it("filters to what the viewer asked for", () => {
    const screen = derivePullRequestListScreen({
      reads: {
        state: read(stateList),
        authored: read([row(1, { author: "me" })]),
        reviewRequested: read([row(2)]),
      },
      provider: GITHUB,
      filters: { only: "mine" },
    });
    expect(screen.sections.flatMap((section) => section.rows.map((r) => r.number))).toEqual([1]);
  });

  it("falls back to one untitled list where the host cannot filter by involvement", () => {
    const screen = derivePullRequestListScreen({
      reads: {
        state: read(stateList),
        authored: read(null, new Error("unsupported")),
        reviewRequested: read(null, new Error("unsupported")),
      },
      provider: GITHUB,
      filters: {},
    });
    expect(screen.sections).toHaveLength(1);
    expect(screen.sections[0]?.title).toBeNull();
    // "Review requested" and "Yours" would always come up empty.
    expect(screen.onlyOptions.map((option) => option.value)).toEqual(["failing"]);
  });

  it("says why the list failed, and keeps the last rows through a rate-limit pause", () => {
    const failed = derivePullRequestListScreen({
      reads: {
        state: read(null, new Error("gh auth login required")),
        authored: read(null),
        reviewRequested: read(null),
      },
      provider: GITHUB,
      filters: {},
    });
    expect(failed.status).toBe("error");
    expect(failed.error).toMatch(/not signed in/u);

    const pause = new SourceControlProviderError({
      provider: "github",
      operation: "listChangeRequests",
      detail: "GitHub requests are paused after a rate limit.",
      reason: "rate-limited",
      retryAt: 1_000_000_300_000,
    });
    const paused = derivePullRequestListScreen({
      reads: { state: read(stateList, pause), authored: read(null), reviewRequested: read(null) },
      provider: GITHUB,
      filters: {},
    });
    expect(paused.status).toBe("ready");
    expect(paused.paused).toBe(true);
  });

  it("is loading until the state read answers, then says what is empty", () => {
    const loading = derivePullRequestListScreen({
      reads: { state: read(null), authored: read(null), reviewRequested: read(null) },
      provider: null,
      filters: {},
    });
    expect(loading.status).toBe("loading");
    const empty = derivePullRequestListScreen({
      reads: { state: read([]), authored: read([]), reviewRequested: read([]) },
      provider: GITHUB,
      filters: { state: "merged" },
    });
    expect(empty).toMatchObject({ status: "empty", emptyTitle: "No merged pull requests" });
    const filtered = derivePullRequestListScreen({
      reads: { state: read([]), authored: read([]), reviewRequested: read([]) },
      provider: GITHUB,
      filters: { only: "failing" },
    });
    expect(filtered.emptyTitle).toBe("No matches");
  });
});

describe("derivePullRequestListScreen rows and items", () => {
  const check = (name: string, conclusion: "SUCCESS" | "FAILURE" | null) =>
    ({
      kind: "check-run",
      name,
      status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
      ...(conclusion !== null ? { conclusion } : {}),
    }) as never;

  it("carries the ring counts, review verdict, labels, stack and conflict on each row", () => {
    const screen = derivePullRequestListScreen({
      reads: {
        state: read([
          row(7, {
            reviewDecision: "changes_requested",
            mergeability: "conflicting",
            labels: [{ name: "a" }, { name: "b", color: "ff0000" }, { name: "c" }],
            checkRollup: [check("lint", "SUCCESS"), check("test", "FAILURE"), check("e2e", null)],
            commentsCount: 4,
          }),
        ]),
        authored: read([]),
        reviewRequested: read([]),
      },
      provider: GITHUB,
      filters: {},
    });
    const item = screen.items.find((entry) => entry.kind === "row");
    expect(item?.kind === "row" ? item.row : null).toMatchObject({
      checkCounts: { total: 3, passed: 1, failed: 1, running: 1 },
      review: "changes-requested",
      labels: [{ name: "a" }, { name: "b", color: "ff0000" }],
      moreLabels: 1,
      conflict: true,
      commentsCount: 4,
      stack: null,
    });
  });

  it("draws a stack as a unit with a foot, and counts each segment's open rows", () => {
    const stack = (number: number, position: number) =>
      row(number, {
        author: "me",
        stackSummary: { number: 1, size: 2, position, baseRefName: "main" },
      });
    const screen = derivePullRequestListScreen({
      reads: {
        state: read([stack(10, 1), stack(11, 2), row(12)]),
        authored: read([stack(10, 1), stack(11, 2)]),
        reviewRequested: read([row(12)]),
      },
      provider: GITHUB,
      filters: {},
    });
    expect(screen.segmentCounts).toEqual({ mine: 2, review: 1, all: 3 });
    expect(
      screen.items.map((item) =>
        item.kind === "row" ? `row:${item.row.number}:${item.spine?.edge ?? "-"}` : item.kind,
      ),
    ).toEqual(["heading", "row:12:-", "heading", "row:11:top", "row:10:bottom", "foot"]);
  });

  it("hides drafts and keeps failing rows only when asked", () => {
    const screen = derivePullRequestListScreen({
      reads: {
        state: read([
          row(1, { isDraft: true }),
          row(2, { checkRollup: [check("test", "FAILURE")] }),
          row(3, { checkRollup: [check("test", "SUCCESS")] }),
        ]),
        authored: read([]),
        reviewRequested: read([]),
      },
      provider: GITHUB,
      filters: {},
      narrow: { failingOnly: true, hideDrafts: true },
    });
    expect(screen.sections.flatMap((section) => section.rows.map((r) => r.number))).toEqual([2]);
  });
});
