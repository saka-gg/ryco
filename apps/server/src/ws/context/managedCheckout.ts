/**
 * Managed checkouts: the shared core for creating a Ryco-managed Git worktree for a project,
 * removing only what a creation proved it made, and starting the project's setup script in it.
 *
 * Used by `git.createWorktreeForProject` and chat forks. Path allocation is separate from
 * creation so a caller with a durable journal can record the path and branch before Git runs,
 * and recreate the same checkout after a crash.
 */
import path from "node:path";

import { Effect, Schema } from "effect";
import {
  CommandId,
  EventId,
  type GitManagerServiceError,
  type OrchestrationProjectShell,
  type ServerSettings,
  type ThreadId,
  type WorktreeCheckoutLocation,
  type WorktreeSubmoduleInitialization,
  type ProjectId,
} from "@ryco/contracts";

import { resolveManagedWorktreesRoot, type ServerConfigShape } from "../../config.ts";
import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import type { OrchestrationEngineShape } from "../../orchestration/Services/OrchestrationEngine.ts";
import type { GitWorkflowServiceShape } from "../../git/GitWorkflowService.ts";
import type { ProjectSetupScriptRunnerShape } from "../../project/Services/ProjectSetupScriptRunner.ts";
import { resolveWorktreeCheckoutPath } from "../../project/worktreeCheckoutPaths.ts";
import { resolveConfiguredWorktreeRoot, WorktreeRootError } from "../../project/worktreeRoot.ts";
import {
  WorkspaceAccessDeniedError,
  type WorkspaceAccessPolicyShape,
} from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import {
  failGitWorkflow,
  ignoreAlreadyMissingGitResource,
  toGitManagerError,
} from "./gitErrors.ts";

export interface ManagedCheckoutDeps {
  readonly gitWorkflow: Pick<
    GitWorkflowServiceShape,
    "createWorktree" | "removeWorktree" | "deleteBranch"
  >;
  readonly workspaceAccessPolicy: WorkspaceAccessPolicyShape;
  readonly config: ServerConfigShape;
}

export type ManagedCheckoutProject = Pick<
  OrchestrationProjectShell,
  "id" | "title" | "workspaceRoot" | "projectMetadataDir"
>;

/** What a creation made and may therefore remove. Null: pre-existing or not created. */
export interface OwnedCheckout {
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

/** Same path, ignoring a trailing separator, and case on case-insensitive platforms. */
export const isProjectRootPath = (candidate: string, projectRoot: string): boolean => {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/g, "");
    return process.platform === "win32" || process.platform === "darwin"
      ? resolved.toLowerCase()
      : resolved;
  };
  return normalize(candidate) === normalize(projectRoot);
};

export const authorizeWorktreePath = (
  policy: Pick<WorkspaceAccessPolicyShape, "assertPath" | "assertExistingPath">,
  operation: string,
  candidate: string,
  existing: boolean,
) =>
  (existing
    ? policy.assertExistingPath({ path: candidate, operation })
    : policy.assertPath({ path: candidate, operation })
  ).pipe(Effect.mapError((cause) => toGitManagerError(operation, cause.message, cause)));

export interface ManagedCheckoutPathInput {
  readonly operation: string;
  readonly project: ManagedCheckoutProject;
  readonly settings: ServerSettings;
  readonly worktreeLocation?: WorktreeCheckoutLocation | undefined;
  /** Seeds the checkout directory name (e.g. a thread title). */
  readonly initialName: string;
  readonly branchName: string;
}

/**
 * Allocates and authorizes the directory for a new checkout. The leaf is reserved, so two
 * allocations never share a path. Refuses the project root.
 */
export const resolveManagedCheckoutPath = (
  deps: ManagedCheckoutDeps,
  input: ManagedCheckoutPathInput,
): Effect.Effect<string, GitManagerServiceError> =>
  Effect.gen(function* () {
    const { operation, project } = input;
    const targetPath = yield* resolveWorktreeCheckoutPath({
      location: input.worktreeLocation,
      appWorktreesRoot:
        input.worktreeLocation === "projectMetadata"
          ? resolveManagedWorktreesRoot(deps.config)
          : // Resolved lazily: only checkouts in the configured root depend on its availability.
            yield* resolveConfiguredWorktreeRoot({
              settings: input.settings,
              projectId: project.id,
              config: deps.config,
              policy: deps.workspaceAccessPolicy,
            }).pipe(Effect.mapError((cause) => toGitManagerError(operation, cause.message, cause))),
      projectId: project.id,
      workspaceRoot: project.workspaceRoot,
      projectMetadataDir: project.projectMetadataDir,
      projectTitle: project.title,
      initialName: input.initialName,
      branchName: input.branchName,
    });
    if (isProjectRootPath(targetPath, project.workspaceRoot)) {
      return yield* failGitWorkflow(operation, "Cannot create a worktree at the project root.");
    }
    return yield* authorizeWorktreePath(deps.workspaceAccessPolicy, operation, targetPath, false);
  });

/**
 * Whether a `resolveManagedCheckoutPath` failure refuses the destination itself, so asking again
 * cannot succeed until settings or the workspace policy change: the worktree root is unusable or
 * refused, the policy places the path outside its root, or the path is the project root (refused
 * here, without a cause). Reserving the path (the database, the folder's parent) or resolving it
 * for the policy (`unresolvable`) may work on the next attempt.
 */
export const isManagedCheckoutPathRefusal = (error: GitManagerServiceError): boolean => {
  if (error._tag !== "GitManagerError") return false;
  const cause = error.cause;
  if (cause === undefined) return true;
  if (Schema.is(WorktreeRootError)(cause)) return true;
  return Schema.is(WorkspaceAccessDeniedError)(cause) && cause.reason === "outsideRoot";
};

