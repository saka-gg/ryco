import { Effect, Option } from "effect";
import {
  SourceControlProviderError,
  WS_METHODS,
  type ChangeRequest,
  type ChangeRequestCreateInput,
  type ChangeRequestUpdateAction,
} from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import {
  getChangeRequestHostCapabilities,
  type ChangeRequestHostRequest,
} from "@ryco/shared/sourceControl";

import {
  normalizeSourceBranch,
  parseSourceControlOwnerRef,
  requireChangeRequestCapability,
  unsupportedChangeRequestOperation,
  type OptionalChangeRequestOperation,
  type SourceControlProviderShape,
} from "../sourceControl/SourceControlProvider.ts";
import { withSourceControlBodyFile } from "../sourceControl/sourceControlBodyFile.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

/** Actions that change the head branch, review gate, or open state, so linked worktrees must re-sync. */
function isLifecycleChangingAction(action: ChangeRequestUpdateAction): boolean {
  switch (action.kind) {
    case "close":
    case "reopen":
    case "set-draft":
    case "update-branch":
    case "auto-merge":
    case "delete-branch":
      return true;
    case "edit":
      return action.baseRefName !== undefined;
    case "reviewers":
    case "labels":
    case "assignees":
      return false;
  }
}

/** Pick the change request `gh pr create` (or its peers) just opened for this head. */
export function selectCreatedChangeRequest(
  candidates: ReadonlyArray<ChangeRequest>,
  input: Pick<ChangeRequestCreateInput, "baseRefName" | "headRefName">,
): ChangeRequest | null {
  const owner = parseSourceControlOwnerRef(input.headRefName)?.owner?.toLowerCase() ?? null;
  const refName = normalizeSourceBranch(input.headRefName);
  const matching = candidates.filter(
    (candidate) =>
      candidate.headRefName === refName &&
      candidate.state === "open" &&
      (owner === null ||
        candidate.headRepositoryOwnerLogin?.toLowerCase() === owner ||
        candidate.headRepositoryNameWithOwner?.toLowerCase().startsWith(`${owner}/`) === true),
  );
  return (
    matching.find((candidate) => candidate.baseRefName === input.baseRefName) ??
    matching.toSorted((left, right) => right.number - left.number)[0] ??
    null
  );
}

