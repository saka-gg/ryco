/**
 * `vi.mock` factories that serve the pull request fixtures through the rpc
 * hooks. This module imports only fixtures, contracts and pure client-runtime
 * helpers — never the modules it replaces — so it is safe to `import()` from
 * inside a `vi.mock` factory.
 *
 * `vi.mock` is hoisted above the test file's imports, so load the factory
 * with a dynamic import inside the mock callback:
 *
 * ```ts
 * vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
 *   const { createSourceControlRpcMock } = await import(
 *     "~/components/pullRequests/testing/sourceControlRpcMock"
 *   );
 *   return createSourceControlRpcMock(await importOriginal());
 * });
 * // Optional, for the Files area's viewed checkboxes:
 * vi.mock("~/components/projectExplorer/usePullRequestFilesViewed", async () => {
 *   const { createPullRequestFilesViewedMock } = await import(
 *     "~/components/pullRequests/testing/sourceControlRpcMock"
 *   );
 *   return createPullRequestFilesViewedMock();
 * });
 * ```
 *
 * The `~/…` specifier is resolved to a file, so it also replaces the module
 * when components import it relatively (`../../rpc/useSourceControl`).
 *
 * Reads come from `pullRequestFixtureStore`; mutations record a call in
 * `sourceControlRpcMock.calls` and apply a plausible result to the store
 * (resolve/reply/review/edit/draft/labels/merge …). Override any read with
 * `sourceControlRpcMock.queryOverrides[hookName]` (e.g. a loading or error
 * state) and any mutation with `sourceControlRpcMock.mutationOverrides[hookName]`
 * (e.g. a deferred promise to screenshot the pending state, or a rejection).
 * Call `sourceControlRpcMock.reset()` in `afterEach`.
 */
import type {
  ChangeRequest,
  ChangeRequestActivity,
  ChangeRequestCreateInput,
  ChangeRequestReviewThread,
  ChangeRequestTimelineItem,
  ChangeRequestUpdateAction,
  SourceControlAddChangeRequestCommentInput,
  SourceControlAddCommentReactionInput,
  SourceControlChangeRequestDetail,
  SourceControlCommentReaction,
  SourceControlCommentReactionContent,
  SourceControlWorkflowRunJobsResult,
  SourceControlWorkflowRunListResult,
} from "@ryco/contracts";
import {
  applyCommentUpdateToActivity,
  applyCommentUpdateToDetail,
  applyOptimisticChangeRequestUpdate,
  replaceReviewThreadInActivity,
  searchChangeRequests,
  setReviewThreadResolvedInActivity,
} from "@ryco/client-runtime/state/pull-request-review";
import { DateTime, Option } from "effect";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type {
  ChangeRequestMutationTarget,
  ReplyToReviewThreadPayload,
  SetReviewThreadResolvedPayload,
  SourceControlChangeRequestActivityInput,
  SourceControlChangeRequestDetailInput,
  SourceControlChangeRequestDiffInput,
  SourceControlChangeRequestListInput,
  SourceControlChangeRequestSearchInput,
  SourceControlQueryState,
  SourceControlWorkflowJobLogInput,
  SourceControlWorkflowRunJobsInput,
  SourceControlWorkflowRunsInput,
  SubmitChangeRequestReviewPayload,
  UpdateChangeRequestCommentPayload,
} from "../../../rpc/sourceControlAtoms";
import {
  FIXTURE_REPOSITORY,
  FIXTURE_REPOSITORY_URL,
  FIXTURE_VIEWER_LOGIN,
  fixtureActor,
  fixtureAssigneeCandidates,
  fixtureDiff,
  fixtureLabelList,
  fixtureWorkflowJobLog,
  fixtureWorkflowRunJobs,
  fixtureWorkflowRuns,
} from "./pullRequestFixtures";
import { pullRequestFixtureStore, usePullRequestFixtureVersion } from "./pullRequestFixtureStore";

/** Read hooks served from fixtures. */
export type SourceControlRpcReadHook =
  | "useSourceControlIssueList"
  | "useSourceControlChangeRequestList"
  | "useSourceControlIssueSearch"
  | "useSourceControlChangeRequestSearch"
  | "useSourceControlRepositorySearch"
  | "useSourceControlIssueLabels"
  | "useSourceControlIssueAssignees"
  | "useSourceControlIssueDetail"
  | "useSourceControlChangeRequestDetail"
  | "useSourceControlChangeRequestDiff"
  | "useSourceControlChangeRequestActivity"
  | "useSourceControlWorkflowRuns"
  | "useSourceControlWorkflowRunJobs"
  | "useSourceControlWorkflowJobLog";

