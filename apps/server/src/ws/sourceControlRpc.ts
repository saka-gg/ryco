import { Effect, Option } from "effect";
import { SourceControlProviderError, WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

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
    [WS_METHODS.sourceControlListChangeRequests]: ({ cwd, state, limit, query }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlListChangeRequests,
        ownerEffect(
          WS_METHODS.sourceControlListChangeRequests,
          sourceControlRegistry.resolve({ cwd }).pipe(
            Effect.flatMap((provider) => {
              const trimmedQuery = query?.trim() ?? "";
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
      ),
    [WS_METHODS.sourceControlSearchChangeRequests]: ({ cwd, query, limit }) =>
      observeRpcEffect(
        WS_METHODS.sourceControlSearchChangeRequests,
        ownerEffect(
          WS_METHODS.sourceControlSearchChangeRequests,
          sourceControlRegistry.resolve({ cwd }).pipe(
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
          sourceControlRegistry.resolve({ cwd }).pipe(
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
          sourceControlRegistry.resolve({ cwd }).pipe(
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
              provider.getChangeRequestFilesViewed
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
          sourceControlRegistry.resolve({ cwd: input.cwd }).pipe(
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
          sourceControlRegistry
            .resolve({ cwd: input.cwd })
            .pipe(Effect.flatMap((provider) => provider.getChangeRequestDiff(input))),
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
          sourceControlRegistry.resolve({ cwd: input.cwd }).pipe(
            Effect.flatMap((provider) => {
              const mergeChangeRequest = provider.mergeChangeRequest;
              return mergeChangeRequest
                ? mergeChangeRequest(input)
                : Effect.fail(
                    new SourceControlProviderError({
                      provider: provider.kind,
                      operation: "mergeChangeRequest",
                      detail: "This source control provider does not support pull request merges.",
                    }),
                  );
            }),
            Effect.tap(() =>
              Effect.all(
                [
                  refreshStateForLinkedReference({
                    cwd: input.cwd,
                    kind: "pr",
                    reference: input.reference,
                  }),
                  refreshLinkedWorktreeSourceControlStates({
                    cwd: input.cwd,
                    reason: "sourceControl.mergeChangeRequest",
                    force: true,
                  }),
                  refreshGitStatus(input.cwd),
                ],
                { concurrency: 3 },
              ),
            ),
          ),
        ),
        {
          "rpc.aggregate": "source-control",
        },
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