export const makeSourceControlHandlers = (ctx: WsRpcContext) => {
  const {
    ownerEffect,
    sourceControlRepositories,
    sourceControlRegistry,
    refreshGitStatus,
    refreshLinkedWorktreeSourceControlStates,
    refreshStateForLinkedReference,
    createWorktreeForProject,
    callSourceControlWorkflowMethod,
    projectionSnapshotQuery,
    toGitManagerError,
  } = ctx;

  /**
   * Resolve the provider for `cwd`, failing fast (before the provider loads)
   * when the host capability matrix says it cannot serve `request`.
   */
  const resolveCapableProvider = (cwd: string, request: ChangeRequestHostRequest) =>
    sourceControlRegistry
      .resolve({ cwd })
      .pipe(Effect.tap((provider) => requireChangeRequestCapability(provider.kind, request)));

  /** Resolve a capable provider for `cwd` and call an optional change request method, failing clearly when absent. */
  const callOptionalChangeRequestMethod = <I, A>(
    cwd: string,
    request: ChangeRequestHostRequest & { readonly operation: OptionalChangeRequestOperation },
    select: (
      provider: SourceControlProviderShape,
    ) => ((input: I) => Effect.Effect<A, SourceControlProviderError>) | undefined,
    input: I,
  ) =>
    resolveCapableProvider(cwd, request).pipe(
      Effect.flatMap((provider) => {
        const method = select(provider);
        return method
          ? method(input)
          : unsupportedChangeRequestOperation(provider.kind, request.operation);
      }),
    );

  const refreshLinkedChangeRequest = (cwd: string, reference: string) =>
    refreshStateForLinkedReference({ cwd, kind: "pr", reference });

  const refreshChangeRequestLifecycle = (cwd: string, reference: string, reason: string) =>
    Effect.all(
      [
        refreshStateForLinkedReference({ cwd, kind: "pr", reference }),
        refreshLinkedWorktreeSourceControlStates({ cwd, reason, force: true }),
        refreshGitStatus(cwd),
      ],
      { concurrency: 3 },
    );

  return defineWsHandlers({
    [WS_METHODS.sourceControlLookupRepository]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlLookupRepository,
        ownerEffect(
          WS_METHODS.sourceControlLookupRepository,
          sourceControlRepositories.lookupRepository(input),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlSearchRepositories]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlSearchRepositories,
        ownerEffect(
          WS_METHODS.sourceControlSearchRepositories,
          sourceControlRepositories.searchRepositories(input),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlCloneRepository]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlCloneRepository,
        ownerEffect(
          WS_METHODS.sourceControlCloneRepository,
          sourceControlRepositories.cloneRepository(input),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlPublishRepository]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlPublishRepository,
        ownerEffect(
          WS_METHODS.sourceControlPublishRepository,
          sourceControlRepositories
            .publishRepository(input)
            .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlListIssues]: ({ cwd, state, limit }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlListIssues,
        ownerEffect(
          WS_METHODS.sourceControlListIssues,
          sourceControlRegistry.resolve({ cwd }).pipe(
            Effect.flatMap((provider) =>
              provider.listIssues({
                cwd,
                state,
                ...(limit !== undefined ? { limit } : {}),
              }),
            ),
            Effect.tap(() =>
              refreshLinkedWorktreeSourceControlStates({
                cwd,
                reason: "sourceControl.listIssues",
              }),
            ),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlGetIssue]: ({ cwd, reference, fullContent }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlGetIssue,
        ownerEffect(
          WS_METHODS.sourceControlGetIssue,
          sourceControlRegistry.resolve({ cwd }).pipe(
            Effect.flatMap((provider) =>
              provider.getIssue({
                cwd,
                reference,
                ...(fullContent !== undefined ? { fullContent } : {}),
              }),
            ),
            Effect.tap(() => refreshStateForLinkedReference({ cwd, kind: "issue", reference })),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlAddIssueComment]: ({ cwd, reference, body, clientMutationId }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlAddIssueComment,
        ownerEffect(
          WS_METHODS.sourceControlAddIssueComment,
          sourceControlRegistry.resolve({ cwd }).pipe(
            Effect.flatMap((provider) =>
              provider.addIssueComment({
                cwd,
                reference,
                body,
                ...(clientMutationId !== undefined ? { clientMutationId } : {}),
              }),
            ),
            Effect.map((detail) => ({ detail })),
            Effect.tap(() => refreshStateForLinkedReference({ cwd, kind: "issue", reference })),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlAddIssueCommentReaction]: ({ cwd, reference, commentId, content }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlAddIssueCommentReaction,
        ownerEffect(
          WS_METHODS.sourceControlAddIssueCommentReaction,
          sourceControlRegistry.resolve({ cwd }).pipe(
            Effect.flatMap((provider) =>
              provider.addIssueCommentReaction({
                cwd,
                reference,
                commentId,
                content,
              }),
            ),
            Effect.map((detail) => ({ detail })),
            Effect.tap(() => refreshStateForLinkedReference({ cwd, kind: "issue", reference })),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlSearchIssues]: ({ cwd, query, limit }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlSearchIssues,
        ownerEffect(
          WS_METHODS.sourceControlSearchIssues,
          sourceControlRegistry.resolve({ cwd }).pipe(
            Effect.flatMap((provider) =>
              provider.searchIssues({
                cwd,
                query,
                ...(limit !== undefined ? { limit } : {}),
              }),
            ),
            Effect.tap(() =>
              refreshLinkedWorktreeSourceControlStates({
                cwd,
                reason: "sourceControl.searchIssues",
              }),
            ),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlListChangeRequests]: ({ cwd, state, limit, query, involvement }) => {
      const trimmedQuery = query?.trim() ?? "";
      // Involvement is a server-side filtered list; a bare query is the host's search.
      const request: ChangeRequestHostRequest =
        involvement !== undefined
          ? { operation: "listChangeRequests", involvement, query: trimmedQuery }
          : trimmedQuery.length > 0
            ? { operation: "searchChangeRequests" }
            : { operation: "listChangeRequests" };
      return observeRpcEffect(
        WS_METHODS.sourceControlListChangeRequests,
        ownerEffect(
          WS_METHODS.sourceControlListChangeRequests,
          resolveCapableProvider(cwd, request).pipe(
            Effect.flatMap((provider) => {
              if (involvement !== undefined) {
                // Involvement is a server-side search: state and query combine with it.
                return provider.listChangeRequests({
                  cwd,
                  headSelector: "",
                  state,
                  involvement,
                  ...(trimmedQuery.length > 0 ? { query: trimmedQuery } : {}),
                  ...(limit !== undefined ? { limit } : {}),
                });
              }
              if (trimmedQuery.length > 0) {
                return provider.searchChangeRequests({
                  cwd,
                  query: trimmedQuery,
                  ...(limit !== undefined ? { limit } : {}),
                });
              }
              return provider.listChangeRequests({
                cwd,
                headSelector: "",
                state,
                ...(limit !== undefined ? { limit } : {}),
              });
            }),
            Effect.tap(() =>
              refreshLinkedWorktreeSourceControlStates({
                cwd,
                reason: "sourceControl.listChangeRequests",
              }),
            ),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      );
    },
    [WS_METHODS.sourceControlSearchChangeRequests]: ({ cwd, query, limit }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlSearchChangeRequests,
        ownerEffect(
          WS_METHODS.sourceControlSearchChangeRequests,
          resolveCapableProvider(cwd, { operation: "searchChangeRequests" }).pipe(
            Effect.flatMap((provider) =>
              provider.searchChangeRequests({
                cwd,
                query,
                ...(limit !== undefined ? { limit } : {}),
              }),
            ),
            Effect.tap(() =>
              refreshLinkedWorktreeSourceControlStates({
                cwd,
                reason: "sourceControl.searchChangeRequests",
              }),
            ),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlGetChangeRequestDetail]: ({ cwd, reference, fullContent }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlGetChangeRequestDetail,
        ownerEffect(
          WS_METHODS.sourceControlGetChangeRequestDetail,
          sourceControlRegistry.resolve({ cwd }).pipe(
            Effect.flatMap((provider) =>
              provider.getChangeRequestDetail({
                cwd,
                reference,
                ...(fullContent !== undefined ? { fullContent } : {}),
              }),
            ),
            Effect.tap(() => refreshStateForLinkedReference({ cwd, kind: "pr", reference })),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlAddChangeRequestComment]: ({
      cwd,
      reference,
      body,
      clientMutationId,
    }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlAddChangeRequestComment,
        ownerEffect(
          WS_METHODS.sourceControlAddChangeRequestComment,
          resolveCapableProvider(cwd, { operation: "addChangeRequestComment" }).pipe(
            Effect.flatMap((provider) =>
              provider.addChangeRequestComment({
                cwd,
                reference,
                body,
                ...(clientMutationId !== undefined ? { clientMutationId } : {}),
              }),
            ),
            Effect.map((detail) => ({ detail })),
            Effect.tap(() => refreshStateForLinkedReference({ cwd, kind: "pr", reference })),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlAddChangeRequestCommentReaction]: ({
      cwd,
      reference,
      commentId,
      content,
    }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlAddChangeRequestCommentReaction,
        ownerEffect(
          WS_METHODS.sourceControlAddChangeRequestCommentReaction,
          resolveCapableProvider(cwd, { operation: "addChangeRequestCommentReaction" }).pipe(
            Effect.flatMap((provider) =>
              provider.addChangeRequestCommentReaction({
                cwd,
                reference,
                commentId,
                content,
              }),
            ),
            Effect.map((detail) => ({ detail })),
            Effect.tap(() => refreshStateForLinkedReference({ cwd, kind: "pr", reference })),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlGetChangeRequestFilesViewed]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlGetChangeRequestFilesViewed,
        ownerEffect(
          WS_METHODS.sourceControlGetChangeRequestFilesViewed,
          sourceControlRegistry.resolve({ cwd: input.cwd }).pipe(
            Effect.flatMap((provider) =>
              provider.getChangeRequestFilesViewed &&
              getChangeRequestHostCapabilities(provider.kind).viewedFiles
                ? provider.getChangeRequestFilesViewed(input)
                : Effect.succeed({
                    provider: provider.kind,
                    capability: { storage: "unsupported" as const },
                    headSha: null,
                    files: [],
                  }),
            ),
          ),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlSetChangeRequestFileViewed]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlSetChangeRequestFileViewed,
        ownerEffect(
          WS_METHODS.sourceControlSetChangeRequestFileViewed,
          resolveCapableProvider(input.cwd, { operation: "setChangeRequestFileViewed" }).pipe(
            Effect.flatMap((provider) =>
              provider.setChangeRequestFileViewed
                ? provider.setChangeRequestFileViewed(input)
                : Effect.fail(
                    new SourceControlProviderError({
                      provider: provider.kind,
                      operation: "setChangeRequestFileViewed",
                      detail: "Viewed files are not supported by this provider.",
                    }),
                  ),
            ),
          ),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlGetChangeRequestDiff]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlGetChangeRequestDiff,
        ownerEffect(
          WS_METHODS.sourceControlGetChangeRequestDiff,
          resolveCapableProvider(input.cwd, {
            operation: "getChangeRequestDiff",
            commitSha: input.commitSha,
          }).pipe(
            Effect.flatMap((provider) =>
              provider.getChangeRequestDiff({
                cwd: input.cwd,
                reference: input.reference,
                ...(input.expectedHeadSha !== undefined
                  ? { expectedHeadSha: input.expectedHeadSha }
                  : {}),
                ...(input.commitSha !== undefined ? { commitSha: input.commitSha } : {}),
              }),
            ),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlMergeChangeRequest]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlMergeChangeRequest,
        ownerEffect(
          WS_METHODS.sourceControlMergeChangeRequest,
          callOptionalChangeRequestMethod(
            input.cwd,
            {
              operation: "mergeChangeRequest",
              mergeMethod: input.mergeMethod,
              deleteBranch: input.deleteBranch,
              expectedHeadSha: input.expectedHeadSha,
            },
            (provider) => provider.mergeChangeRequest,
            input,
          ).pipe(
            Effect.tap(() =>
              refreshChangeRequestLifecycle(
                input.cwd,
                input.reference,
                "sourceControl.mergeChangeRequest",
              ),
            ),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlGetChangeRequestActivity]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlGetChangeRequestActivity,
        ownerEffect(
          WS_METHODS.sourceControlGetChangeRequestActivity,
          callOptionalChangeRequestMethod(
            input.cwd,
            { operation: "getChangeRequestActivity" },
            (provider) => provider.getChangeRequestActivity,
            input,
          ),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlGetChangeRequestFileContents]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlGetChangeRequestFileContents,
        ownerEffect(
          WS_METHODS.sourceControlGetChangeRequestFileContents,
          callOptionalChangeRequestMethod(
            input.cwd,
            { operation: "getChangeRequestFileContents" },
            (provider) => provider.getChangeRequestFileContents,
            input,
          ),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlSubmitChangeRequestReview]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlSubmitChangeRequestReview,
        ownerEffect(
          WS_METHODS.sourceControlSubmitChangeRequestReview,
          callOptionalChangeRequestMethod(
            input.cwd,
            {
              operation: "submitChangeRequestReview",
              event: input.event,
              commentCount: input.comments.length,
            },
            (provider) => provider.submitChangeRequestReview,
            input,
          ).pipe(Effect.tap(() => refreshLinkedChangeRequest(input.cwd, input.reference))),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlReplyToReviewThread]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlReplyToReviewThread,
        ownerEffect(
          WS_METHODS.sourceControlReplyToReviewThread,
          callOptionalChangeRequestMethod(
            input.cwd,
            { operation: "replyToReviewThread" },
            (provider) => provider.replyToReviewThread,
            input,
          ).pipe(Effect.tap(() => refreshLinkedChangeRequest(input.cwd, input.reference))),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlSetReviewThreadResolved]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlSetReviewThreadResolved,
        ownerEffect(
          WS_METHODS.sourceControlSetReviewThreadResolved,
          callOptionalChangeRequestMethod(
            input.cwd,
            { operation: "setReviewThreadResolved" },
            (provider) => provider.setReviewThreadResolved,
            input,
          ).pipe(Effect.tap(() => refreshLinkedChangeRequest(input.cwd, input.reference))),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlUpdateChangeRequestComment]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlUpdateChangeRequestComment,
        ownerEffect(
          WS_METHODS.sourceControlUpdateChangeRequestComment,
          callOptionalChangeRequestMethod(
            input.cwd,
            { operation: "updateChangeRequestComment", action: input.action },
            (provider) => provider.updateChangeRequestComment,
            input,
          ).pipe(Effect.tap(() => refreshLinkedChangeRequest(input.cwd, input.reference))),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlUpdateChangeRequest]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlUpdateChangeRequest,
        ownerEffect(
          WS_METHODS.sourceControlUpdateChangeRequest,
          callOptionalChangeRequestMethod(
            input.cwd,
            {
              operation: "updateChangeRequest",
              action: input.action.kind,
              ...(input.action.kind === "update-branch"
                ? { updateBranchMethod: input.action.method }
                : {}),
            },
            (provider) => provider.updateChangeRequest,
            input,
          ).pipe(
            Effect.tap(() =>
              isLifecycleChangingAction(input.action)
                ? refreshChangeRequestLifecycle(
                    input.cwd,
                    input.reference,
                    "sourceControl.updateChangeRequest",
                  )
                : refreshLinkedChangeRequest(input.cwd, input.reference),
            ),
          ),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlCreateChangeRequest]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlCreateChangeRequest,
        ownerEffect(
          WS_METHODS.sourceControlCreateChangeRequest,
          Effect.gen(function* () {
            const provider = yield* resolveCapableProvider(input.cwd, {
              operation: "createChangeRequest",
              draft: input.draft,
            });
            yield* withSourceControlBodyFile(
              ctx.fileSystem,
              {
                provider: provider.kind,
                operation: "createChangeRequest",
                prefix: "ryco-change-request-body-",
                body: input.body,
              },
              (bodyFile) =>
                provider.createChangeRequest({
                  cwd: input.cwd,
                  baseRefName: input.baseRefName,
                  headSelector: input.headRefName,
                  title: input.title,
                  bodyFile,
                  ...(input.draft !== undefined ? { draft: input.draft } : {}),
                }),
            );
            const candidates = yield* provider.listChangeRequests({
              cwd: input.cwd,
              headSelector: normalizeSourceBranch(input.headRefName),
              state: "open",
              limit: 5,
              includeStackSummary: false,
            });
            const created = selectCreatedChangeRequest(candidates, input);
            if (!created) {
              return yield* new SourceControlProviderError({
                provider: provider.kind,
                operation: "createChangeRequest",
                detail:
                  "The change request was created, but it could not be found yet. Refresh the list to see it.",
              });
            }
            return created;
          }).pipe(
            Effect.tap(() =>
              Effect.all(
                [
                  refreshLinkedWorktreeSourceControlStates({
                    cwd: input.cwd,
                    reason: "sourceControl.createChangeRequest",
                    force: true,
                  }),
                  refreshGitStatus(input.cwd),
                ],
                { concurrency: 2 },
              ),
            ),
          ),
        ),
        { "rpc.aggregate": "source-control" },
      ),
    [WS_METHODS.sourceControlCreateIssue]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlCreateIssue,
        ownerEffect(
          WS_METHODS.sourceControlCreateIssue,
          Effect.gen(function* () {
            const provider = yield* sourceControlRegistry.resolve({ cwd: input.cwd });
            const issue = yield* provider.createIssue({
              cwd: input.cwd,
              title: input.title,
              body: input.body,
              ...(input.labels ? { labels: input.labels } : {}),
              ...(input.assignees ? { assignees: input.assignees } : {}),
            });

            if (!input.worktree?.enabled) {
              return { issue } as {
                readonly issue: typeof issue;
                readonly worktree?: undefined;
                readonly worktreeError?: undefined;
              };
            }

            const projectOpt = yield* projectionSnapshotQuery
              .getActiveProjectByWorkspaceRoot(input.cwd)
              .pipe(
                Effect.mapError((cause) =>
                  toGitManagerError(
                    WS_METHODS.sourceControlCreateIssue,
                    "Failed to resolve project for worktree creation.",
                    cause,
                  ),
                ),
              );
            if (Option.isNone(projectOpt)) {
              return {
                issue,
                worktreeError: `No project registered for workspace root '${input.cwd}'.`,
              };
            }
            const projectId = projectOpt.value.id;
            const worktreeBranchName = input.worktree.branchName;
            return yield* createWorktreeForProject({
              projectId,
              intent: {
                kind: "issue",
                number: issue.number,
                branchName: worktreeBranchName,
              },
            }).pipe(
              Effect.matchEffect({
                onSuccess: (worktree) => Effect.succeed({ issue, worktree }),
                onFailure: (error) =>
                  Effect.succeed({
                    issue,
                    worktreeError: error.message ?? "Failed to create worktree for issue.",
                  }),
              }),
            );
          }),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlListIssueLabels]: ({ cwd }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlListIssueLabels,
        ownerEffect(
          WS_METHODS.sourceControlListIssueLabels,
          sourceControlRegistry
            .resolve({ cwd })
            .pipe(Effect.flatMap((provider) => provider.listLabels({ cwd }))),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlListIssueAssignees]: ({ cwd }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlListIssueAssignees,
        ownerEffect(
          WS_METHODS.sourceControlListIssueAssignees,
          sourceControlRegistry
            .resolve({ cwd })
            .pipe(Effect.flatMap((provider) => provider.listAssignees({ cwd }))),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlListWorkflowRuns]: ({
      cwd,
      pullRequestNumber,
      commitSha,
      branch,
      limit,
    }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlListWorkflowRuns,
        ownerEffect(
          WS_METHODS.sourceControlListWorkflowRuns,
          callSourceControlWorkflowMethod({
            cwd,
            operation: "listWorkflowRuns",
            invoke: (provider) => {
              const method = provider.listWorkflowRuns;
              return method?.({
                cwd,
                ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
                ...(commitSha !== undefined ? { commitSha } : {}),
                ...(branch !== undefined ? { branch } : {}),
                ...(limit !== undefined ? { limit } : {}),
              });
            },
          }),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlGetWorkflowRunJobs]: ({ cwd, runId }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlGetWorkflowRunJobs,
        ownerEffect(
          WS_METHODS.sourceControlGetWorkflowRunJobs,
          callSourceControlWorkflowMethod({
            cwd,
            operation: "getWorkflowRunJobs",
            invoke: (provider) => {
              const method = provider.getWorkflowRunJobs;
              return method?.({ cwd, runId });
            },
          }),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlGetWorkflowJobLog]: ({ cwd, runId, jobId }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlGetWorkflowJobLog,
        ownerEffect(
          WS_METHODS.sourceControlGetWorkflowJobLog,
          callSourceControlWorkflowMethod({
            cwd,
            operation: "getWorkflowJobLog",
            invoke: (provider) => {
              const method = provider.getWorkflowJobLog;
              return method?.({ cwd, runId, jobId });
            },
          }),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
    [WS_METHODS.sourceControlRerunWorkflow]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlRerunWorkflow,
        ownerEffect(
          WS_METHODS.sourceControlRerunWorkflow,
          callSourceControlWorkflowMethod({
            cwd: input.cwd,
            operation: "rerunWorkflow",
            invoke: (provider) => {
              const method = provider.rerunWorkflow;
              return method?.(input);
            },
          }),
        ),
        {
          "rpc.aggregate": "source-control",
        },
      ),
  });
};
