import type { ChangeRequest, SourceControlCheckRollupItem } from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  changeRequestReadinessTier,
  parseChangeRequestSearchQuery,
  rankChangeRequests,
  rankChangeRequestsByMergeReadiness,
  reviewRequestedPredicate,
  scoreChangeRequestMatch,
  searchChangeRequests,
} from "./readiness.ts";

function checks(
  conclusion: "SUCCESS" | "FAILURE" | null,
): ReadonlyArray<SourceControlCheckRollupItem> {
  return [
    {
      kind: "check-run",
      name: "ci",
      status: Option.some(conclusion === null ? "IN_PROGRESS" : "COMPLETED"),
      conclusion: conclusion === null ? Option.none() : Option.some(conclusion),
      url: Option.none(),
      startedAt: Option.none(),
      completedAt: Option.none(),
    },
  ];
}

function cr(number: number, overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    provider: "github",
    number,
    title: `Change ${number}`,
    url: `https://github.com/acme/app/pull/${number}`,
    baseRefName: "main",
    headRefName: `feature/${number}`,
    state: "open",
    updatedAt: Option.some(
      DateTime.makeUnsafe(`2026-01-${String(number % 28 || 1).padStart(2, "0")}T00:00:00Z`),
    ),
    author: "someone",
    checkRollup: checks("SUCCESS"),
    reviewDecision: "review_required",
    ...overrides,
  };
}

describe("changeRequestReadinessTier", () => {
  it("orders green+approved, green, other open, drafts, finished, conflicting", () => {
    expect(changeRequestReadinessTier(cr(1, { reviewDecision: "approved" }))).toBe("ready");
    expect(changeRequestReadinessTier(cr(2))).toBe("green");
    expect(changeRequestReadinessTier(cr(3, { checkRollup: checks("FAILURE") }))).toBe("open");
    expect(changeRequestReadinessTier(cr(4, { checkRollup: checks(null) }))).toBe("open");
    expect(changeRequestReadinessTier(cr(5, { reviewDecision: "changes_requested" }))).toBe("open");
    expect(changeRequestReadinessTier(cr(6, { isDraft: true }))).toBe("draft");
    expect(changeRequestReadinessTier(cr(7, { state: "merged" }))).toBe("finished");
    expect(
      changeRequestReadinessTier(
        cr(8, { mergeability: "conflicting", reviewDecision: "approved" }),
      ),
    ).toBe("conflicting");
  });

  it("treats a change request without checks as green", () => {
    expect(changeRequestReadinessTier(cr(1, { checkRollup: [], reviewDecision: "approved" }))).toBe(
      "ready",
    );
  });
});

describe("rankChangeRequestsByMergeReadiness", () => {
  it("ranks by tier, then measured smaller diffs, then recency", () => {
    const ranked = rankChangeRequestsByMergeReadiness([
      cr(1, { mergeability: "conflicting", reviewDecision: "approved" }),
      cr(2, { isDraft: true }),
      cr(3, { additions: 500, deletions: 10 }),
      cr(4, { additions: 5, deletions: 1 }),
      cr(5),
      cr(6, { reviewDecision: "approved", additions: 900, deletions: 0 }),
      cr(7, { checkRollup: checks("FAILURE") }),
    ]);
    expect(ranked.map((entry) => entry.number)).toEqual([6, 4, 3, 5, 7, 2, 1]);
  });

  it("breaks size ties by most recent update", () => {
    const ranked = rankChangeRequestsByMergeReadiness([
      cr(3, { additions: 10 }),
      cr(9, { additions: 10 }),
    ]);
    expect(ranked.map((entry) => entry.number)).toEqual([9, 3]);
  });
});

describe("rankChangeRequests", () => {
  it("groups needs-your-review, yours (drafts included), and others", () => {
    const groups = rankChangeRequests(
      [
        cr(1, { author: "Octocat", isDraft: true }),
        cr(2, { author: "octocat", reviewDecision: "approved" }),
        cr(3, { author: "alice" }),
        cr(4, { author: "bob" }),
      ],
      "octocat",
      { isReviewRequested: reviewRequestedPredicate([{ number: 3 }]) },
    );
    expect(groups.map((group) => [group.key, group.entries.map((entry) => entry.number)])).toEqual([
      ["needs-your-review", [3]],
      ["yours", [2, 1]],
      ["others", [4]],
    ]);
    expect(groups[0]?.label).toBe("Needs your review");
  });

  it("puts everything in others without a viewer and omits empty groups", () => {
    const groups = rankChangeRequests([cr(1), cr(2)], null);
    expect(groups.map((group) => group.key)).toEqual(["others"]);
  });

  it("filters and orders by relevance while searching", () => {
    const groups = rankChangeRequests(
      [
        cr(1, { title: "Fix login redirect" }),
        cr(2, { title: "Login" }),
        cr(3, { title: "Other" }),
      ],
      null,
      { query: "login" },
    );
    expect(groups[0]?.entries.map((entry) => entry.number)).toEqual([2, 1]);
  });
});

describe("search", () => {
  it("recognizes numbers, #numbers, and pasted change request URLs", () => {
    expect(parseChangeRequestSearchQuery("#123").number).toBe(123);
    expect(parseChangeRequestSearchQuery(" 42 ").number).toBe(42);
    expect(parseChangeRequestSearchQuery("https://github.com/acme/app/pull/77/files").number).toBe(
      77,
    );
    expect(
      parseChangeRequestSearchQuery("https://gitlab.com/acme/app/-/merge_requests/9#note_1").number,
    ).toBe(9);
    expect(
      parseChangeRequestSearchQuery("https://bitbucket.org/acme/app/pull-requests/5").number,
    ).toBe(5);
    expect(
      parseChangeRequestSearchQuery("https://dev.azure.com/o/p/_git/r/pullrequest/31").number,
    ).toBe(31);
    expect(parseChangeRequestSearchQuery("fix the #12 bug")).toMatchObject({
      number: null,
      terms: ["fix", "the", "#12", "bug"],
    });
  });

  it("matches a number exactly and nothing else", () => {
    expect(scoreChangeRequestMatch(cr(12), "#12")).toBe(100);
    expect(scoreChangeRequestMatch(cr(123), "#12")).toBe(0);
  });

  it("matches title, branch, author, and labels, requiring every term", () => {
    const entry = cr(5, {
      title: "Welcome wizard polish",
      headRefName: "feat/onboarding",
      author: "alice",
      labels: [{ name: "ui" }],
    });
    expect(scoreChangeRequestMatch(entry, "wizard welcome")).toBe(70);
    expect(scoreChangeRequestMatch(entry, "onboarding")).toBe(60);
    expect(scoreChangeRequestMatch(entry, "alice")).toBe(50);
    expect(scoreChangeRequestMatch(entry, "ui")).toBe(40);
    expect(scoreChangeRequestMatch(entry, "wizard alice")).toBe(20);
    expect(scoreChangeRequestMatch(entry, "wizard bob")).toBe(0);
  });

  it("returns the list unchanged for a blank query and ranks matches otherwise", () => {
    const list = [cr(1, { title: "Refactor cache" }), cr(2, { title: "cache" })];
    expect(searchChangeRequests(list, "  ")).toBe(list);
    expect(searchChangeRequests(list, "cache").map((entry) => entry.number)).toEqual([2, 1]);
    expect(searchChangeRequests(list, "https://github.com/acme/app/pull/1")).toEqual([list[0]]);
  });
});
