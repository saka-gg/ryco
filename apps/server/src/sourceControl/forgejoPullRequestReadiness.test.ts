import { Option } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { ForgejoPullReviewSchema, decodeForgejoEntries } from "./forgejoPullRequestActivity.ts";
import {
  forgejoBaseRepository,
  forgejoCombinedStatus,
  forgejoProtectedBranch,
  forgejoPullRequest,
  forgejoReviews,
} from "./forgejoPullRequestPage.fixtures.ts";
import {
  ForgejoBranchSchema,
  ForgejoCombinedStatusSchema,
  deriveForgejoMergeStateStatus,
  deriveForgejoMergeability,
  deriveForgejoReadiness,
  deriveForgejoReviewDecision,
  deriveForgejoReviewerStates,
  forgejoMergeCapabilities,
  forgejoStatusContextPattern,
  normalizeForgejoCheckRollup,
  type ForgejoBranch,
} from "./forgejoPullRequestReadiness.ts";
import {
  ForgejoPullRequestSchema,
  ForgejoRepositorySchema,
  normalizeForgejoPullRequestRecord,
} from "./forgejoPullRequests.ts";

const [branch] = decodeForgejoEntries(ForgejoBranchSchema, [forgejoProtectedBranch]);
const [status] = decodeForgejoEntries(ForgejoCombinedStatusSchema, [forgejoCombinedStatus]);
const [repository] = decodeForgejoEntries(ForgejoRepositorySchema, [forgejoBaseRepository]);
const [pullRequest] = decodeForgejoEntries(ForgejoPullRequestSchema, [forgejoPullRequest]);
const record = normalizeForgejoPullRequestRecord(pullRequest!);
const reviews = decodeForgejoEntries(ForgejoPullReviewSchema, forgejoReviews);

const unprotected: ForgejoBranch = { name: "main", protected: false, user_can_merge: true };

describe("normalizeForgejoCheckRollup", () => {
  it("maps commit statuses and marks the base branch's required contexts", () => {
    const rollup = normalizeForgejoCheckRollup({ status: status!, branch: branch! });
    expect(
      rollup.map((item) => [
        item.name,
        Option.getOrNull(item.status),
        Option.getOrNull(item.conclusion),
        item.isRequired,
      ]),
    ).toEqual([
      ["ci/build", "completed", "success", true],
      ["lint/eslint", "pending", null, true],
      ["coverage", "completed", "failure", false],
    ]);
    expect(Option.getOrNull(rollup[0]!.url)).toBe("https://ci.example.test/build/71");
    // An empty target URL is no link.
    expect(Option.isNone(rollup[2]!.url)).toBe(true);
  });

  it("lists a required context that has not reported as expected", () => {
    const rollup = normalizeForgejoCheckRollup({
      status: { statuses: [] },
      branch: { ...branch!, status_check_contexts: ["ci/build", "lint/*"] },
    });
    expect(
      rollup.map((item) => [item.name, Option.getOrNull(item.status), item.isRequired]),
    ).toEqual([["ci/build", "expected", true]]);
  });

  it("leaves `isRequired` unset when the branch does not require checks", () => {
    const rollup = normalizeForgejoCheckRollup({ status: status!, branch: unprotected });
    expect(rollup.every((item) => item.isRequired === undefined)).toBe(true);
    expect(normalizeForgejoCheckRollup({ status: null, branch: branch! })).toEqual([]);
  });

  it("matches context globs like Forgejo", () => {
    expect(forgejoStatusContextPattern("lint/*").test("lint/eslint")).toBe(true);
    expect(forgejoStatusContextPattern("ci/*").test("ci/a/b")).toBe(true);
    expect(forgejoStatusContextPattern("ci/build").test("ci/builds")).toBe(false);
    expect(forgejoStatusContextPattern("{ci,cd}/run?").test("cd/run1")).toBe(true);
    expect(forgejoStatusContextPattern("a.b").test("axb")).toBe(false);
  });
});

