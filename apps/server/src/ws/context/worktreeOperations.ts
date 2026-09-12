import { existsSync } from "node:fs";
import path from "node:path";

import { Cause, Effect, Option } from "effect";
import {
  type CommandId,
  type GitCreateWorktreeForProjectInput,
  type GitManagerServiceError,
  type OrchestrationCommand,
  type OrchestrationDispatchCommandError,
  type ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { buildTemporaryWorktreeBranchName } from "@ryco/shared/git";

import type { ServerSettingsShape } from "../../serverSettings.ts";
import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import { resolveManagedWorktreesRoot, type ServerConfigShape } from "../../config.ts";
import type { GitWorkflowServiceShape } from "../../git/GitWorkflowService.ts";
import {
  canonicalizeFilesystemPath,
  generatedWorktreeTitle,
  isCaseSensitiveFileSystem,
  partitionReconcilableProjectRoots,
  planWorktreeReconciliation,
} from "../../git/worktreeReconciliation.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveProjectWorktreesDir } from "../../project/projectMetadataPaths.ts";
import type { ProjectSetupScriptRunnerShape } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { resolveWorktreeCheckoutPath } from "../../project/worktreeCheckoutPaths.ts";
import type { ProjectionWorktreeRepositoryShape } from "../../persistence/Services/ProjectionWorktrees.ts";
import { refreshWorktreeSourceControlState } from "../../sourceControl/refreshWorktreeSourceControlState.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import type { VcsProvisioningServiceShape } from "../../vcs/VcsProvisioningService.ts";
import type { WorkspaceAccessPolicyShape } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  buildIssueBranchNameFallback,
  buildIssueBranchNameMessage,
  buildWorkItemBranchNameFallback,
  buildWorkItemBranchNameMessage,
  ensureWorkItemBranchNameIncludesKey,
} from "./branchNaming.ts";
import {
  failGitWorkflow,
  ignoreAlreadyMissingGitResource,
  toGitManagerError,
} from "./gitErrors.ts";

const RECONCILIATION_THROTTLE_MS = 5 * 60 * 1000;

// Process-wide: the WS context is rebuilt per connection, but the on-disk state
// this sweep inspects is shared by all of them.
let lastReconciliationAtMs = 0;
const missingProjectRoots = new Set<ProjectId>();

type AppendSetupScriptActivity = (input: {
  readonly threadId: ThreadId;
  readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
  readonly summary: string;
  readonly createdAt: string;
  readonly payload: Record<string, unknown>;
  readonly tone: "info" | "error";
}) => Effect.Effect<unknown, OrchestrationDispatchError>;