/** Mutation hooks; each returns `{ mutateAsync, isPending, error, reset }`. */
export type SourceControlRpcMutationHook =
  | "useCreateIssueMutation"
  | "useAddIssueCommentMutation"
  | "useAddIssueCommentReactionMutation"
  | "useAddChangeRequestCommentMutation"
  | "useAddChangeRequestCommentReactionMutation"
  | "useMergeChangeRequestMutation"
  | "useSubmitChangeRequestReviewMutation"
  | "useReplyToReviewThreadMutation"
  | "useSetReviewThreadResolvedMutation"
  | "useUpdateChangeRequestCommentMutation"
  | "useUpdateChangeRequestMutation"
  | "useCreateChangeRequestMutation"
  | "useRerunWorkflowMutation"
  | "useGenerateIssueContentMutation"
  | "useGenerateBranchNameMutation"
  | "setChangeRequestFileViewed";

export interface SourceControlRpcMockCall {
  readonly hook: SourceControlRpcMutationHook;
  /** The hook's argument (mutation target / input), when it takes one. */
  readonly target: unknown;
  /** The `mutateAsync` payload. */
  readonly args: unknown;
}

export interface SourceControlRpcMockQuery {
  readonly hook: SourceControlRpcReadHook;
  readonly input: unknown;
}

type QueryOverride = (input: never) => Partial<SourceControlQueryState<unknown>> | undefined;
type MutationOverride = (args: never, target: unknown) => Promise<unknown>;

export const sourceControlRpcMock = {
  /** Every `mutateAsync` call, in order. */
  calls: [] as SourceControlRpcMockCall[],
  /** Distinct read inputs, in first-seen order (e.g. assert Files asked for `commitSha`). */
  queries: [] as SourceControlRpcMockQuery[],
  /** Patch a read's state; return `undefined` to fall back to the fixtures. */
  queryOverrides: {} as Partial<Record<SourceControlRpcReadHook, QueryOverride>>,
  /** Replace a mutation's behaviour (skips the default store update). */
  mutationOverrides: {} as Partial<Record<SourceControlRpcMutationHook, MutationOverride>>,
  /** Jobs to serve for a run id instead of the fixtures' (e.g. another host's run). */
  workflowRunJobs: {} as Record<string, SourceControlWorkflowRunJobsResult["jobs"]>,
  callsTo(hook: SourceControlRpcMutationHook): ReadonlyArray<SourceControlRpcMockCall> {
    return sourceControlRpcMock.calls.filter((call) => call.hook === hook);
  },
  /** Clears calls and overrides and restores pristine fixtures. */
  reset(): void {
    sourceControlRpcMock.calls.length = 0;
    sourceControlRpcMock.queries.length = 0;
    sourceControlRpcMock.queryOverrides = {};
    sourceControlRpcMock.mutationOverrides = {};
    sourceControlRpcMock.workflowRunJobs = {};
    seenQueries.clear();
    pullRequestFixtureStore.reset();
  },
};

const seenQueries = new Set<string>();

// ── Reads ─────────────────────────────────────────────────────────────

