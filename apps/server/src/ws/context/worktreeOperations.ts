import { resolveProjectPreferences } from "../../project/projectPreferences.ts";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Cause, Effect, Option } from "effect";
import {
  type CommandId,
  DEFAULT_PROJECT_METADATA_DIR,
  type GitCreateWorktreeForProjectInput,
  type GitManagerServiceError,
  type OrchestrationCommand,
  type OrchestrationDispatchCommandError,
  type OrchestrationProjectShell,
  type ProjectId,
  type WorktreeSubmoduleInitialization,
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
import {
  resolveConfiguredWorktreeRoot,
  selectConfiguredWorktreeRoot,
} from "../../project/worktreeRoot.ts";
import {
  resolveManagedProjectDirectory,
  resolveWorktreeCheckoutPath,
} from "../../project/worktreeCheckoutPaths.ts";
import type { ProjectionWorktreeRepositoryShape } from "../../persistence/Services/ProjectionWorktrees.ts";
import { refreshWorktreeSourceControlState } from "../../sourceControl/refreshWorktreeSourceControlState.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import type { GitVcsDriverShape } from "../../vcs/GitVcsDriver.ts";
import type { VcsProvisioningServiceShape } from "../../vcs/VcsProvisioningService.ts";
import type { WorkspaceAccessPolicyShape } from "../../workspace/Services/WorkspaceAccessPolicy.ts";
import type { WorkspaceLifecycleShape } from "../../workspace/WorkspaceLifecycle.ts";
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
/** Staging a large folder or a commit hook can be slow; a signing prompt must not hang forever. */
const INITIAL_COMMIT_TIMEOUT_MS = 60_000;
const INITIAL_COMMIT_PROBE_TIMEOUT_MS = 10_000;
const INITIAL_COMMIT_OUTPUT_BYTES = 64 * 1024;
const COMMIT_FAILURE_DETAIL_MAX_CHARS = 200;

export const INITIAL_COMMIT_MESSAGE = "Initial commit";

// Process-wide: the WS context is rebuilt per connection, but the on-disk state
// this sweep inspects is shared by all of them.
let lastReconciliationAtMs = 0;
const missingProjectRoots = new Set<ProjectId>();

/** What `initializeGitForProject` does beyond `git init`, the main workspace and thread attachment. */
export interface InitializeProjectGitOptions {
  /** Write a minimal `.gitignore` when the project has none. An existing one is never touched. */
  readonly writeGitignore?: boolean;
  /**
   * Stage everything and commit it as "Initial commit", only in a repository without history.
   * A failed commit is reported in the result; the repository and the project are kept.
   */
  readonly initialCommit?: boolean;
}

/** Empty unless `initialCommit` was requested, so "Initialize Git" still answers `{}`. */
export interface InitializeProjectGitResult {
  readonly initialCommitCreated?: boolean;
  /** Short and actionable, e.g. how to set a missing Git identity. */
  readonly commitError?: string;
}

/**
 * A new repository's `.gitignore`: OS litter, dependencies, secrets and the project's own
 * Ryco-managed worktrees, which live inside it.
 */
export const minimalGitignore = (projectMetadataDir: string | null | undefined): string => {
  const metadataDir = (projectMetadataDir?.trim() || DEFAULT_PROJECT_METADATA_DIR)
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  return [".DS_Store", "node_modules/", ".env", ".env.*", `/${metadataDir}/worktrees/`, ""].join(
    "\n",
  );
};

/** Create `.gitignore` only when nothing exists at that path; true when it was written. */
export const writeGitignoreIfMissing = (workspaceRoot: string, content: string) =>
  Effect.tryPromise(() =>
    writeFile(path.join(workspaceRoot, ".gitignore"), content, { flag: "wx" }).then(
      () => true,
      (cause: NodeJS.ErrnoException) => {
        if (cause.code === "EEXIST") return false;
        throw cause;
      },
    ),
  );

/**
 * Turn Git's multi-line commit failure into one sentence that says what to fix. The repository
 * is kept either way, so every message ends by pointing at a commit the user can make later.
 */
export const describeInitialCommitFailure = (detail: string): string => {
  const text = detail.trim();
  if (
    /please tell me who you are|author identity unknown|committer identity unknown|unable to auto-detect email|empty ident name|no email was given/i.test(
      text,
    )
  ) {
    return "Git has no name or email on this machine. Set user.name and user.email, then commit.";
  }
  if (/gpg|signing|sign the data|ssh-keygen|failed to write commit object/i.test(text)) {
    return "Git could not sign the first commit. Check your commit signing setup, then commit.";
  }
  if (/timed out/i.test(text)) {
    return "Git took too long to make the first commit; it may be waiting for a passphrase. Commit from a terminal.";
  }
  if (/hook/i.test(text)) {
    return "A Git hook rejected the first commit. Fix what it reports, then commit.";
  }
  const firstLine =
    text
      .split("\n")
      .map((line) => line.replace(/^(fatal|error):\s*/i, "").trim())
      .find((line) => line.length > 0) ?? "";
  const reason =
    firstLine.length > COMMIT_FAILURE_DETAIL_MAX_CHARS
      ? `${firstLine.slice(0, COMMIT_FAILURE_DETAIL_MAX_CHARS - 1)}…`
      : firstLine;
  return reason
    ? `The first commit failed: ${reason}. Fix it, then commit.`
    : "The first commit failed. Commit from a terminal to see why.";
};

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
  /** Runs the optional first commit of `initializeGitForProject`; absent nodes report it. */
  readonly gitDriver?: Pick<GitVcsDriverShape, "execute"> | undefined;
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
  readonly workspaceLifecycle: Option.Option<WorkspaceLifecycleShape>;
}) => {
  const {
    projectionSnapshotQuery,
    projectionWorktrees,
    gitWorkflow,
    vcsProvisioning,
    gitDriver,
    config,
    serverSettings,
    workspaceAccessPolicy,
    textGeneration,
    projectSetupScriptRunner,
    serverCommandId,
    dispatchNormalizedCommand,
    refreshGitStatus,
    appendSetupScriptActivity,
    workspaceLifecycle,
  } = deps;

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

  const ensureProjectMainWorktree = (project: OrchestrationProjectShell, operation: string) =>
    Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery
        .getShellSnapshot()
        .pipe(
          Effect.mapError((cause) =>
            toGitManagerError(operation, "Failed to load project workspaces.", cause),
          ),
        );
      const existing = snapshot.worktrees?.find(
        (worktree) =>
          worktree.projectId === project.id &&
          worktree.origin === "main" &&
          worktree.archivedAt === null &&
          (worktree.worktreePath === null ||
            isProjectRootPath(worktree.worktreePath, project.workspaceRoot)),
      );
      if (existing) return existing.worktreeId;
      const status = yield* gitWorkflow.localStatus({ cwd: project.workspaceRoot });
      if (!status.isRepo) return null;
      const worktreeId = WorktreeId.make(`worktree-${project.id}-main`);
      if (snapshot.worktrees?.some((worktree) => worktree.worktreeId === worktreeId)) {
        return yield* failGitWorkflow(operation, "The main workspace ID is already in use.");
      }
      yield* dispatchWorktreeCommand(
        {
          type: "worktree.create",
          commandId: serverCommandId("project-main-worktree-create"),
          worktreeId,
          projectId: project.id,
          branch: status.refName ?? "main",
          worktreePath: null,
          origin: "main",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: new Date().toISOString(),
        },
        operation,
      );
      return worktreeId;
    });

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
          if (existingWorktree.worktreePath !== null)
            yield* gitWorkflow.assertWorktreeSetupComplete(existingWorktree.worktreePath);
          const project = yield* loadProjectForGitWorkflow(operation, input.projectId);
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError((cause) =>
              toGitManagerError(operation, "Failed to load server settings.", cause),
            ),
          );
          const defaultAgentTokenMode = settings.defaultAgentTokenMode;
          const modelSelection = resolveProjectPreferences({ settings, project })
            .initialModelSelection.value;
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
              tokenMode: defaultAgentTokenMode,
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
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) =>
          toGitManagerError(operation, "Failed to load server settings.", cause),
        ),
      );

      const effective = resolveProjectPreferences({ settings, project });
      const worktreeBranchPrefix = effective.worktreeBranchPrefix.value;
      const modelSelection = effective.initialModelSelection.value;
      // Resolve lazily: reusing an existing registered PR checkout must not depend on
      // the availability of the root configured for future checkouts.
      const resolveRoot = () =>
        resolveConfiguredWorktreeRoot({
          settings,
          projectId: input.projectId,
          config,
          policy: workspaceAccessPolicy,
        }).pipe(Effect.mapError((cause) => toGitManagerError(operation, cause.message, cause)));
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
      let submoduleInitialization: WorktreeSubmoduleInitialization | undefined;
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
          const prepared = yield* gitWorkflow.preparePullRequestThread(
            {
              settingsSnapshot: settings,
              cwd: project.workspaceRoot,
              reference: String(number),
              mode: "worktree",
              projectId: input.projectId,
              worktreeLocation: input.worktreeLocation,
              worktreesDir:
                input.worktreeLocation === "projectMetadata"
                  ? resolveProjectWorktreesDir(project.workspaceRoot, project.projectMetadataDir)
                  : path.join(
                      selectConfiguredWorktreeRoot({
                        settings,
                        projectId: input.projectId,
                        config,
                      }),
                      yield* resolveManagedProjectDirectory(
                        input.projectId,
                        project.title,
                        selectConfiguredWorktreeRoot({
                          settings,
                          projectId: input.projectId,
                          config,
                        }),
                      ).pipe(Effect.catch((cause) => failGitWorkflow(operation, cause.message))),
                    ),
            },
            { preferencesSnapshot: { settings, project } },
          );
          submoduleInitialization = prepared.submoduleInitialization;
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
                modelSelection: settings.textGenerationModelSelection,
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
                  modelSelection: settings.textGenerationModelSelection,
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
        const targetPath = yield* resolveWorktreeCheckoutPath({
          location: input.worktreeLocation,
          appWorktreesRoot:
            input.worktreeLocation === "projectMetadata"
              ? resolveManagedWorktreesRoot(config)
              : yield* resolveRoot(),
          projectId: input.projectId,
          workspaceRoot: project.workspaceRoot,
          projectMetadataDir: project.projectMetadataDir,
          projectTitle: project.title,
          initialName: title,
          branchName: branch,
        });
        if (isProjectRootPath(targetPath, project.workspaceRoot)) {
          return yield* failGitWorkflow(operation, "Cannot create a worktree at the project root.");
        }
        const authorizedTargetPath = yield* authorizeWorktreePath(operation, targetPath, false);
        const created = yield* gitWorkflow.createWorktree({
          settingsSnapshot: settings,
          projectId: input.projectId,
          fetchOrigin: input.fetchOrigin,
          cwd: project.workspaceRoot,
          refName,
          ...(newRefName !== undefined ? { newRefName } : {}),
          path: authorizedTargetPath,
        });
        worktreePath = created.worktree.path;
        submoduleInitialization = created.submoduleInitialization;
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
            tokenMode: settings.defaultAgentTokenMode,
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

        if (effective.runSetupScript.value)
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
      return { worktreeId, sessionId: threadId, submoduleInitialization };
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
      // Projects linked before main workspace records existed need a destination
      // for conversations preserved by governed workspace deletion.
      yield* ensureProjectMainWorktree(project, operation);
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

  // Legacy worktree RPCs route through the one workspace lifecycle service, so they
  // share its preflight, fencing and history-preserving semantics. Archiving only
  // hides a record; "delete" removes the checkout safely and archives conversations.
  const runLifecycle = (
    operation: string,
    request: Parameters<WorkspaceLifecycleShape["applyCurrent"]>[0],
  ) =>
    Option.match(workspaceLifecycle, {
      onNone: () => failGitWorkflow(operation, "Workspace lifecycle management is unavailable."),
      onSome: (lifecycle) =>
        lifecycle.applyCurrent(request).pipe(
          Effect.mapError((cause) => toGitManagerError(operation, cause.detail, cause)),
          Effect.flatMap((result) =>
            result.outcome === "completed"
              ? Effect.succeed({})
              : failGitWorkflow(operation, result.message),
          ),
        ),
    });

  const archiveWorktree = (input: {
    readonly worktreeId: WorktreeId;
    readonly deleteBranch: boolean;
  }) =>
    input.deleteBranch
      ? failGitWorkflow(
          "git.archiveWorktree",
          "Archiving never deletes a branch. Remove the checkout to delete a merged branch.",
        )
      : runLifecycle("git.archiveWorktree", { worktreeId: input.worktreeId, action: "archive" });

  const restoreWorktree = (worktreeId: WorktreeId) =>
    Option.match(workspaceLifecycle, {
      onNone: () =>
        failGitWorkflow("git.restoreWorktree", "Workspace lifecycle management is unavailable."),
      onSome: (lifecycle) =>
        lifecycle.preview({ worktreeId, action: "recreate-checkout" }).pipe(
          Effect.mapError((cause) => toGitManagerError("git.restoreWorktree", cause.detail, cause)),
          // Records archived by older builds lost their checkout: recreate it when possible.
          Effect.flatMap((preview) =>
            runLifecycle("git.restoreWorktree", {
              worktreeId,
              action: preview.blockers.length === 0 ? "recreate-checkout" : "restore",
            }),
          ),
        ),
    });

  const deleteWorktree = (input: {
    readonly worktreeId: WorktreeId;
    readonly deleteBranch: boolean;
    readonly force?: boolean | undefined;
  }) =>
    runLifecycle("git.deleteWorktree", {
      worktreeId: input.worktreeId,
      action: input.force ? "remove-stale-record" : "remove-checkout",
      deleteBranch: input.force ? false : input.deleteBranch,
    });

  /**
   * The optional first commit of a new repository. Never fails: the repository is already
   * usable, so a missing identity, a signing prompt or a hook is reported for the user to fix.
   */
  const commitInitialSnapshot = (cwd: string) =>
    Effect.gen(function* () {
      if (gitDriver === undefined) {
        return {
          initialCommitCreated: false,
          commitError: "This server cannot make the first commit. Commit from a terminal.",
        } satisfies InitializeProjectGitResult;
      }
      const git = (operation: string, args: ReadonlyArray<string>, timeoutMs: number) =>
        gitDriver.execute({
          operation: `projects.initializeGit.${operation}`,
          cwd,
          args,
          // Git localizes its messages; failures are recognized in English.
          env: { LC_ALL: "C" },
          allowNonZeroExit: true,
          timeoutMs,
          maxOutputBytes: INITIAL_COMMIT_OUTPUT_BYTES,
          truncateOutputAtMaxBytes: true,
        });
      const failed = (result: { readonly stderr: string; readonly stdout: string }) =>
        ({
          initialCommitCreated: false,
          commitError: describeInitialCommitFailure(result.stderr || result.stdout),
        }) satisfies InitializeProjectGitResult;
      // A folder that was already a repository keeps its history untouched.
      const head = yield* git(
        "head",
        ["rev-parse", "--verify", "--quiet", "HEAD"],
        INITIAL_COMMIT_PROBE_TIMEOUT_MS,
      );
      if (head.exitCode === 0) return { initialCommitCreated: false };
      const add = yield* git("add", ["add", "--all"], INITIAL_COMMIT_TIMEOUT_MS);
      if (add.exitCode !== 0) return failed(add);
      // An empty folder has nothing to commit; that is not a failure.
      const staged = yield* git(
        "staged",
        ["diff", "--cached", "--quiet"],
        INITIAL_COMMIT_PROBE_TIMEOUT_MS,
      );
      if (staged.exitCode === 0) return { initialCommitCreated: false };
      const commit = yield* git(
        "commit",
        ["commit", "--quiet", "-m", INITIAL_COMMIT_MESSAGE],
        INITIAL_COMMIT_TIMEOUT_MS,
      );
      if (commit.exitCode !== 0) return failed(commit);
      return { initialCommitCreated: true };
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          initialCommitCreated: false,
          commitError: describeInitialCommitFailure(error.detail),
        } satisfies InitializeProjectGitResult),
      ),
    );

  /**
   * `git init`, the main workspace record and every thread attached to it. Options add a minimal
   * `.gitignore` and the first commit (promotion uses both); without them only the repository is
   * created, as for "Initialize Git".
   */
  const initializeGitForProject = (
    projectId: ProjectId,
    options: InitializeProjectGitOptions = {},
  ) =>
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
      if (options.writeGitignore) {
        // Best effort: a missing `.gitignore` never undoes a created repository.
        yield* writeGitignoreIfMissing(
          project.workspaceRoot,
          minimalGitignore(project.projectMetadataDir),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("could not write the new repository's .gitignore", {
              projectId,
              cause: String(cause),
            }),
          ),
        );
      }
      const worktreeId = yield* ensureProjectMainWorktree(project, operation);
      if (worktreeId === null)
        return yield* failGitWorkflow(operation, "The initialized repository is unavailable.");
      const now = new Date().toISOString();
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
      const result: InitializeProjectGitResult = options.initialCommit
        ? yield* commitInitialSnapshot(project.workspaceRoot)
        : {};
      yield* refreshGitStatus(project.workspaceRoot);
      return result;
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
