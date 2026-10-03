import { DateTime, Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  AzureDevOpsIterationChangesSchema,
  AzureDevOpsIterationSchema,
  AzureDevOpsPolicyEvaluationSchema,
  AzureDevOpsThreadSchema,
  azureDevOpsAutoMerge,
  azureDevOpsChangeTrackingIds,
  azureDevOpsCollection,
  azureDevOpsMergeCapabilities,
  azureDevOpsMergeStateStatus,
  azureDevOpsReviewDecision,
  azureDevOpsReviewerStates,
  azureDevOpsViewerFromConnectionData,
  AzureDevOpsConnectionDataSchema,
  buildAzureDevOpsCommentThreadBody,
  buildAzureDevOpsFileThreadBody,
  buildAzureDevOpsReplyBody,
  decodeAzureDevOpsCommentId,
  decodeAzureDevOpsJson,
  decodeAzureDevOpsThreadId,
  encodeAzureDevOpsCommentId,
  flattenAzureDevOpsThreadComments,
  isAzureDevOpsThreadResolved,
  toAzureDevOpsReviewThread,
  toAzureDevOpsReviewThreads,
  toAzureDevOpsTimeline,
  toAzureDevOpsViewerCapabilities,
  type AzureDevOpsIteration,
  type AzureDevOpsPolicyEvaluation,
  type AzureDevOpsThread,
} from "./azureDevOpsPullRequestPage.ts";
import {
  AZURE_COMMENT_CREATE_REQUEST,
  AZURE_COMMITS_22,
  AZURE_CONNECTION_DATA,
  AZURE_FILE_THREAD_CREATE_REQUEST,
  AZURE_ITERATION_CHANGES_22,
  AZURE_ITERATIONS_22,
  AZURE_PULL_REQUEST_21_AUTO_COMPLETE,
  AZURE_PULL_REQUEST_22,
  AZURE_THREAD_CREATE_REQUEST,
  AZURE_THREADS_22,
  azurePolicyEvaluations,
} from "./azureDevOpsPullRequestPage.fixtures.ts";
import {
  decodeAzureDevOpsRawPullRequestJson,
  type AzureDevOpsPullRequest,
} from "./azureDevOpsPullRequests.ts";

function decode<S extends Schema.Codec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
): S["Type"] {
  const result = decodeAzureDevOpsJson(schema)(JSON.stringify(value));
  if (!Result.isSuccess(result)) throw new Error("fixture did not decode");
  return result.success;
}

function pullRequest(value: unknown = AZURE_PULL_REQUEST_22): AzureDevOpsPullRequest {
  const result = decodeAzureDevOpsRawPullRequestJson(JSON.stringify(value));
  if (!Result.isSuccess(result)) throw new Error("pull request fixture did not decode");
  return result.success;
}

const threads = (): ReadonlyArray<AzureDevOpsThread> =>
  decode(azureDevOpsCollection(AzureDevOpsThreadSchema), AZURE_THREADS_22).value;
const iterations = (): ReadonlyArray<AzureDevOpsIteration> =>
  decode(azureDevOpsCollection(AzureDevOpsIterationSchema), AZURE_ITERATIONS_22).value;
const evaluations = (
  input: Parameters<typeof azurePolicyEvaluations>[0],
): ReadonlyArray<AzureDevOpsPolicyEvaluation> =>
  decode(Schema.Array(AzureDevOpsPolicyEvaluationSchema), azurePolicyEvaluations(input));

const VIEWER = { id: "d6245f20-2af8-44f4-9451-8107cb2767db", login: "fabrikamfiber16@hotmail.com" };
const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