export const makeWorktreeOperations = (deps: {
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly projectionWorktrees: ProjectionWorktreeRepositoryShape;
  readonly gitWorkflow: GitWorkflowServiceShape;
  readonly vcsProvisioning: VcsProvisioningServiceShape;
  readonly config: ServerConfigShape;
  readonly serverSettings: ServerSettingsShape;
  readonly workspaceAccessPolicy: WorkspaceAccessPolicyShape;
  readonly textGeneration: TextGenerationShape;
  readonly projectSetupScriptRunner: ProjectSetupScriptRunnerShape;
  readonly serverCommandId: (tag: string) => CommandId;
  readonly dispatchNormalizedCommand: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
  readonly refreshGitStatus: (cwd: string) => Effect.Effect<void>;
  readonly appendSetupScriptActivity: AppendSetupScriptActivity;
}) => {
  const {
    projectionSnapshotQuery,
    projectionWorktrees,
    gitWorkflow,
    vcsProvisioning,
    config,
    serverSettings,
    workspaceAccessPolicy,
    textGeneration,
    projectSetupScriptRunner,
    serverCommandId,
    dispatchNormalizedCommand,
    refreshGitStatus,
    appendSetupScriptActivity,
  } = deps;
  const appWorktreesRoot = resolveManagedWorktreesRoot(config);

  const authorizeWorktreePath = (operation: string, candidate: string, existing: boolean) =>
    (existing
      ? workspaceAccessPolicy.assertExistingPath({ path: candidate, operation })
      : workspaceAccessPolicy.assertPath({ path: candidate, operation })
    ).pipe(Effect.mapError((cause) => toGitManagerError(operation, cause.message, cause)));

  const loadProjectForGitWorkflow = (operation: string, projectId: ProjectId) =>
    projectionSnapshotQuery.getProjectShellById(projectId).pipe(
      Effect.mapError((cause) =>
        toGitManagerError(operation, `Failed to load project ${projectId}.`, cause),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => failGitWorkflow(operation, `Project ${projectId} not found.`),
          onSome: Effect.succeed,
        }),
      ),
    );

  const loadWorktreeForGitWorkflow = (operation: string, worktreeId: WorktreeId) =>
    projectionWorktrees.getById({ worktreeId }).pipe(
      Effect.mapError((cause) =>
        toGitManagerError(operation, `Failed to load worktree ${worktreeId}.`, cause),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => failGitWorkflow(operation, `Worktree ${worktreeId} not found.`),
          onSome: Effect.succeed,
        }),
      ),
    );

  const isProjectRootPath = (candidate: string, projectRoot: string): boolean => {
    const normalize = (value: string) => {
      const resolved = path.resolve(value).replace(/[\\/]+$/g, "");
      return process.platform === "win32" || process.platform === "darwin"
        ? resolved.toLowerCase()
        : resolved;
    };
    return normalize(candidate) === normalize(projectRoot);
  };

  const dispatchWorktreeCommand = (
    command: OrchestrationCommand,
    operation: string,
  ): Effect.Effect<void, GitManagerServiceError> =>
    dispatchNormalizedCommand(command).pipe(
      Effect.mapError((cause) =>
        toGitManagerError(operation, "Failed to dispatch orchestration command.", cause),
      ),
      Effect.asVoid,
    );

  const launchSetupScriptForWorktreeInBackground = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly projectCwd: string;
    readonly worktreePath: string;
  }) =>
    Effect.gen(function* () {
      const requestedAt = new Date().toISOString();
      yield* projectSetupScriptRunner
        .runForThread({
          threadId: input.threadId,
          projectId: input.projectId,
          projectCwd: input.projectCwd,
          worktreePath: input.worktreePath,
        })
        .pipe(
          Effect.matchEffect({
            onFailure: (error) => {
              const detail = error instanceof Error ? error.message : "Unknown setup failure.";
              return appendSetupScriptActivity({
                threadId: input.threadId,
                kind: "setup-script.failed",
                summary: "Setup script failed to start",
                createdAt: requestedAt,
                payload: {
                  detail,
                  worktreePath: input.worktreePath,
                },
                tone: "error",
              }).pipe(
                Effect.ignoreCause({ log: false }),
                Effect.flatMap(() =>
                  Effect.logWarning("worktree setup script failed to start", {
                    threadId: input.threadId,
                    worktreePath: input.worktreePath,
                    detail,
                  }),
                ),
              );
            },
            onSuccess: (setupResult) => {
              if (setupResult.status !== "started") {
                return Effect.void;
              }
              const payload = {
                scriptId: setupResult.scriptId,
                scriptName: setupResult.scriptName,
                terminalId: setupResult.terminalId,
                worktreePath: input.worktreePath,
              };
              return Effect.all([
                appendSetupScriptActivity({
                  threadId: input.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: input.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: new Date().toISOString(),
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "worktree setup script started but setup activity recording failed",
                    {
                      threadId: input.threadId,
                      worktreePath: input.worktreePath,
                      detail: error.message,
                    },
                  ),
                ),
              );
            },
          }),
        );
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

  const createWorktreeForProject = (input: GitCreateWorktreeForProjectInput) =>
    Effect.gen(function* () {
      const operation = "git.createWorktreeForProject";
      if (
        input.intent.kind === "pr" ||
        input.intent.kind === "issue" ||
        input.intent.kind === "workItem"
      ) {
        const existing =
          input.intent.kind === "workItem"
            ? yield* projectionWorktrees
                .findByWorkItem({
                  projectId: input.projectId,
                  provider: input.intent.provider,
                  key: input.intent.key,
                })
                .pipe(
                  Effect.mapError((cause) =>
                    toGitManagerError(operation, "Failed to find existing worktree.", cause),
                  ),
                )
            : yield* projectionWorktrees
                .findByOrigin({
                  projectId: input.projectId,
                  kind: input.intent.kind,
                  number: input.intent.number ?? 0,
                })
                .pipe(
                  Effect.mapError((cause) =>
                    toGitManagerError(operation, "Failed to find existing worktree.", cause),
                  ),
                );
        if (existing !== null) {
          const existingWorktree = yield* loadWorktreeForGitWorkflow(operation, existing);
          const project = yield* loadProjectForGitWorkflow(operation, input.projectId);
          const modelSelection = project.defaultModelSelection;
          if (modelSelection === null) {
            return yield* failGitWorkflow(
              operation,
              `Project ${input.projectId} has no default model selection.`,
            );
          }
          const now = new Date().toISOString();
          const threadId = ThreadId.make(`thread-${crypto.randomUUID()}`);
          yield* dispatchWorktreeCommand(
            {
              type: "thread.create",
              commandId: serverCommandId("worktree-thread-create"),
              threadId,
              projectId: input.projectId,
              title:
                existingWorktree.workItemTitle ??
                existingWorktree.prTitle ??
                existingWorktree.issueTitle ??
                existingWorktree.branch,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: existingWorktree.branch,
              worktreePath: existingWorktree.worktreePath,
              createdAt: now,
            },
            operation,
          );
          yield* dispatchWorktreeCommand(
            {
              type: "thread.attach-to-worktree",
              commandId: serverCommandId("worktree-thread-attach"),
              threadId,
              worktreeId: existing,
              attachedAt: now,
            },
            operation,
          );
          return { worktreeId: existing, sessionId: threadId };
        }
      }

      const project = yield* loadProjectForGitWorkflow(operation, input.projectId);
      const { worktreeBranchPrefix } = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) =>
          toGitManagerError(operation, "Failed to load server settings.", cause),
        ),
      );
      const modelSelection = project.defaultModelSelection;
      if (modelSelection === null) {
        return yield* failGitWorkflow(
          operation,
          `Project ${input.projectId} has no default model selection.`,
        );
      }

      const now = new Date().toISOString();
      const worktreeId = WorktreeId.make(`worktree-${crypto.randomUUID()}`);
      const threadId = ThreadId.make(`thread-${crypto.randomUUID()}`);
      let branch: string;
      let refName: string;
      let newRefName: string | undefined;
      let title: string;
      let origin: "branch" | "pr" | "issue" | "manual" = "branch";
      let prNumber: number | null = null;
      let issueNumber: number | null = null;
      let prTitle: string | null = null;
      let issueTitle: string | null = null;
      let workItemProvider: "jira" | null = null;
      let workItemKey: string | null = null;
      let workItemTitle: string | null = null;
      let workItemState: "open" | "in_progress" | "done" | "closed" | "unknown" | null = null;
      let workItemStateName: string | null = null;
      let workItemUrl: string | null = null;
      let preparedWorktreePath: string | null = null;
      let ownedWorktreePath: string | null = null;
      let ownedBranchName: string | null = null;

      if (input.fetchOrigin && input.intent.kind === "pr") {
        yield* gitWorkflow.listRefs({ cwd: project.workspaceRoot, fetchOrigin: true, limit: 1 });
      }
      switch (input.intent.kind) {
        case "branch":
          refName = input.intent.branchName;
          branch = buildTemporaryWorktreeBranchName(worktreeBranchPrefix);
          newRefName = branch;
          title = refName;
          break;
        case "newBranch":
          branch =
            input.intent.branchName ?? buildTemporaryWorktreeBranchName(worktreeBranchPrefix);
          refName = input.intent.baseBranch ?? (input.fetchOrigin ? "origin/HEAD" : "HEAD");
          newRefName = branch;
          title = branch;
          break;
        case "pr": {
          const number = input.intent.number ?? 0;
          const [existingWorktreePaths, existingBranchNames] = yield* Effect.all(
            [
              gitWorkflow.listWorktreePaths(project.workspaceRoot),
              gitWorkflow.listLocalBranchNames(project.workspaceRoot),
            ],
            { concurrency: 2 },
          );
          const prepared = yield* gitWorkflow.preparePullRequestThread({
            cwd: project.workspaceRoot,
            reference: String(number),
            mode: "worktree",
            projectId: input.projectId,
            worktreeLocation: input.worktreeLocation,
            worktreesDir:
              input.worktreeLocation === "projectMetadata"
                ? resolveProjectWorktreesDir(project.workspaceRoot, project.projectMetadataDir)
                : path.join(appWorktreesRoot, input.projectId),
          });
          if (prepared.worktreePath === null) {
            return yield* failGitWorkflow(
              operation,
              `Failed to create worktree for PR #${number}.`,
            );
          }
          preparedWorktreePath = yield* authorizeWorktreePath(
            operation,
            prepared.worktreePath,
            true,
          );
          branch = prepared.branch;
          if (!existingWorktreePaths.includes(prepared.worktreePath)) {
            ownedWorktreePath = preparedWorktreePath;
          }
          if (!existingBranchNames.includes(prepared.branch)) {
            ownedBranchName = prepared.branch;
          }
          refName = branch;
          title = prepared.pullRequest.title;
          origin = "pr";
          prNumber = prepared.pullRequest.number;
          prTitle = prepared.pullRequest.title;
          break;
        }
        case "issue": {
          const number = input.intent.number ?? 0;
          const generatedBranchFallback = buildIssueBranchNameFallback(number);
          branch =
            input.intent.branchName ??
            (yield* textGeneration
              .generateBranchName({
                cwd: project.workspaceRoot,
                message: buildIssueBranchNameMessage({
                  number,
                  title: input.intent.title,
                  body: input.intent.body,
                }),
                modelSelection,
              })
              .pipe(
                Effect.map(({ branch: generatedBranch }) => {
                  const trimmedBranch = generatedBranch.trim();
                  return trimmedBranch.length > 0 ? trimmedBranch : generatedBranchFallback;
                }),
                Effect.catch(() => Effect.succeed(generatedBranchFallback)),
              ));
          refName = input.intent.baseBranch ?? (input.fetchOrigin ? "origin/HEAD" : "HEAD");
          newRefName = branch;
          title = input.intent.title?.trim() || `Issue #${number}`;
          origin = "issue";
          issueNumber = number;
          issueTitle = title;
          break;
        }
        case "workItem": {
          const key = input.intent.key.trim().toUpperCase();
          const generatedBranchFallback = buildWorkItemBranchNameFallback({
            key,
            title: input.intent.title,
          });
          if (input.intent.branchSource === "existing") {
            const existingBranch = input.intent.branchName?.trim();
            if (!existingBranch) {
              return yield* failGitWorkflow(
                operation,
                `Select an existing branch for Jira work item ${key}.`,
              );
            }
            branch = existingBranch;
            refName = existingBranch;
          } else {
            const requestedBranch =
              input.intent.branchName ??
              (yield* textGeneration
                .generateBranchName({
                  cwd: project.workspaceRoot,
                  message: buildWorkItemBranchNameMessage({
                    key,
                    title: input.intent.title,
                    body: input.intent.body,
                  }),
                  modelSelection,
                })
                .pipe(
                  Effect.map(({ branch: generatedBranch }) => generatedBranch),
                  Effect.catch(() => Effect.succeed(generatedBranchFallback)),
                ));
            branch = ensureWorkItemBranchNameIncludesKey({
              branch: requestedBranch,
              fallback: generatedBranchFallback,
              key,
            });
            refName = input.intent.baseBranch ?? (input.fetchOrigin ? "origin/HEAD" : "HEAD");
            newRefName = branch;
          }
          title = input.intent.title.trim();
          origin = "issue";
          workItemProvider = input.intent.provider;
          workItemKey = key;
          workItemTitle = title;
          workItemState = input.intent.state ?? null;
          workItemStateName = input.intent.stateName ?? null;
          workItemUrl = input.intent.url ?? null;
          break;
        }
      }

      let worktreePath: string;
      if (preparedWorktreePath !== null) {
        if (isProjectRootPath(preparedWorktreePath, project.workspaceRoot)) {
          return yield* failGitWorkflow(operation, "Cannot create a worktree at the project root.");
        }
        worktreePath = preparedWorktreePath;
      } else {
        const targetPath = resolveWorktreeCheckoutPath({
          location: input.worktreeLocation,
          appWorktreesRoot,
          projectId: input.projectId,
          workspaceRoot: project.workspaceRoot,
          projectMetadataDir: project.projectMetadataDir,
          branchName: branch,
        });
        if (isProjectRootPath(targetPath, project.workspaceRoot)) {
          return yield* failGitWorkflow(operation, "Cannot create a worktree at the project root.");
        }
        const authorizedTargetPath = yield* authorizeWorktreePath(operation, targetPath, false);
        worktreePath = (yield* gitWorkflow.createWorktree({
          fetchOrigin: input.fetchOrigin,
          cwd: project.workspaceRoot,
          refName,
          ...(newRefName !== undefined ? { newRefName } : {}),
          path: authorizedTargetPath,
        })).worktree.path;
        worktreePath = yield* authorizeWorktreePath(operation, worktreePath, true);
        if (isProjectRootPath(worktreePath, project.workspaceRoot)) {
          return yield* failGitWorkflow(
            operation,
            "Refusing to register a worktree that resolved to the project root.",
          );
        }
        ownedWorktreePath = worktreePath;
        if (newRefName !== undefined) {
          ownedBranchName = newRefName;
        }
      }

      const cleanupOwnedCheckout = Effect.gen(function* () {
        if (ownedWorktreePath !== null) {
          yield* ignoreAlreadyMissingGitResource(
            gitWorkflow.removeWorktree({
              cwd: project.workspaceRoot,
              path: ownedWorktreePath,
              force: true,
            }),
            {
              operation,
              action: "remove-worktree",
              target: ownedWorktreePath,
            },
          );
        }
        if (ownedBranchName !== null) {
          yield* ignoreAlreadyMissingGitResource(
            gitWorkflow.deleteBranch({
              cwd: project.workspaceRoot,
              refName: ownedBranchName,
              force: true,
            }),
            {
              operation,
              action: "delete-branch",
              target: ownedBranchName,
            },
          );
        }
      }).pipe(
        Effect.catch((cleanupError) =>
          Effect.logWarning("failed to clean up worktree creation after dispatch failure", {
            operation,
            worktreePath: ownedWorktreePath,
            branch: ownedBranchName,
            detail: cleanupError.message,
          }).pipe(Effect.asVoid),
        ),
      );

      yield* Effect.gen(function* () {
        yield* dispatchWorktreeCommand(
          {
            type: "worktree.create",
            commandId: serverCommandId("worktree-create"),
            worktreeId,
            projectId: input.projectId,
            branch,
            worktreePath,
            origin,
            prNumber,
            issueNumber,
            prTitle,
            issueTitle,
            workItemProvider,
            workItemKey,
            workItemTitle,
            workItemState,
            workItemStateName,
            workItemUrl,
            createdAt: now,
          },
          operation,
        );

        if (origin === "pr" || issueNumber !== null) {
          yield* refreshWorktreeSourceControlState({ worktreeId }).pipe(
            Effect.ignoreCause({ log: true }),
            Effect.forkDetach,
            Effect.asVoid,
          );
        }

        yield* dispatchWorktreeCommand(
          {
            type: "thread.create",
            commandId: serverCommandId("worktree-thread-create"),
            threadId,
            projectId: input.projectId,
            title,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch,
            worktreePath,
            createdAt: now,
          },
          operation,
        );

        yield* dispatchWorktreeCommand(
          {
            type: "thread.attach-to-worktree",
            commandId: serverCommandId("worktree-thread-attach"),
            threadId,
            worktreeId,
            attachedAt: now,
          },
          operation,
        );

        yield* launchSetupScriptForWorktreeInBackground({
          threadId,
          projectId: input.projectId,
          projectCwd: project.workspaceRoot,
          worktreePath,
        });
        yield* refreshGitStatus(worktreePath);
      }).pipe(
        Effect.catch((error) => cleanupOwnedCheckout.pipe(Effect.andThen(Effect.fail(error)))),
      );
      return { worktreeId, sessionId: threadId };
    });

  /**
   * Realigns a project's worktree rows with what git reports on disk.
   *
   * Sessions record the directory they ran in independently of the worktree
   * rows, so the two drift whenever a worktree is removed outside Ryco or a
   * directory is reached through another spelling of the same path. Without
   * this pass the sidebar renders those sessions under a phantom worktree node
   * named after their branch — a second "main" that no worktree backs.
   */
  const reconcileProjectWorktrees = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const operation = "git.reconcileProjectWorktrees";
      const project = yield* loadProjectForGitWorkflow(operation, projectId);
      const gitWorktreePaths = yield* gitWorkflow
        .listWorktreePaths(project.workspaceRoot)
        .pipe(
          Effect.mapError((cause) =>
            toGitManagerError(operation, "Failed to inspect git worktrees.", cause),
          ),
        );
      const snapshot = yield* projectionSnapshotQuery
        .getShellSnapshot()
        .pipe(
          Effect.mapError((cause) =>
            toGitManagerError(operation, "Failed to load project sessions.", cause),
          ),
        );
      const { worktreeBranchPrefix } = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) =>
          toGitManagerError(operation, "Failed to load server settings.", cause),
        ),
      );
      for (const worktree of snapshot.worktrees ?? []) {
        if (
          worktree.projectId !== projectId ||
          worktree.archivedAt !== null ||
          worktree.title == null
        )
          continue;
        const title = generatedWorktreeTitle({ ...worktree, worktreeBranchPrefix });
        if (title === null || title === worktree.title) continue;
        yield* dispatchWorktreeCommand(
          {
            type: "worktree.meta.update",
            commandId: serverCommandId("worktree-reconcile-generated-title"),
            worktreeId: worktree.worktreeId,
            title,
            changedAt: new Date().toISOString(),
          },
          operation,
        );
      }
      const plan = planWorktreeReconciliation({
        worktreeBranchPrefix,
        canonicalizePath: canonicalizeFilesystemPath,
        caseSensitiveFileSystem: isCaseSensitiveFileSystem(),
        gitWorktreePaths,
        project: { id: project.id, workspaceRoot: project.workspaceRoot },
        threads: snapshot.threads,
        worktrees: snapshot.worktrees ?? [],
      });
      if (plan.adopt.length === 0 && plan.attach.length === 0 && plan.detach.length === 0) {
        return;
      }

      const now = new Date().toISOString();
      for (const adoption of plan.adopt) {
        // Restricted workspaces must not gain rows for directories outside the
        // configured root; leave those sessions as they are.
        const authorized = yield* authorizeWorktreePath(
          operation,
          adoption.worktreePath,
          true,
        ).pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
        if (!authorized) {
          continue;
        }
        const worktreeId = WorktreeId.make(`worktree-${crypto.randomUUID()}`);
        yield* dispatchWorktreeCommand(
          {
            type: "worktree.create",
            commandId: serverCommandId("worktree-reconcile-adopt"),
            worktreeId,
            projectId: project.id,
            branch: adoption.branch,
            worktreePath: adoption.worktreePath,
            origin: "manual",
            prNumber: null,
            issueNumber: null,
            prTitle: null,
            issueTitle: null,
            createdAt: now,
          },
          operation,
        );
        // A worktree checked out on `main` would otherwise render beside the
        // project root under the same name; the directory name disambiguates.
        yield* dispatchWorktreeCommand(
          {
            type: "worktree.meta.update",
            commandId: serverCommandId("worktree-reconcile-title"),
            worktreeId,
            title: adoption.title,
            changedAt: now,
          },
          operation,
        );
        for (const threadId of adoption.threadIds) {
          yield* dispatchWorktreeCommand(
            {
              type: "thread.attach-to-worktree",
              commandId: serverCommandId("worktree-reconcile-attach"),
              threadId,
              worktreeId,
              attachedAt: now,
            },
            operation,
          );
        }
      }

      for (const attachment of plan.attach) {
        yield* dispatchWorktreeCommand(
          {
            type: "thread.attach-to-worktree",
            commandId: serverCommandId("worktree-reconcile-attach"),
            threadId: attachment.threadId,
            worktreeId: attachment.worktreeId,
            attachedAt: now,
          },
          operation,
        );
      }

      for (const threadId of plan.detach) {
        yield* dispatchWorktreeCommand(
          {
            type: "thread.meta.update",
            commandId: serverCommandId("worktree-reconcile-detach"),
            threadId,
            worktreePath: null,
          },
          operation,
        );
      }

      yield* Effect.logInfo("worktree reconciliation applied", {
        projectId: project.id,
        adopted: plan.adopt.length,
        attached: plan.attach.length,
        detached: plan.detach.length,
      });
    });

  /**
   * Best-effort reconciliation across every active project, throttled per
   * process so a reconnect loop cannot turn into a `git worktree list` storm.
   */
  const reconcileAllWorktrees = Effect.gen(function* () {
    const nowMs = Date.now();
    if (nowMs - lastReconciliationAtMs < RECONCILIATION_THROTTLE_MS) {
      return;
    }
    lastReconciliationAtMs = nowMs;

    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const roots = partitionReconcilableProjectRoots(snapshot.projects, existsSync);
    const currentProjectIds = new Set(snapshot.projects.map((project) => project.id));
    const availableProjectIds = new Set(roots.available.map((project) => project.id));
    const resumedProjectIds: ProjectId[] = [];
    for (const trackedProjectId of missingProjectRoots) {
      if (!currentProjectIds.has(trackedProjectId)) {
        missingProjectRoots.delete(trackedProjectId);
        continue;
      }
      if (availableProjectIds.has(trackedProjectId)) {
        missingProjectRoots.delete(trackedProjectId);
        resumedProjectIds.push(trackedProjectId);
      }
    }
    if (resumedProjectIds.length > 0) {
      yield* Effect.logInfo("worktree reconciliation resumed after project roots returned", {
        projectCount: resumedProjectIds.length,
        projectIds: resumedProjectIds,
      });
    }
    const newlyMissingProjectIds = roots.missing
      .filter((project) => !missingProjectRoots.has(project.id))
      .map((project) => project.id);
    for (const projectId of newlyMissingProjectIds) missingProjectRoots.add(projectId);
    if (newlyMissingProjectIds.length > 0) {
      yield* Effect.logWarning("worktree reconciliation skipped missing project roots", {
        projectCount: newlyMissingProjectIds.length,
        projectIds: newlyMissingProjectIds,
        historyPreserved: true,
      });
    }
    yield* Effect.forEach(
      roots.available,
      (project) =>
        reconcileProjectWorktrees(project.id).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("worktree reconciliation failed", {
              projectId: project.id,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  const archiveWorktree = (input: {
    readonly worktreeId: WorktreeId;
    readonly deleteBranch: boolean;
  }) =>
    Effect.gen(function* () {
      const operation = "git.archiveWorktree";
      const worktree = yield* loadWorktreeForGitWorkflow(operation, input.worktreeId);
      if (worktree.origin === "main") {
        return yield* failGitWorkflow(operation, "Cannot archive the main worktree.");
      }
      const project = yield* loadProjectForGitWorkflow(operation, worktree.projectId);
      if (worktree.worktreePath !== null) {
        yield* ignoreAlreadyMissingGitResource(
          gitWorkflow.removeWorktree({
            cwd: project.workspaceRoot,
            path: worktree.worktreePath,
            force: true,
          }),
          {
            operation,
            action: "remove-worktree",
            target: worktree.worktreePath,
          },
        );
      }
      if (input.deleteBranch) {
        yield* ignoreAlreadyMissingGitResource(
          gitWorkflow.deleteBranch({
            cwd: project.workspaceRoot,
            refName: worktree.branch,
            force: true,
          }),
          {
            operation,
            action: "delete-branch",
            target: worktree.branch,
          },
        );
      }
      yield* dispatchWorktreeCommand(
        {
          type: "worktree.archive",
          commandId: serverCommandId("worktree-archive"),
          worktreeId: input.worktreeId,
          archivedAt: new Date().toISOString(),
          deletedBranch: input.deleteBranch,
        },
        operation,
      );
      yield* refreshGitStatus(project.workspaceRoot);
      return {};
    });

  const restoreWorktree = (worktreeId: WorktreeId) =>
    Effect.gen(function* () {
      const operation = "git.restoreWorktree";
      const worktree = yield* loadWorktreeForGitWorkflow(operation, worktreeId);
      const project = yield* loadProjectForGitWorkflow(operation, worktree.projectId);
      const created =
        worktree.origin === "main"
          ? null
          : yield* gitWorkflow.createWorktree({
              cwd: project.workspaceRoot,
              refName: worktree.branch,
              path: worktree.worktreePath,
            });
      const restoredPath = created?.worktree.path ?? worktree.worktreePath;
      yield* dispatchWorktreeCommand(
        {
          type: "worktree.restore",
          commandId: serverCommandId("worktree-restore"),
          worktreeId,
          worktreePath: restoredPath,
          restoredAt: new Date().toISOString(),
        },
        operation,
      );
      yield* refreshGitStatus(restoredPath ?? project.workspaceRoot);
      return {};
    });

  const deleteWorktree = (input: {
    readonly worktreeId: WorktreeId;
    readonly deleteBranch: boolean;
    readonly force?: boolean | undefined;
  }) =>
    Effect.gen(function* () {
      const operation = "git.deleteWorktree";
      const worktree = yield* loadWorktreeForGitWorkflow(operation, input.worktreeId);
      if (worktree.origin === "main") {
        return yield* failGitWorkflow(operation, "Cannot delete the main worktree.");
      }
      const project = yield* loadProjectForGitWorkflow(operation, worktree.projectId);
      if (
        worktree.worktreePath !== null &&
        isProjectRootPath(worktree.worktreePath, project.workspaceRoot)
      ) {
        return yield* failGitWorkflow(
          operation,
          "Cannot delete a worktree that points at the project root.",
        );
      }
      if (input.force) {
        if (worktree.worktreePath !== null) {
          if (existsSync(worktree.worktreePath)) {
            return yield* failGitWorkflow(
              operation,
              "Cannot force delete: the worktree path still exists on disk. Use a regular delete instead.",
            );
          }
          const registeredPaths = yield* gitWorkflow
            .listWorktreePaths(project.workspaceRoot)
            .pipe(
              Effect.mapError((cause) =>
                toGitManagerError(operation, "Failed to inspect git worktrees.", cause),
              ),
            );
          if (registeredPaths.includes(worktree.worktreePath)) {
            return yield* failGitWorkflow(
              operation,
              "Cannot force delete: git still tracks this worktree. Use a regular delete instead.",
            );
          }
        }
      } else if (worktree.worktreePath !== null) {
        if (existsSync(worktree.worktreePath)) {
          yield* ignoreAlreadyMissingGitResource(
            gitWorkflow.removeWorktree({
              cwd: project.workspaceRoot,
              path: worktree.worktreePath,
              force: true,
            }),
            {
              operation,
              action: "remove-worktree",
              target: worktree.worktreePath,
            },
          );
        }
      }
      if (input.deleteBranch) {
        yield* ignoreAlreadyMissingGitResource(
          gitWorkflow.deleteBranch({
            cwd: project.workspaceRoot,
            refName: worktree.branch,
            force: true,
          }),
          {
            operation,
            action: "delete-branch",
            target: worktree.branch,
          },
        );
      }
      yield* dispatchWorktreeCommand(
        {
          type: "worktree.delete",
          commandId: serverCommandId("worktree-delete"),
          worktreeId: input.worktreeId,
          deletedAt: new Date().toISOString(),
          deletedBranch: input.deleteBranch,
        },
        operation,
      );
      // Sessions recorded under a different spelling of the removed directory
      // survive the delete cascade; fold them back into the project root rather
      // than leaving a worktree node with nothing behind it.
      yield* reconcileProjectWorktrees(project.id).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("worktree reconciliation after delete failed", {
            projectId: project.id,
            cause,
          }),
        ),
      );
      yield* refreshGitStatus(project.workspaceRoot);
      return {};
    });

  const initializeGitForProject = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const operation = "projects.initializeGit";
      const project = yield* loadProjectForGitWorkflow(operation, projectId);
      yield* vcsProvisioning
        .initRepository({ cwd: project.workspaceRoot, kind: "git" })
        .pipe(
          Effect.mapError((cause) =>
            toGitManagerError(operation, "Failed to initialize git repository.", cause),
          ),
        );
      const status = yield* gitWorkflow.localStatus({ cwd: project.workspaceRoot });
      const branch = status.refName ?? "main";
      const worktreeId = WorktreeId.make(`worktree-${projectId}-main`);
      const now = new Date().toISOString();
      yield* dispatchWorktreeCommand(
        {
          type: "worktree.create",
          commandId: serverCommandId("project-main-worktree-create"),
          worktreeId,
          projectId,
          branch,
          worktreePath: null,
          origin: "main",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: now,
        },
        operation,
      );
      const snapshot = yield* projectionSnapshotQuery
        .getShellSnapshot()
        .pipe(
          Effect.mapError((cause) =>
            toGitManagerError(operation, "Failed to load project threads.", cause),
          ),
        );
      for (const thread of snapshot.threads) {
        if (thread.projectId !== projectId) continue;
        yield* dispatchWorktreeCommand(
          {
            type: "thread.attach-to-worktree",
            commandId: serverCommandId("project-main-thread-attach"),
            threadId: thread.id,
            worktreeId,
            attachedAt: now,
          },
          operation,
        );
      }
      yield* refreshGitStatus(project.workspaceRoot);
      return {};
    });

  return {
    dispatchWorktreeCommand,
    createWorktreeForProject,
    archiveWorktree,
    restoreWorktree,
    deleteWorktree,
    initializeGitForProject,
    reconcileAllWorktrees,
    reconcileProjectWorktrees,
  };
};