export interface ManagedCheckoutInput extends ManagedCheckoutPathInput {
  /** Branch, tag or commit the checkout starts from. */
  readonly refName: string;
  /** Create this branch at `refName`; omitted: check out `refName` itself. */
  readonly newRefName?: string | undefined;
  /** Fetch and start from the remote ref. Must be false for a commit id. */
  readonly fetchOrigin?: boolean | undefined;
  /** A path from `resolveManagedCheckoutPath` the caller already recorded. */
  readonly path?: string | undefined;
}

export interface ManagedCheckout {
  readonly worktreePath: string;
  readonly submoduleInitialization: WorktreeSubmoduleInitialization | undefined;
  readonly owned: OwnedCheckout;
}

/**
 * Creates the checkout with `git worktree add` (destination lock, setup journal and ownership
 * record are the Git workflow's), then re-authorizes the real path and refuses one that
 * resolved to the project root. The created path and new branch are returned as owned.
 */
export const createManagedCheckout = (
  deps: ManagedCheckoutDeps,
  input: ManagedCheckoutInput,
): Effect.Effect<ManagedCheckout, GitManagerServiceError> =>
  Effect.gen(function* () {
    const { operation, project } = input;
    const recordedPath = input.path;
    if (recordedPath !== undefined && isProjectRootPath(recordedPath, project.workspaceRoot)) {
      return yield* failGitWorkflow(operation, "Cannot create a worktree at the project root.");
    }
    const authorizedTargetPath =
      recordedPath === undefined
        ? yield* resolveManagedCheckoutPath(deps, input)
        : yield* authorizeWorktreePath(deps.workspaceAccessPolicy, operation, recordedPath, false);
    const created = yield* deps.gitWorkflow.createWorktree({
      settingsSnapshot: input.settings,
      projectId: project.id,
      fetchOrigin: input.fetchOrigin,
      cwd: project.workspaceRoot,
      refName: input.refName,
      ...(input.newRefName !== undefined ? { newRefName: input.newRefName } : {}),
      path: authorizedTargetPath,
    });
    const worktreePath = yield* authorizeWorktreePath(
      deps.workspaceAccessPolicy,
      operation,
      created.worktree.path,
      true,
    );
    if (isProjectRootPath(worktreePath, project.workspaceRoot)) {
      return yield* failGitWorkflow(
        operation,
        "Refusing to register a worktree that resolved to the project root.",
      );
    }
    return {
      worktreePath,
      submoduleInitialization: created.submoduleInitialization,
      owned: { worktreePath, branch: input.newRefName ?? null },
    };
  });

/**
 * Force-removes an owned checkout and deletes an owned branch; resources already gone count as
 * removed. Only for checkouts no user or agent work can exist in yet.
 */
export const removeOwnedCheckout = (
  deps: Pick<ManagedCheckoutDeps, "gitWorkflow">,
  input: {
    readonly operation: string;
    /** The repository the checkout belongs to (the project's workspace root). */
    readonly repositoryRoot: string;
    readonly owned: OwnedCheckout;
  },
): Effect.Effect<void, GitManagerServiceError> =>
  Effect.gen(function* () {
    const { operation, owned } = input;
    if (owned.worktreePath !== null) {
      yield* ignoreAlreadyMissingGitResource(
        deps.gitWorkflow.removeWorktree({
          cwd: input.repositoryRoot,
          path: owned.worktreePath,
          force: true,
        }),
        { operation, action: "remove-worktree", target: owned.worktreePath },
      );
    }
    if (owned.branch !== null) {
      yield* ignoreAlreadyMissingGitResource(
        deps.gitWorkflow.deleteBranch({
          cwd: input.repositoryRoot,
          refName: owned.branch,
          force: true,
        }),
        { operation, action: "delete-branch", target: owned.branch },
      );
    }
  });

/** `removeOwnedCheckout` after a later step failed: a cleanup failure is logged, not raised. */
export const cleanupOwnedCheckout = (
  deps: Pick<ManagedCheckoutDeps, "gitWorkflow">,
  input: Parameters<typeof removeOwnedCheckout>[1],
): Effect.Effect<void> =>
  removeOwnedCheckout(deps, input).pipe(
    Effect.catch((cleanupError) =>
      Effect.logWarning("failed to clean up worktree creation after dispatch failure", {
        operation: input.operation,
        worktreePath: input.owned.worktreePath,
        branch: input.owned.branch,
        detail: cleanupError.message,
      }).pipe(Effect.asVoid),
    ),
  );

export type AppendSetupScriptActivity = (input: {
  readonly threadId: ThreadId;
  readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
  readonly summary: string;
  readonly createdAt: string;
  readonly payload: Record<string, unknown>;
  readonly tone: "info" | "error";
}) => Effect.Effect<unknown, OrchestrationDispatchError>;

/** Records `setup-script.*` progress on a thread through server-internal dispatch. */
export const makeAppendSetupScriptActivity =
  (dispatch: OrchestrationEngineShape["dispatch"]): AppendSetupScriptActivity =>
  (input) =>
    dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:setup-script-activity:${crypto.randomUUID()}`),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

/**
 * Starts the project's setup script for a thread's new worktree, detached: the caller never
 * waits for or fails on it. Progress and start failures are recorded as `setup-script.*`
 * thread activities.
 */
export const launchSetupScriptForWorktreeInBackground = (
  deps: {
    readonly projectSetupScriptRunner: ProjectSetupScriptRunnerShape;
    readonly appendSetupScriptActivity: AppendSetupScriptActivity;
  },
  input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly projectCwd: string;
    readonly worktreePath: string;
  },
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const { appendSetupScriptActivity } = deps;
    const requestedAt = new Date().toISOString();
    yield* deps.projectSetupScriptRunner
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