describe("Azure DevOps timeline (official thread sample)", () => {
  it("maps system threads, general comments, commits and force pushes chronologically", () => {
    const result = toAzureDevOpsTimeline({
      pullRequest: pullRequest(),
      threads: threads(),
      iterations: iterations(),
      commits: AZURE_COMMITS_22.value,
      commitsTruncated: false,
      viewerId: VIEWER.id,
    });

    expect(result.truncated).toBe(false);
    expect(result.timeline.map((item) => [item.kind, item.id, iso(item.createdAt)])).toEqual([
      ["review-requested", "review-requested:142", "2016-11-01T16:30:35.000Z"],
      ["review", "vote:143", "2016-11-01T16:30:36.580Z"],
      ["commit", "commit:8c9396b5cf22f929767c7172e9dbbe777ddc6357", "2016-11-01T16:30:38.000Z"],
      ["review-request-removed", "review-request-removed:144", "2016-11-01T16:30:38.603Z"],
      ["force-pushed", "iteration:2", "2016-11-01T16:30:40.840Z"],
      ["comment", "147:1", "2016-11-01T16:30:48.910Z"],
    ]);
    const [requested, vote, commit, removed, forcePush, comment] = result.timeline;
    expect(requested).toMatchObject({
      actor: { login: "Normal Paulk" },
      reviewer: "Johnnie McLeod",
      reviewerKind: "user",
    });
    // The voter's TfId resolves through the identities the payloads carry.
    expect(vote).toMatchObject({
      state: "approved",
      body: "",
      threadIds: [],
      actor: { login: "fabrikamfiber16@hotmail.com" },
    });
    expect(commit).toMatchObject({
      shortOid: "8c9396b",
      messageHeadline: "Document the new value",
      messageBody: "Explains what the value means.",
    });
    expect(removed).toMatchObject({ reviewer: "Johnnie McLeod" });
    expect(forcePush).toMatchObject({
      beforeOid: "b60280bc6e62e2f880f1b63c1e24987664d3bda3",
      afterOid: "8c9396b5cf22f929767c7172e9dbbe777ddc6357",
    });
    expect(comment).toMatchObject({
      body: "This new feature looks good!",
      viewerCanUpdate: true,
      viewerCanDelete: true,
    });
  });

  it("records completion from the pull request when no status thread did, and caps the page", () => {
    const completed = pullRequest({
      ...AZURE_PULL_REQUEST_22,
      status: "completed",
      closedDate: "2016-11-02T09:00:00Z",
      closedBy: AZURE_PULL_REQUEST_22.createdBy,
    });
    const result = toAzureDevOpsTimeline({
      pullRequest: completed,
      threads: [],
      iterations: [],
      commits: [],
      commitsTruncated: true,
      viewerId: null,
    });
    expect(result.truncated).toBe(true);
    expect(result.timeline).toHaveLength(1);
    expect(result.timeline[0]).toMatchObject({
      kind: "merged",
      commitOid: "fd8da3e51efe350811d2157b2223df53d4db46c3",
      baseRefName: "new_feature",
      actor: { login: "fabrikamfiber16@hotmail.com" },
    });
  });
});

describe("Azure DevOps review threads", () => {
  const viewer = toAzureDevOpsViewerCapabilities({
    viewer: VIEWER,
    permissions: { pullRequestContribute: true, genericContribute: true },
    pullRequest: pullRequest(),
  });

  it("maps the official file thread on the head side and skips deleted comments", () => {
    const result = toAzureDevOpsReviewThreads({
      threads: threads(),
      iterations: iterations(),
      viewer,
      viewerId: VIEWER.id,
    });
    expect(result.truncated).toBe(false);
    expect(result.threads).toHaveLength(1);
    const thread = result.threads[0]!;
    expect({ ...thread, comments: undefined }).toEqual({
      id: "148",
      path: "new_feature.cpp",
      subjectType: "line",
      side: "right",
      line: 5,
      originalLine: 5,
      originalCommitOid: "8c9396b5cf22f929767c7172e9dbbe777ddc6357",
      isResolved: false,
      isOutdated: false,
      viewerCanReply: true,
      viewerCanResolve: true,
      viewerCanUnresolve: false,
      totalComments: 1,
      comments: undefined,
    });
    expect(thread.comments.map((comment) => [comment.id, comment.body])).toEqual([
      ["148:1", "Should we add a comment about what this value means?"],
    ]);
  });

  const fileThread = threads().find((thread) => thread.id === 148)!;

  it("reads a thread written on an older iteration that did not track as outdated", () => {
    const thread = toAzureDevOpsReviewThread({
      thread: {
        ...fileThread,
        pullRequestThreadContext: {
          changeTrackingId: 1,
          iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
        },
      },
      iterations: iterations(),
      viewer,
      viewerId: VIEWER.id,
    });
    expect(thread).toMatchObject({
      line: null,
      isOutdated: true,
      originalLine: 5,
      originalCommitOid: "b60280bc6e62e2f880f1b63c1e24987664d3bda3",
    });
  });

  it("uses tracked positions and keeps the written range as the original", () => {
    const thread = toAzureDevOpsReviewThread({
      thread: {
        ...fileThread,
        threadContext: {
          filePath: "/new_feature.cpp",
          rightFileStart: { line: 5, offset: 1 },
          rightFileEnd: { line: 6, offset: 4 },
        },
        pullRequestThreadContext: {
          changeTrackingId: 1,
          iterationContext: { firstComparingIteration: 1, secondComparingIteration: 1 },
          trackingCriteria: {
            firstComparingIteration: 1,
            secondComparingIteration: 2,
            origFilePath: "/new_feature.cpp",
            origRightFileStart: { line: 3, offset: 1 },
            origRightFileEnd: { line: 4, offset: 4 },
          },
        },
      },
      iterations: iterations(),
      viewer,
      viewerId: VIEWER.id,
    });
    expect(thread).toMatchObject({
      side: "right",
      startSide: "right",
      startLine: 5,
      line: 6,
      originalStartLine: 3,
      originalLine: 4,
      isOutdated: false,
    });
  });

  it("anchors base-side threads on the left and reads resolved statuses", () => {
    const thread = toAzureDevOpsReviewThread({
      thread: {
        ...fileThread,
        status: "wontFix",
        threadContext: {
          filePath: "/new_feature.cpp",
          leftFileStart: { line: 7, offset: 1 },
          leftFileEnd: { line: 7, offset: 9 },
        },
      },
      iterations: iterations(),
      viewer,
      viewerId: VIEWER.id,
    });
    expect(thread).toMatchObject({
      side: "left",
      line: 7,
      isResolved: true,
      viewerCanResolve: false,
      viewerCanUnresolve: true,
    });
    expect(isAzureDevOpsThreadResolved("active")).toBe(false);
    expect(isAzureDevOpsThreadResolved("pending")).toBe(false);
    expect(isAzureDevOpsThreadResolved("byDesign")).toBe(true);
    expect(isAzureDevOpsThreadResolved(2)).toBe(true);
  });

  it("flattens live text comments for the composer detail", () => {
    expect(flattenAzureDevOpsThreadComments(threads()).map((comment) => comment.id)).toEqual([
      "147:1",
      "148:1",
    ]);
  });
});