describe("reviews", () => {
  it("lists requested reviewers, then each reviewer's standing", () => {
    expect(
      deriveForgejoReviewerStates({
        reviews,
        requestedReviewers: ["erin"],
        requestedTeams: ["core"],
      }).map((reviewer) => [reviewer.login, reviewer.kind, reviewer.state]),
    ).toEqual([
      ["erin", "user", "requested"],
      ["core", "team", "requested"],
      ["dave", "user", "commented"],
      ["bob", "user", "approved"],
      ["carol", "user", "dismissed"],
    ]);
  });

  it("keeps a standing approval over a later comment", () => {
    const later = decodeForgejoEntries(ForgejoPullReviewSchema, [
      {
        ...forgejoReviews[0],
        id: 110,
        user: forgejoReviews[1]!.user,
        submitted_at: "2026-03-13T00:00:00Z",
      },
    ]);
    const states = deriveForgejoReviewerStates({
      reviews: [...reviews, ...later],
      requestedReviewers: [],
      requestedTeams: [],
    });
    expect(states.find((reviewer) => reviewer.login === "bob")?.state).toBe("approved");
  });

  it("decides over official, undismissed, fresh verdicts against required approvals", () => {
    expect(deriveForgejoReviewDecision({ reviews, branch: branch! })).toBe("approved");
    expect(
      deriveForgejoReviewDecision({ reviews, branch: { ...branch!, required_approvals: 2 } }),
    ).toBe("review_required");
    const stale = reviews.map((review) =>
      review.id === 102 ? { ...review, stale: true } : review,
    );
    expect(deriveForgejoReviewDecision({ reviews: stale, branch: branch! })).toBe(
      "review_required",
    );
    const blocking = reviews.map((review) =>
      review.id === 103 ? { ...review, dismissed: false } : review,
    );
    expect(deriveForgejoReviewDecision({ reviews: blocking, branch: unprotected })).toBe(
      "changes_requested",
    );
    expect(deriveForgejoReviewDecision({ reviews: [], branch: unprotected })).toBeNull();
  });
});

describe("merge state", () => {
  it("reads mergeability only where Forgejo's flag means conflicts", () => {
    expect(deriveForgejoMergeability(record)).toBe("mergeable");
    expect(deriveForgejoMergeability({ ...record, mergeable: false })).toBe("conflicting");
    // Drafts are never `mergeable` on Forgejo, whatever their conflicts.
    expect(
      deriveForgejoMergeability({ ...record, mergeable: false, isDraft: true }),
    ).toBeUndefined();
    expect(deriveForgejoMergeability({ ...record, state: "merged" })).toBeUndefined();
  });

  it("blocks on unmet branch rules and is unstable on optional failures", () => {
    const rollup = normalizeForgejoCheckRollup({ status: status!, branch: branch! });
    expect(
      deriveForgejoMergeStateStatus({
        record,
        branch: branch!,
        checkRollup: rollup,
        reviewDecision: "approved",
      }),
    ).toBe("blocked");
    const settled = normalizeForgejoCheckRollup({
      status: {
        statuses: [
          ...status!.statuses!.filter((entry) => entry.context !== "lint/eslint"),
          { context: "lint/eslint", status: "success" },
        ],
      },
      branch: branch!,
    });
    expect(
      deriveForgejoMergeStateStatus({
        record,
        branch: branch!,
        checkRollup: settled,
        reviewDecision: "approved",
      }),
    ).toBe("unstable");
    expect(
      deriveForgejoMergeStateStatus({
        record,
        branch: branch!,
        checkRollup: settled,
        reviewDecision: "review_required",
      }),
    ).toBe("blocked");
    expect(
      deriveForgejoMergeStateStatus({
        record,
        branch: unprotected,
        checkRollup: [],
        reviewDecision: null,
      }),
    ).toBe("clean");
    expect(
      deriveForgejoMergeStateStatus({
        record: { ...record, isDraft: true },
        branch: unprotected,
        checkRollup: [],
        reviewDecision: null,
      }),
    ).toBe("draft");
    expect(
      deriveForgejoMergeStateStatus({
        record: { ...record, mergeable: false },
        branch: unprotected,
        checkRollup: [],
        reviewDecision: null,
      }),
    ).toBe("dirty");
    // Without the base branch the rules are unknown.
    expect(
      deriveForgejoMergeStateStatus({
        record,
        branch: null,
        checkRollup: [],
        reviewDecision: null,
      }),
    ).toBeUndefined();
  });

  it("maps the repository's merge styles", () => {
    expect(forgejoMergeCapabilities(repository!)).toEqual({
      merge: true,
      squash: false,
      rebase: true,
    });
  });

  it("assembles every fact, leaving out what was not read", () => {
    const facts = deriveForgejoReadiness({
      record,
      reviews,
      status: status!,
      branch: branch!,
      repository: repository!,
    });
    expect(facts).toMatchObject({
      mergeability: "mergeable",
      mergeStateStatus: "blocked",
      reviewDecision: "approved",
      mergeCapabilities: { merge: true, squash: false, rebase: true },
    });
    expect(facts.checkRollup).toHaveLength(3);
    expect(facts.reviewerStates?.[0]).toMatchObject({ login: "erin", state: "requested" });

    const partial = deriveForgejoReadiness({
      record,
      reviews: null,
      status: null,
      branch: null,
      repository: null,
    });
    expect(partial).toEqual({ mergeability: "mergeable" });
  });
});
