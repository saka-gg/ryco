import path from "node:path";

import { Duration, Effect, Option, Queue, Stream } from "effect";
import {
  type GitActionProgressEvent,
  type GitManagerServiceError,
  ProjectId,
  GitCommandError,
  WS_METHODS,
} from "@ryco/contracts";

import { buildWorktreeCheckoutDirectoryName } from "../project/worktreeCheckoutPaths.ts";
import { selectConfiguredWorktreeRoot } from "../project/worktreeRoot.ts";
import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
import { resolveProjectWorktreesDir } from "../project/projectMetadataPaths.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export const makeGitHandlers = (ctx: WsRpcContext) => {
  const {
    ownerEffect,
    ownerStream,
    gitWorkflow,
    vcsStatusBroadcaster,
    vcsProvisioning,
    refreshGitStatus,
    attachLinkedIssuesToPrAction,
    projectionWorktrees,
    projectionSnapshotQuery,
    dispatchWorktreeCommand,
    serverCommandId,
    toGitManagerError,
    createWorktreeForProject,
    archiveWorktree,
    restoreWorktree,
    deleteWorktree,
    initializeGitForProject,
    config,
    serverSettings,
  } = ctx;

  return defineWsHandlers({
    [WS_METHODS.subscribeVcsStatus]: (input) =>
      observeRpcStream(
        WS_METHODS.subscribeVcsStatus,
        ownerStream(
          WS_METHODS.subscribeVcsStatus,
          vcsStatusBroadcaster.streamStatus(input, {
            automaticRemoteRefreshInterval: Effect.succeed(
              Duration.millis(input.automaticRemoteRefreshIntervalMs ?? 0),
            ),
          }),
        ),
        {
          "rpc.aggregate": "vcs",
        },
      ),
    [WS_METHODS.vcsRefreshStatus]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsRefreshStatus,
        ownerEffect(WS_METHODS.vcsRefreshStatus, vcsStatusBroadcaster.refreshStatus(input.cwd)),
        {
          "rpc.aggregate": "vcs",
        },
      ),
    [WS_METHODS.vcsPull]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsPull,
        ownerEffect(
          WS_METHODS.vcsPull,
          gitWorkflow.pullCurrentBranch(input.cwd).pipe(
            Effect.matchCauseEffect({
              onFailure: (cause) => Effect.failCause(cause),
              onSuccess: (result) =>
                refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
            }),
          ),
        ),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitRunStackedAction]: (input) =>
      observeRpcStream(
        WS_METHODS.gitRunStackedAction,
        ownerStream(
          WS_METHODS.gitRunStackedAction,
          Stream.callback<GitActionProgressEvent, GitManagerServiceError>(
            (queue) =>
              attachLinkedIssuesToPrAction(input).pipe(
                Effect.flatMap((runInput) =>
                  gitWorkflow.runStackedAction(runInput, {
                    actionId: input.actionId,
                    progressReporter: {
                      publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                    },
                  }),
                ),
                Effect.matchCauseEffect({
                  onFailure: (cause) => Queue.failCause(queue, cause),
                  onSuccess: (result) =>
                    Effect.gen(function* () {
                      if (
                        input.worktreeId !== undefined &&
                        result.pr.number !== undefined &&
                        (result.pr.status === "created" || result.pr.status === "opened_existing")
                      ) {
                        const existing = yield* projectionWorktrees
                          .getById({
                            worktreeId: input.worktreeId,
                          })
                          .pipe(
                            Effect.mapError((cause) =>
                              toGitManagerError(
                                WS_METHODS.gitRunStackedAction,
                                "Failed to load worktree for pull request link update.",
                                cause,
                              ),
                            ),
                          );
                        if (Option.isSome(existing)) {
                          yield* dispatchWorktreeCommand(
                            {
                              type: "worktree.source-control-state.update",
                              commandId: serverCommandId("worktree-pr-link"),
                              worktreeId: input.worktreeId,
                              prNumber: result.pr.number,
                              prTitle: result.pr.title ?? existing.value.prTitle,
                              prState: "open",
                              prIsDraft: false,
                              issueState: existing.value.issueState ?? null,
                              updatedAt: new Date().toISOString(),
                            },
                            WS_METHODS.gitRunStackedAction,
                          );
                        }
                      }
                      yield* refreshGitStatus(input.cwd);
                      yield* Queue.end(queue).pipe(Effect.asVoid);
                    }),
                }),
              ),
            { bufferSize: 128, strategy: "suspend" },
          ),
        ),
        { "rpc.aggregate": "vcs" },
      ),
    [WS_METHODS.gitResolvePullRequest]: (input) =>
      observeRpcEffect(
        WS_METHODS.gitResolvePullRequest,
        ownerEffect(WS_METHODS.gitResolvePullRequest, gitWorkflow.resolvePullRequest(input)),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitPreparePullRequestThread]: (input) =>
      observeRpcEffect(
        WS_METHODS.gitPreparePullRequestThread,
        ownerEffect(
          WS_METHODS.gitPreparePullRequestThread,
          (input.projectId
            ? projectionSnapshotQuery.getProjectShellById(input.projectId)
            : projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.cwd)
          )
            .pipe(
              Effect.mapError((cause) =>
                toGitManagerError(
                  "git.preparePullRequestThread",
                  `Failed to load project ${input.projectId}.`,
                  cause,
                ),
              ),
              Effect.map(Option.getOrNull),
              Effect.flatMap((project) =>
                serverSettings.getSettings.pipe(
                  Effect.mapError((cause) =>
                    toGitManagerError(
                      "git.preparePullRequestThread",
                      "Failed to load worktree settings.",
                      cause,
                    ),
                  ),
                  Effect.map((settings) => ({
                    ...input,
                    worktreesDir:
                      input.worktreesDir ??
                      (input.worktreeLocation === "projectMetadata"
                        ? resolveProjectWorktreesDir(input.cwd, project?.projectMetadataDir)
                        : path.join(
                            selectConfiguredWorktreeRoot({
                              settings,
                              config,
                              projectId: project?.id ?? input.projectId,
                            }),
                            project?.id ?? input.projectId ?? ProjectId.make("project-unknown"),
                          )),
                  })),
                ),
              ),
              Effect.flatMap((normalizedInput) =>
                gitWorkflow.preparePullRequestThread(normalizedInput),
              ),
            )
            .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        ),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitCreateWorktreeForProject]: (input) =>
      observeRpcEffect(
        WS_METHODS.gitCreateWorktreeForProject,
        ownerEffect(WS_METHODS.gitCreateWorktreeForProject, createWorktreeForProject(input)),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitFindWorktreeForOrigin]: (input) =>
      observeRpcEffect(
        WS_METHODS.gitFindWorktreeForOrigin,
        ownerEffect(
          WS_METHODS.gitFindWorktreeForOrigin,
          (input.kind === "workItem"
            ? projectionWorktrees.findByWorkItem(input)
            : projectionWorktrees.findByOrigin(input)
          ).pipe(
            Effect.mapError((cause) =>
              toGitManagerError(
                "git.findWorktreeForOrigin",
                "Failed to find worktree for origin.",
                cause,
              ),
            ),
          ),
        ),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.gitArchiveWorktree]: (input) =>
      observeRpcEffect(
        WS_METHODS.gitArchiveWorktree,
        ownerEffect(WS_METHODS.gitArchiveWorktree, archiveWorktree(input)),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitRestoreWorktree]: (input) =>
      observeRpcEffect(
        WS_METHODS.gitRestoreWorktree,
        ownerEffect(WS_METHODS.gitRestoreWorktree, restoreWorktree(input.worktreeId)),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.gitDeleteWorktree]: (input) =>
      observeRpcEffect(
        WS_METHODS.gitDeleteWorktree,
        ownerEffect(WS_METHODS.gitDeleteWorktree, deleteWorktree(input)),
        {
          "rpc.aggregate": "git",
        },
      ),
    [WS_METHODS.worktreesSetManualPosition]: (input) =>
      observeRpcEffect(
        WS_METHODS.worktreesSetManualPosition,
        ownerEffect(
          WS_METHODS.worktreesSetManualPosition,
          dispatchWorktreeCommand(
            {
              type: "worktree.manual-position.set",
              commandId: serverCommandId("worktree-manual-position-set"),
              worktreeId: input.worktreeId,
              position: input.position,
              changedAt: new Date().toISOString(),
            },
            "worktrees.setManualPosition",
          ).pipe(Effect.as({})),
        ),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.projectsInitializeGit]: (input) =>
      observeRpcEffect(
        WS_METHODS.projectsInitializeGit,
        ownerEffect(WS_METHODS.projectsInitializeGit, initializeGitForProject(input.projectId)),
        { "rpc.aggregate": "git" },
      ),
    [WS_METHODS.vcsListRefs]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsListRefs,
        ownerEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input)),
        {
          "rpc.aggregate": "vcs",
        },
      ),
    [WS_METHODS.vcsCreateWorktree]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsCreateWorktree,
        ownerEffect(
          WS_METHODS.vcsCreateWorktree,
          Effect.gen(function* () {
            if (input.path !== null) return yield* gitWorkflow.createWorktree(input);
            const project = yield* projectionSnapshotQuery
              .getActiveProjectByWorkspaceRoot(input.cwd)
              .pipe(
                Effect.map(Option.getOrNull),
                Effect.mapError((cause) =>
                  toGitManagerError("git.createWorktree", "Failed to load project.", cause),
                ),
              );
            if (!project) return yield* gitWorkflow.createWorktree(input);
            const settings = yield* serverSettings.getSettings.pipe(
              Effect.mapError((cause) =>
                toGitManagerError("git.createWorktree", "Failed to load worktree settings.", cause),
              ),
            );
            return yield* gitWorkflow.createWorktree({
              ...input,
              path: path.join(
                selectConfiguredWorktreeRoot({ settings, config, projectId: project.id }),
                project.id,
                buildWorktreeCheckoutDirectoryName(input.newRefName ?? input.refName),
              ),
            });
          }).pipe(
            Effect.mapError((cause) =>
              cause._tag === "GitCommandError"
                ? cause
                : new GitCommandError({
                    operation: "git.createWorktree",
                    cwd: input.cwd,
                    command: "git worktree add",
                    detail: cause.message,
                    cause,
                  }),
            ),
            Effect.tap(() => refreshGitStatus(input.cwd)),
          ),
        ),
        { "rpc.aggregate": "vcs" },
      ),
    [WS_METHODS.vcsRemoveWorktree]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsRemoveWorktree,
        ownerEffect(
          WS_METHODS.vcsRemoveWorktree,
          gitWorkflow.removeWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        ),
        { "rpc.aggregate": "vcs" },
      ),
    [WS_METHODS.vcsCreateRef]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsCreateRef,
        ownerEffect(
          WS_METHODS.vcsCreateRef,
          gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        ),
        { "rpc.aggregate": "vcs" },
      ),
    [WS_METHODS.vcsSwitchRef]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsSwitchRef,
        ownerEffect(
          WS_METHODS.vcsSwitchRef,
          gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        ),
        { "rpc.aggregate": "vcs" },
      ),
    [WS_METHODS.vcsInit]: (input) =>
      observeRpcEffect(
        WS_METHODS.vcsInit,
        ownerEffect(
          WS_METHODS.vcsInit,
          vcsProvisioning.initRepository(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
        ),
        { "rpc.aggregate": "vcs" },
      ),
  });
};