describe("Azure DevOps viewer", () => {
  it("derives capabilities from authorship and repository permissions", () => {
    expect(
      toAzureDevOpsViewerCapabilities({
        viewer: VIEWER,
        permissions: { pullRequestContribute: true, genericContribute: true },
        pullRequest: pullRequest(),
      }),
    ).toEqual({
      login: "fabrikamfiber16@hotmail.com",
      isAuthor: true,
      canUpdate: true,
      canMerge: true,
      canReview: true,
      canUpdateBranch: false,
      canEnableAutoMerge: true,
      canDisableAutoMerge: false,
    });
    // A reader who is not the author gets nothing; unknown permissions keep the author's rights.
    const reader = toAzureDevOpsViewerCapabilities({
      viewer: { id: "3b5f0c34-4aec-4bf4-8708-1d36f0dbc468", login: "fabrikamfiber1@hotmail.com" },
      permissions: { pullRequestContribute: false, genericContribute: false },
      pullRequest: pullRequest(),
    });
    expect([reader.isAuthor, reader.canUpdate, reader.canReview, reader.canMerge]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    const unknown = toAzureDevOpsViewerCapabilities({
      viewer: VIEWER,
      permissions: null,
      pullRequest: pullRequest(AZURE_PULL_REQUEST_21_AUTO_COMPLETE),
    });
    expect([unknown.canUpdate, unknown.canReview, unknown.canMerge]).toEqual([true, true, false]);
    // The viewer armed auto-complete, so they may disarm it without completion rights.
    expect(unknown.canDisableAutoMerge).toBe(true);
  });

  it("reads the signed-in identity from connection data", () => {
    expect(
      azureDevOpsViewerFromConnectionData(
        decode(AzureDevOpsConnectionDataSchema, AZURE_CONNECTION_DATA),
      ),
    ).toEqual(VIEWER);
  });
});

describe("Azure DevOps merge readiness", () => {
  const reviewers = pullRequest().reviewers ?? [];

  it("takes the review verdict from blocking reviewer policies and negative votes", () => {
    expect(
      azureDevOpsReviewDecision({
        reviewers,
        evaluations: evaluations({ build: "approved", minimumApprovals: "approved" }),
      }),
    ).toBe("approved");
    expect(
      azureDevOpsReviewDecision({
        reviewers: [{ ...reviewers[0]!, vote: 0 }],
        evaluations: evaluations({ build: "approved", minimumApprovals: "running" }),
      }),
    ).toBe("review_required");
    expect(
      azureDevOpsReviewDecision({
        reviewers: [{ ...reviewers[0]!, vote: -5 }],
        evaluations: evaluations({ build: "approved", minimumApprovals: "approved" }),
      }),
    ).toBe("changes_requested");
    // Without policies or required reviewers the votes give no verdict.
    expect(azureDevOpsReviewDecision({ reviewers, evaluations: null })).toBeNull();
  });

  it("derives the merge state from draft, conflicts and blocking policies", () => {
    const active = pullRequest();
    const state = (
      pr: AzureDevOpsPullRequest,
      evals: ReadonlyArray<AzureDevOpsPolicyEvaluation> | null,
    ) => azureDevOpsMergeStateStatus({ pullRequest: pr, evaluations: evals });
    expect(state(active, evaluations({ build: "approved", minimumApprovals: "approved" }))).toBe(
      "clean",
    );
    expect(state(active, evaluations({ build: "running", minimumApprovals: "approved" }))).toBe(
      "blocked",
    );
    expect(state(pullRequest({ ...AZURE_PULL_REQUEST_22, isDraft: true }), null)).toBe("draft");
    expect(state(pullRequest({ ...AZURE_PULL_REQUEST_22, mergeStatus: "conflicts" }), null)).toBe(
      "dirty",
    );
    expect(state(active, null)).toBeUndefined();
  });

  it("limits merge methods to a merge-strategy policy", () => {
    expect(
      azureDevOpsMergeCapabilities(
        evaluations({ build: "approved", minimumApprovals: "approved", mergeStrategy: true }),
      ),
    ).toEqual({ merge: false, squash: true, rebase: false });
    expect(azureDevOpsMergeCapabilities(null)).toEqual({ merge: true, squash: true, rebase: true });
    expect(
      azureDevOpsMergeCapabilities(
        decode(Schema.Array(AzureDevOpsPolicyEvaluationSchema), [
          {
            status: "approved",
            configuration: {
              isEnabled: true,
              isBlocking: true,
              type: { id: "fa4e907d-c16b-4a4c-9dfa-4916e5d171ab" },
              settings: { allowNoFastForward: true, allowSquash: false, allowRebase: true },
            },
          },
        ]),
      ),
    ).toEqual({ merge: true, squash: false, rebase: true });
  });

  it("maps reviewer votes and auto-complete", () => {
    expect(azureDevOpsReviewerStates(reviewers)).toEqual([
      {
        login: "fabrikamfiber16@hotmail.com",
        kind: "user",
        state: "approved",
        avatarUrl:
          "https://dev.azure.com/fabrikam/_api/_common/identityImage?id=d6245f20-2af8-44f4-9451-8107cb2767db",
      },
    ]);
    expect(azureDevOpsAutoMerge(pullRequest(AZURE_PULL_REQUEST_21_AUTO_COMPLETE))).toEqual({
      mergeMethod: "merge",
      enabledBy: "fabrikamfiber16@hotmail.com",
    });
    expect(azureDevOpsAutoMerge(pullRequest())).toBeNull();
  });
});

describe("Azure DevOps request bodies (official examples)", () => {
  it("builds the documented thread, line thread and reply bodies", () => {
    expect(buildAzureDevOpsCommentThreadBody("This new feature looks good!")).toEqual(
      AZURE_THREAD_CREATE_REQUEST,
    );
    const {
      leftFileStart: _start,
      leftFileEnd: _end,
      ...rightOnly
    } = AZURE_FILE_THREAD_CREATE_REQUEST.threadContext;
    expect(
      buildAzureDevOpsFileThreadBody({
        comment: {
          path: "new_feature.cpp",
          body: "Should we add a comment about what this value means?",
          line: 5,
          side: "right",
        },
        iterationId: 2,
        changeTrackingId: 1,
        endLineLength: 12,
      }),
    ).toEqual({ ...AZURE_FILE_THREAD_CREATE_REQUEST, threadContext: rightOnly });
    expect(buildAzureDevOpsReplyBody({ content: "Good idea", parentCommentId: 1 })).toEqual(
      AZURE_COMMENT_CREATE_REQUEST,
    );
  });

  it("anchors base-side ranges and file comments", () => {
    const left = buildAzureDevOpsFileThreadBody({
      comment: { path: "src/a.ts", body: "x", line: 9, startLine: 7, side: "left" },
      iterationId: 3,
      changeTrackingId: null,
    });
    expect(left.threadContext).toEqual({
      filePath: "/src/a.ts",
      leftFileStart: { line: 7, offset: 1 },
      leftFileEnd: { line: 9, offset: 1 },
    });
    expect(left.pullRequestThreadContext).toEqual({
      iterationContext: { firstComparingIteration: 1, secondComparingIteration: 3 },
    });
    const file = buildAzureDevOpsFileThreadBody({
      comment: { path: "src/a.ts", body: "x", subjectType: "file" },
      iterationId: 3,
      changeTrackingId: 4,
    });
    expect(file.threadContext).toEqual({ filePath: "/src/a.ts" });
  });

  it("maps change tracking ids from the iteration changes sample", () => {
    const changes = decode(AzureDevOpsIterationChangesSchema, AZURE_ITERATION_CHANGES_22);
    expect([...azureDevOpsChangeTrackingIds(changes)]).toEqual([
      ["new_feature.cpp", 1],
      ["new_feature.h", 2],
    ]);
  });

  it("round-trips comment and thread ids", () => {
    expect(encodeAzureDevOpsCommentId(148, 2)).toBe("148:2");
    expect(decodeAzureDevOpsCommentId("148:2")).toEqual({ threadId: 148, commentId: 2 });
    expect(decodeAzureDevOpsCommentId("PRRC_1")).toBeNull();
    expect(decodeAzureDevOpsThreadId("148")).toBe(148);
    expect(decodeAzureDevOpsThreadId("148:1")).toBeNull();
  });
});
