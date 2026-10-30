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
