import {
  SourceControlProviderError,
  type ChangeRequestActivity,
  type ChangeRequestReviewThread,
  type SourceControlChangeRequestDetail,
  type SourceControlCheckRollupItem,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  pagedReviewThreadIds,
  pullRequestWatchObservation,
  withReviewThreadTails,
} from "./pullRequestWatchObservation.ts";
import { classifyPullRequestWatchReadFailure } from "./pullRequestWatchSweep.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const rollup = (
  name: string,
  input: {
    readonly conclusion?: string;
    readonly startedAt?: string;
    readonly isRequired?: boolean;
  },
): SourceControlCheckRollupItem => ({
  kind: "check-run",
  name,
  workflowName: "CI",
  status: Option.some(input.conclusion === undefined ? "IN_PROGRESS" : "COMPLETED"),
  conclusion: input.conclusion === undefined ? Option.none() : Option.some(input.conclusion),
  url: Option.some(`https://github.com/o/r/actions/runs/1/job/${name}`),
  startedAt: input.startedAt === undefined ? Option.none() : Option.some(at(input.startedAt)),
  completedAt: Option.none(),
  ...(input.isRequired === undefined ? {} : { isRequired: input.isRequired }),
});

const detail = (
  overrides: Partial<SourceControlChangeRequestDetail> = {},
): SourceControlChangeRequestDetail => ({
  provider: "github",
  number: 12,
  title: "Watch",
  url: "https://github.com/o/r/pull/12",
  baseRefName: "main",
  headRefName: "feature/watch",
  state: "open",
  updatedAt: Option.none(),
  headSha: "abc1234",
  mergeability: "conflicting",
  author: "someone",
  body: "",
  comments: [],
  truncated: false,
  ...overrides,
});

const thread = (
  id: string,
  comments: number,
  totalComments: number,
): ChangeRequestReviewThread => ({
  id,
  path: "src/a.ts",
  subjectType: "line",
  side: "right",
  line: 3,
  isResolved: false,
  isOutdated: false,
  viewerCanReply: true,
  viewerCanResolve: true,
  viewerCanUnresolve: false,
  comments: Array.from({ length: comments }, (_, index) => ({
    id: `${id}-c${index}`,
    author: { login: "reviewer" },
    authorAssociation: "MEMBER",
    body: `Comment ${index}`,
    createdAt: DateTime.makeUnsafe(Date.parse("2026-10-02T12:10:00Z") + index * 60_000),
  })),
  totalComments,
});

const activity = (reviewThreads: ChangeRequestReviewThread[]): ChangeRequestActivity => ({
  provider: "github",
  number: 12,
  headSha: "abc1234",
  viewer: null,
  timeline: [],
  timelineTruncated: false,
  reviewThreads,
  reviewThreadsTruncated: false,
  pendingReview: null,
});

describe("pullRequestWatchObservation", () => {
  it("maps the detail: required flags, re-runs collapsed onto the newest, mergeability", () => {
    const observation = pullRequestWatchObservation({
      detail: detail({
        checkRollup: [
          rollup("test", {
            conclusion: "FAILURE",
            startedAt: "2026-10-02T12:00:00Z",
            isRequired: true,
          }),
          rollup("test", {
            conclusion: "SUCCESS",
            startedAt: "2026-10-02T12:30:00Z",
            isRequired: true,
          }),
          rollup("lint", { isRequired: false }),
        ],
      }),
      activity: null,
      remarksThrough: "2026-10-02T12:00:00.000Z",
      observedAtMs: 42,
    });
    expect(observation.checks.map((check) => [check.label, check.state, check.required])).toEqual([
      ["test", "passed", true],
      ["lint", "pending", false],
    ]);
    expect(observation.requiredKnown).toBe(true);
    expect(observation.mergeability).toBe("conflicting");
    expect(observation.headBranch).toBe("feature/watch");
    expect(observation.authorLogin).toBe("someone");
    expect(observation.observedAtMs).toBe(42);
    // Without an activity read the conversation is unknown: no remark moves.
    expect(observation.remarks).toBeNull();
  });

  it("does not know the gate when GitHub's required-check lookup failed", () => {
    const observation = pullRequestWatchObservation({
      detail: detail({ checkRollup: [rollup("test", { conclusion: "FAILURE" })] }),
      activity: null,
      remarksThrough: "2026-10-02T12:00:00.000Z",
      observedAtMs: 0,
    });
    expect(observation.requiredKnown).toBe(false);
  });

  it("reads remarks only from a conversation read whole", () => {
    const whole = pullRequestWatchObservation({
      detail: detail(),
      activity: activity([thread("t1", 2, 2)]),
      remarksThrough: "2026-10-02T12:00:00.000Z",
      observedAtMs: 0,
    });
    expect(whole.remarks?.map((remark) => remark.id)).toEqual(["t1-c0", "t1-c1"]);
    const paged = pullRequestWatchObservation({
      detail: detail(),
      activity: activity([thread("t1", 2, 40)]),
      remarksThrough: "2026-10-02T12:00:00.000Z",
      observedAtMs: 0,
    });
    expect(paged.remarks).toBeNull();
  });
});

describe("review thread tails", () => {
  it("names the threads the activity read carried only the first page of", () => {
    expect(pagedReviewThreadIds(activity([thread("t1", 2, 2), thread("t2", 30, 45)]))).toEqual([
      "t2",
    ]);
  });

  it("replaces a paged thread with its own read, and keeps one that is still longer", () => {
    const read = activity([thread("t1", 30, 45), thread("t2", 30, 140)]);
    const tails = new Map([
      ["t1", thread("t1", 45, 45)],
      ["t2", thread("t2", 100, 140)],
    ]);
    const merged = withReviewThreadTails(read, tails);
    expect(merged.reviewThreads.map((entry) => entry.comments.length)).toEqual([45, 100]);
    expect(pagedReviewThreadIds(merged)).toEqual(["t2"]);
  });
});

describe("classifyPullRequestWatchReadFailure", () => {
  const providerError = (detail: string) =>
    new SourceControlProviderError({ provider: "github", operation: "read", detail });

  it("treats the typed rate-limit reason as a pause until the host's reset", () => {
    expect(
      classifyPullRequestWatchReadFailure({ reason: "rate-limited", retryAt: 1_700_000_000_000 }),
    ).toEqual({ kind: "rate-limited", retryAtMs: 1_700_000_000_000 });
    expect(
      classifyPullRequestWatchReadFailure({
        reason: "rate-limited",
        retryAt: "2026-10-04T10:00:00.000Z",
      }),
    ).toEqual({ kind: "rate-limited", retryAtMs: Date.parse("2026-10-04T10:00:00.000Z") });
  });

  it("reads GitHub's normalized rate-limit wording, and nothing else, as a rate limit", () => {
    expect(
      classifyPullRequestWatchReadFailure(
        providerError("GitHub API rate limit exceeded. Try again later."),
      ),
    ).toEqual({ kind: "rate-limited", retryAtMs: null });
    expect(classifyPullRequestWatchReadFailure(providerError("Not Found"))).toEqual({
      kind: "failed",
    });
    expect(classifyPullRequestWatchReadFailure(new Error("boom"))).toEqual({ kind: "failed" });
  });
});