function referenceNumber(reference: string | null | undefined): number | null {
  if (!reference) return null;
  const number = Number(reference.replace(/^#/u, ""));
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function useFixtureQuery<TData>(
  hook: SourceControlRpcReadHook,
  input: { readonly enabled?: boolean | undefined } & object,
  read: () => TData | null,
): SourceControlQueryState<TData> {
  const version = usePullRequestFixtureVersion();
  const key = JSON.stringify([hook, input]);
  if (!seenQueries.has(key)) {
    seenQueries.add(key);
    sourceControlRpcMock.queries.push({ hook, input });
  }
  const override = sourceControlRpcMock.queryOverrides[hook] as
    | ((input: unknown) => Partial<SourceControlQueryState<unknown>> | undefined)
    | undefined;
  const patch = override?.(input);
  const patchKey =
    patch === undefined
      ? ""
      : JSON.stringify(patch, (_key, value) => (value instanceof Error ? value.message : value));
  return useMemo(() => {
    const enabled = input.enabled ?? true;
    const base: SourceControlQueryState<TData> = {
      data: enabled ? read() : null,
      isLoading: false,
      isFetching: false,
      error: null,
    };
    return patch ? ({ ...base, ...patch } as SourceControlQueryState<TData>) : base;
    // `key` captures the input; `version` the store; `patchKey` the override.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, patchKey]);
}

function emptyRuns(): SourceControlWorkflowRunListResult {
  return {
    provider: "github",
    repository: Option.some(FIXTURE_REPOSITORY),
    pullRequestNumber: Option.none(),
    headSha: Option.none(),
    runs: [],
  };
}

function runJobs(runId: string): SourceControlWorkflowRunJobsResult {
  const jobs = sourceControlRpcMock.workflowRunJobs[runId];
  return jobs ? { provider: "github", runId, jobs } : fixtureWorkflowRunJobs(runId);
}

function workflowRunsFor(
  input: SourceControlWorkflowRunsInput,
): SourceControlWorkflowRunListResult {
  if (input.pullRequestNumber) return fixtureWorkflowRuns(input.pullRequestNumber);
  if (input.commitSha) {
    const row = pullRequestFixtureStore
      .rows()
      .find((entry) => entry.headSha?.startsWith(input.commitSha ?? "\0"));
    if (row) return fixtureWorkflowRuns(row.number);
  }
  return emptyRuns();
}

// ── Mutations ─────────────────────────────────────────────────────────

let mutationSequence = 0;
function nextId(prefix: string): string {
  mutationSequence += 1;
  return `${prefix}-${mutationSequence}`;
}

function now(): DateTime.Utc {
  return DateTime.makeUnsafe(Date.now());
}

function useMockMutation<TArgs, TResult>(
  hook: SourceControlRpcMutationHook,
  target: unknown,
  run: (args: TArgs) => TResult | Promise<TResult>,
) {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const runRef = useRef(run);
  const targetRef = useRef(target);
  useLayoutEffect(() => {
    runRef.current = run;
    targetRef.current = target;
  });
  const mutateAsync = useCallback(
    async (args: TArgs): Promise<TResult> => {
      sourceControlRpcMock.calls.push({ hook, target: targetRef.current, args });
      setIsPending(true);
      setError(null);
      try {
        const override = sourceControlRpcMock.mutationOverrides[hook] as
          | ((args: TArgs, target: unknown) => Promise<unknown>)
          | undefined;
        const result = override
          ? ((await override(args, targetRef.current)) as TResult)
          : await runRef.current(args);
        setIsPending(false);
        return result;
      } catch (rawError) {
        const normalized = rawError instanceof Error ? rawError : new Error("Mutation failed.");
        setIsPending(false);
        setError(normalized);
        throw normalized;
      }
    },
    [hook],
  );
  const reset = useCallback(() => {
    setIsPending(false);
    setError(null);
  }, []);
  return { mutateAsync, isPending, error, reset };
}

function targetNumber(target: { readonly reference: string | null }): number {
  const number = referenceNumber(target.reference);
  if (number === null) throw new Error("Pull request is unavailable.");
  return number;
}

function toggleReaction(
  reactions: ReadonlyArray<SourceControlCommentReaction> | undefined,
  content: SourceControlCommentReactionContent,
): ReadonlyArray<SourceControlCommentReaction> {
  const existing = reactions?.find((reaction) => reaction.content === content);
  const others = reactions?.filter((reaction) => reaction.content !== content) ?? [];
  if (!existing) return [...others, { content, count: 1, viewerHasReacted: true }];
  const reacted = existing.viewerHasReacted === true;
  const count = reacted ? existing.count - 1 : existing.count + 1;
  return count <= 0 ? others : [...others, { ...existing, count, viewerHasReacted: !reacted }];
}

function appendTimeline(
  activity: ChangeRequestActivity,
  item: ChangeRequestTimelineItem,
): ChangeRequestActivity {
  return { ...activity, timeline: [...activity.timeline, item] };
}

function requireDetail(number: number): SourceControlChangeRequestDetail {
  const detail = pullRequestFixtureStore.detail(number);
  if (!detail) throw new Error(`No pull request fixture for #${number}.`);
  return detail;
}

function applyUpdate(
  number: number,
  action: ChangeRequestUpdateAction,
): SourceControlChangeRequestDetail {
  pullRequestFixtureStore.updateDetail(number, (detail) => {
    switch (action.kind) {
      case "close":
        return { ...detail, state: "closed", closedAt: now() };
      case "reopen": {
        const { closedAt: _closedAt, ...rest } = detail;
        return { ...rest, state: "open" };
      }
      case "auto-merge":
        return {
          ...detail,
          autoMerge: action.enabled
            ? {
                mergeMethod: action.mergeMethod ?? "squash",
                enabledBy: FIXTURE_VIEWER_LOGIN,
                enabledAt: now(),
              }
            : null,
        };
      case "update-branch":
        return detail.mergeStateStatus === "behind"
          ? { ...detail, mergeStateStatus: "blocked" }
          : detail;
      default:
        return applyOptimisticChangeRequestUpdate(detail, action);
    }
  });
  return requireDetail(number);
}

function submitReview(number: number, payload: SubmitChangeRequestReviewPayload) {
  const reviewId = nextId("mock-review");
  const createdAt = now();
  const threads: ChangeRequestReviewThread[] = payload.comments.map((comment) => {
    const threadId = nextId("mock-thread");
    const isFile = comment.subjectType === "file";
    return {
      id: threadId,
      path: comment.path,
      subjectType: isFile ? "file" : "line",
      side: comment.side ?? "right",
      ...(comment.startSide ? { startSide: comment.startSide } : {}),
      line: isFile ? null : (comment.line ?? null),
      startLine: comment.startLine ?? null,
      originalLine: isFile ? null : (comment.line ?? null),
      isResolved: false,
      isOutdated: false,
      viewerCanReply: true,
      viewerCanResolve: true,
      viewerCanUnresolve: false,
      comments: [
        {
          id: nextId("mock-comment"),
          author: fixtureActor(FIXTURE_VIEWER_LOGIN),
          body: comment.body,
          createdAt,
          state: "submitted",
          viewerCanUpdate: true,
          viewerCanDelete: true,
        },
      ],
      totalComments: 1,
    };
  });
  const state =
    payload.event === "approve"
      ? ("approved" as const)
      : payload.event === "request_changes"
        ? ("changes_requested" as const)
        : ("commented" as const);
  pullRequestFixtureStore.updateActivity(number, (activity) => ({
    ...appendTimeline(activity, {
      id: reviewId,
      createdAt,
      actor: fixtureActor(FIXTURE_VIEWER_LOGIN),
      kind: "review",
      state,
      body: payload.body ?? "",
      threadIds: threads.map((thread) => thread.id),
      viewerCanUpdate: true,
    }),
    reviewThreads: [...activity.reviewThreads, ...threads],
    pendingReview: null,
  }));
  return {
    reviewId,
    state,
    url: `${FIXTURE_REPOSITORY_URL}/pull/${number}#pullrequestreview-${reviewId}`,
  };
}

function issueCommentDetail(number: number, body: string) {
  const id = nextId("mock-issue-comment");
  const createdAt = now();
  pullRequestFixtureStore.updateActivity(number, (activity) =>
    appendTimeline(activity, {
      id,
      createdAt,
      actor: fixtureActor(FIXTURE_VIEWER_LOGIN),
      kind: "comment",
      body,
      authorAssociation: "MEMBER",
      viewerCanUpdate: true,
      viewerCanDelete: true,
    }),
  );
  pullRequestFixtureStore.updateDetail(number, (detail) => ({
    ...detail,
    comments: [...detail.comments, { id, author: FIXTURE_VIEWER_LOGIN, body, createdAt }],
  }));
  return { detail: requireDetail(number) };
}

// ── Factories ─────────────────────────────────────────────────────────

class FixtureFileContentsUnavailableError extends Error {
  readonly reason: "binary" | "truncated";
  constructor(reason: "binary" | "truncated", path: string) {
    super(`${path} has no fixture contents to expand.`);
    this.name = "ChangeRequestFileContentsUnavailableError";
    this.reason = reason;
  }
}

/**
 * Module replacement for `~/rpc/useSourceControl`. Pass the original module
 * (from `importOriginal()`) so exports this mock does not know about keep
 * working; every hook the pull requests page uses is replaced.
 */
export function createSourceControlRpcMock(original?: object): Record<string, unknown> {
  const UnavailableError =
    (
      original as
        | { ChangeRequestFileContentsUnavailableError?: typeof FixtureFileContentsUnavailableError }
        | undefined
    )?.ChangeRequestFileContentsUnavailableError ?? FixtureFileContentsUnavailableError;
  return {
    ...original,
    // Reads
    useSourceControlIssueList: (input: { enabled?: boolean }) =>
      useFixtureQuery("useSourceControlIssueList", input, () => []),
    useSourceControlIssueSearch: (input: { enabled?: boolean }) =>
      useFixtureQuery("useSourceControlIssueSearch", input, () => []),
    useSourceControlIssueDetail: (input: { enabled?: boolean }) =>
      useFixtureQuery("useSourceControlIssueDetail", input, () => null),
    useSourceControlRepositorySearch: (input: { enabled?: boolean }) =>
      useFixtureQuery("useSourceControlRepositorySearch", input, () => ({ repositories: [] })),
    useSourceControlIssueLabels: (input: { enabled?: boolean }) =>
      useFixtureQuery("useSourceControlIssueLabels", input, () => fixtureLabelList),
    useSourceControlIssueAssignees: (input: { enabled?: boolean }) =>
      useFixtureQuery("useSourceControlIssueAssignees", input, () => fixtureAssigneeCandidates),
    useSourceControlChangeRequestList: (input: SourceControlChangeRequestListInput) =>
      useFixtureQuery("useSourceControlChangeRequestList", input, () =>
        pullRequestFixtureStore.list(input).slice(0, input.limit ?? 100),
      ),
    useSourceControlChangeRequestSearch: (input: SourceControlChangeRequestSearchInput) =>
      useFixtureQuery("useSourceControlChangeRequestSearch", input, () =>
        searchChangeRequests(pullRequestFixtureStore.rows(), input.query).slice(
          0,
          input.limit ?? 30,
        ),
      ),
    useSourceControlChangeRequestDetail: (input: SourceControlChangeRequestDetailInput) =>
      useFixtureQuery("useSourceControlChangeRequestDetail", input, () => {
        const number = referenceNumber(input.reference);
        return number === null ? null : pullRequestFixtureStore.detail(number);
      }),
    useSourceControlChangeRequestDiff: (input: SourceControlChangeRequestDiffInput) =>
      useFixtureQuery("useSourceControlChangeRequestDiff", input, () => {
        const number = referenceNumber(input.reference);
        return number === null || pullRequestFixtureStore.detail(number) === null
          ? null
          : fixtureDiff(number, { commitSha: input.commitSha });
      }),
    useSourceControlChangeRequestActivity: (input: SourceControlChangeRequestActivityInput) =>
      useFixtureQuery("useSourceControlChangeRequestActivity", input, () => {
        const number = referenceNumber(input.reference);
        return number === null ? null : pullRequestFixtureStore.activity(number);
      }),
    useSourceControlWorkflowRuns: (input: SourceControlWorkflowRunsInput) =>
      useFixtureQuery("useSourceControlWorkflowRuns", input, () => workflowRunsFor(input)),
    useSourceControlWorkflowRunJobs: (input: SourceControlWorkflowRunJobsInput) =>
      useFixtureQuery("useSourceControlWorkflowRunJobs", input, () =>
        input.runId ? runJobs(input.runId) : null,
      ),
    useSourceControlWorkflowRunJobsBatch: (input: {
      readonly runIds: ReadonlyArray<string>;
      readonly enabled: boolean;
    }) => {
      const signature = input.runIds.join("\u0001");
      return useMemo(() => {
        const jobsByRunId = new Map<string, SourceControlWorkflowRunJobsResult["jobs"]>();
        if (input.enabled) {
          for (const runId of input.runIds) jobsByRunId.set(runId, runJobs(runId).jobs);
        }
        return { jobsByRunId, isLoading: false };
        // oxlint-disable-next-line react-hooks/exhaustive-deps
      }, [signature, input.enabled]);
    },
    useSourceControlWorkflowJobLog: (input: SourceControlWorkflowJobLogInput) =>
      useFixtureQuery("useSourceControlWorkflowJobLog", input, () =>
        input.runId && input.jobId ? fixtureWorkflowJobLog(input.runId, input.jobId) : null,
      ),
    // Mutations
    useSubmitChangeRequestReviewMutation: (target: ChangeRequestMutationTarget) =>
      useMockMutation(
        "useSubmitChangeRequestReviewMutation",
        target,
        (payload: SubmitChangeRequestReviewPayload) => submitReview(targetNumber(target), payload),
      ),
    useReplyToReviewThreadMutation: (target: ChangeRequestMutationTarget) =>
      useMockMutation(
        "useReplyToReviewThreadMutation",
        target,
        (payload: ReplyToReviewThreadPayload) => {
          const number = targetNumber(target);
          const thread = pullRequestFixtureStore
            .activity(number)
            ?.reviewThreads.find((candidate) => candidate.id === payload.threadId);
          if (!thread) throw new Error("Review thread not found.");
          const next: ChangeRequestReviewThread = {
            ...thread,
            comments: [
              ...thread.comments,
              {
                id: nextId("mock-reply"),
                author: fixtureActor(FIXTURE_VIEWER_LOGIN),
                body: payload.body,
                createdAt: now(),
                state: "submitted",
                viewerCanUpdate: true,
                viewerCanDelete: true,
              },
            ],
            totalComments: thread.totalComments + 1,
          };
          pullRequestFixtureStore.updateActivity(number, (activity) =>
            replaceReviewThreadInActivity(activity, next),
          );
          return { thread: next };
        },
      ),
    useSetReviewThreadResolvedMutation: (target: ChangeRequestMutationTarget) =>
      useMockMutation(
        "useSetReviewThreadResolvedMutation",
        target,
        (payload: SetReviewThreadResolvedPayload) => {
          pullRequestFixtureStore.updateActivity(targetNumber(target), (activity) =>
            setReviewThreadResolvedInActivity(activity, payload.threadId, {
              isResolved: payload.resolved,
              resolvedBy: FIXTURE_VIEWER_LOGIN,
            }),
          );
          return {
            threadId: payload.threadId,
            isResolved: payload.resolved,
            ...(payload.resolved ? { resolvedBy: FIXTURE_VIEWER_LOGIN } : {}),
          };
        },
      ),
    useUpdateChangeRequestCommentMutation: (target: ChangeRequestMutationTarget) =>
      useMockMutation(
        "useUpdateChangeRequestCommentMutation",
        target,
        (payload: UpdateChangeRequestCommentPayload) => {
          const number = targetNumber(target);
          const update =
            payload.action === "edit"
              ? { commentId: payload.commentId, action: "edit" as const, body: payload.body }
              : { commentId: payload.commentId, action: "delete" as const };
          pullRequestFixtureStore.updateActivity(number, (activity) =>
            applyCommentUpdateToActivity(activity, update),
          );
          pullRequestFixtureStore.updateDetail(number, (detail) =>
            applyCommentUpdateToDetail(detail, update),
          );
          return { commentId: payload.commentId, deleted: payload.action === "delete" };
        },
      ),
    useUpdateChangeRequestMutation: (target: ChangeRequestMutationTarget) =>
      useMockMutation(
        "useUpdateChangeRequestMutation",
        target,
        (action: ChangeRequestUpdateAction) => ({
          detail: applyUpdate(targetNumber(target), action),
        }),
      ),
    useMergeChangeRequestMutation: (target: ChangeRequestMutationTarget) =>
      useMockMutation("useMergeChangeRequestMutation", target, () => {
        const number = targetNumber(target);
        const mergedAt = now();
        pullRequestFixtureStore.updateDetail(number, (detail) => ({
          ...detail,
          state: "merged",
          mergedAt,
          closedAt: mergedAt,
          mergedBy: FIXTURE_VIEWER_LOGIN,
        }));
        return { outcome: "merged" as const };
      }),
    useAddChangeRequestCommentMutation: (target: ChangeRequestMutationTarget) =>
      useMockMutation(
        "useAddChangeRequestCommentMutation",
        target,
        (payload: Pick<SourceControlAddChangeRequestCommentInput, "body">) =>
          issueCommentDetail(targetNumber(target), payload.body),
      ),
    useAddChangeRequestCommentReactionMutation: (target: ChangeRequestMutationTarget) =>
      useMockMutation(
        "useAddChangeRequestCommentReactionMutation",
        target,
        (payload: Pick<SourceControlAddCommentReactionInput, "commentId" | "content">) => {
          const number = targetNumber(target);
          pullRequestFixtureStore.updateActivity(number, (activity) => ({
            ...activity,
            timeline: activity.timeline.map((item) =>
              (item.kind === "comment" || item.kind === "review") && item.id === payload.commentId
                ? { ...item, reactions: toggleReaction(item.reactions, payload.content) }
                : item,
            ),
            reviewThreads: activity.reviewThreads.map((thread) =>
              thread.comments.some((comment) => comment.id === payload.commentId)
                ? {
                    ...thread,
                    comments: thread.comments.map((comment) =>
                      comment.id === payload.commentId
                        ? {
                            ...comment,
                            reactions: toggleReaction(comment.reactions, payload.content),
                          }
                        : comment,
                    ),
                  }
                : thread,
            ),
          }));
          return { detail: requireDetail(number) };
        },
      ),
    useCreateChangeRequestMutation: (target: { environmentId: unknown }) =>
      useMockMutation(
        "useCreateChangeRequestMutation",
        target,
        (payload: ChangeRequestCreateInput): ChangeRequest => ({
          provider: "github",
          number: 800,
          title: payload.title,
          url: `${FIXTURE_REPOSITORY_URL}/pull/800`,
          baseRefName: payload.baseRefName,
          headRefName: payload.headRefName,
          state: "open",
          updatedAt: Option.some(now()),
          isDraft: payload.draft ?? false,
          author: FIXTURE_VIEWER_LOGIN,
        }),
      ),
    useRerunWorkflowMutation: (target: { runId: string }) =>
      useMockMutation(
        "useRerunWorkflowMutation",
        target,
        (
          payload:
            | { readonly target: "failed-jobs" }
            | { readonly target: "job"; readonly jobId: string },
        ) => ({
          provider: "github" as const,
          runId: target.runId,
          ...payload,
        }),
      ),
    useCreateIssueMutation: (target: unknown) =>
      useMockMutation("useCreateIssueMutation", target, () => ({ number: 900 })),
    useAddIssueCommentMutation: (target: unknown) =>
      useMockMutation("useAddIssueCommentMutation", target, () => ({ detail: null })),
    useAddIssueCommentReactionMutation: (target: unknown) =>
      useMockMutation("useAddIssueCommentReactionMutation", target, () => ({ detail: null })),
    useGenerateIssueContentMutation: (target: unknown) =>
      useMockMutation("useGenerateIssueContentMutation", target, () => ({ title: "", body: "" })),
    useGenerateBranchNameMutation: (target: unknown) =>
      useMockMutation("useGenerateBranchNameMutation", target, () => ({ branch: "ryco/fixture" })),
    // Plain functions
    invalidateSourceControl: () => undefined,
    writeChangeRequestDetail: () => undefined,
    fetchSourceControlChangeRequestDetail: async (input: { reference: string }) => {
      const number = referenceNumber(input.reference);
      return number === null ? null : pullRequestFixtureStore.detail(number);
    },
    fetchSourceControlIssueDetail: async () => null,
    loadChangeRequestFileContents: async (input: { path: string }) => {
      throw new UnavailableError("truncated", input.path);
    },
    ChangeRequestFileContentsUnavailableError: UnavailableError,
    /** Hunk expansion is unavailable in fixtures: every load is refused like a truncated file. */
    createChangeRequestDiffFilesLoader: () => async (fileDiff: { name: string }) => {
      throw new UnavailableError("truncated", fileDiff.name);
    },
  };
}

/**
 * Module replacement for `~/components/projectExplorer/usePullRequestFilesViewed`
 * backed by `pullRequestFixtureStore` (toggling a checkbox updates the store).
 */
export function createPullRequestFilesViewedMock(original?: object): Record<string, unknown> {
  return {
    ...original,
    usePullRequestFilesViewed: (input: {
      readonly reference: string;
      readonly headSha: string | null;
      readonly active: boolean;
    }) => {
      const version = usePullRequestFixtureVersion();
      const number = referenceNumber(input.reference);
      return useMemo(() => {
        const data =
          input.active && number !== null ? pullRequestFixtureStore.filesViewed(number) : null;
        return {
          data,
          error: null,
          pendingPaths: new Set<string>(),
          isLoading: false,
          refresh: async () => undefined,
          setViewed: async (path: string, viewed: boolean) => {
            if (number === null) return;
            sourceControlRpcMock.calls.push({
              hook: "setChangeRequestFileViewed",
              target: { reference: input.reference },
              args: { path, viewed, expectedHeadSha: input.headSha },
            });
            const state = viewed ? ("viewed" as const) : ("unviewed" as const);
            pullRequestFixtureStore.updateFilesViewed(number, (current) => ({
              ...current,
              files: current.files.map((file) => (file.path === path ? { ...file, state } : file)),
            }));
          },
        };
        // oxlint-disable-next-line react-hooks/exhaustive-deps
      }, [input.active, input.headSha, input.reference, number, version]);
    },
  };
}
