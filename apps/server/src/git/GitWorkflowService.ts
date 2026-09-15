import { authorizeGitReadCwd } from "../vcs/GitReadWorkspace.ts";
import type { WorkspaceAccessPolicy } from "../workspace/Services/WorkspaceAccessPolicy.ts";
import { readGitLineBlame } from "../vcs/GitLineBlame.ts";
import { readGitComparison } from "../vcs/GitComparison.ts";
import type {
  GitReadLineBlameInput,
  GitReadLineBlameResult,
  GitReadComparisonInput,
  GitReadComparisonResult,
} from "@ryco/contracts";
import { existsSync } from "node:fs";
import { Context, Effect, Layer } from "effect";

import {
  GitManagerError,
  GitCommandError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type VcsStatusInput,
  type VcsStatusLocalResult,
  type VcsStatusRemoteResult,
  type VcsStatusResult,
} from "@ryco/contracts";

import { GitManager, type GitRunStackedActionOptions } from "./GitManager.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";

export interface GitWorkflowServiceShape {
  readonly readLineBlame: (
    input: GitReadLineBlameInput,
  ) => Effect.Effect<GitReadLineBlameResult, GitCommandError, WorkspaceAccessPolicy>;
  readonly readComparison: (
    input: GitReadComparisonInput,
  ) => Effect.Effect<GitReadComparisonResult, GitCommandError, WorkspaceAccessPolicy>;
  readonly status: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusResult, GitManagerServiceError>;
  readonly localStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusLocalResult, GitManagerServiceError>;
  readonly remoteStatus: (
    input: VcsStatusInput,
  ) => Effect.Effect<VcsStatusRemoteResult | null, GitManagerServiceError>;
  readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: GitRunStackedActionOptions,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, GitCommandError>;
  readonly createWorktree: (
    input: VcsCreateWorktreeInput,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  readonly removeWorktree: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  readonly pruneWorktrees: (cwd: string) => Effect.Effect<void, GitCommandError>;
  readonly listWorktreePaths: (cwd: string) => Effect.Effect<readonly string[], GitCommandError>;
  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<readonly string[], GitCommandError>;
  readonly createRef: (
    input: VcsCreateRefInput,
  ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
  readonly deleteBranch: (input: {
    readonly cwd: string;
    readonly refName: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, GitCommandError>;
  readonly switchRef: (
    input: VcsSwitchRefInput,
  ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
  readonly renameBranch: (input: {
    readonly cwd: string;
    readonly oldBranch: string;
    readonly newBranch: string;
  }) => Effect.Effect<{ readonly branch: string }, GitManagerServiceError>;
}

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  GitWorkflowServiceShape
>()("ryco/git/GitWorkflowService") {}

const unsupportedGitWorkflow = (operation: string, cwd: string, detail: string) =>
  new GitManagerError({
    operation,
    detail: `${detail} (${cwd})`,
  });

const unsupportedGitCommand = (operation: string, cwd: string, detail: string) =>
  new GitCommandError({
    operation,
    command: "vcs-route",
    cwd,
    detail,
  });

function nonRepositoryLocalStatus(): VcsStatusLocalResult {
  return {
    isRepo: false,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: {
      files: [],
      insertions: 0,
      deletions: 0,
    },
  };
}

function nonRepositoryStatus(): VcsStatusResult {
  return {
    ...nonRepositoryLocalStatus(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    pr: null,
  };
}

function nonRepositoryListRefs(): VcsListRefsResult {
  return {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
  };
}

export const make = Effect.fn("makeGitWorkflowService")(function* () {
  const registry = yield* VcsDriverRegistry;
  const git = yield* GitVcsDriver;
  const gitManager = yield* GitManager;

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitWorkflow(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (handle.kind !== "git") {
      return yield* unsupportedGitWorkflow(
        operation,
        cwd,
        `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitCommand(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (handle.kind !== "git") {
      return yield* unsupportedGitCommand(
        operation,
        cwd,
        `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
  });

  const detectGitRepositoryForStatus = Effect.fn("GitWorkflowService.detectGitRepositoryForStatus")(
    function* (operation: string, cwd: string) {
      const handle = yield* registry
        .detect({ cwd })
        .pipe(
          Effect.mapError((error) =>
            unsupportedGitWorkflow(
              operation,
              cwd,
              error instanceof Error ? error.message : String(error),
            ),
          ),
        );
      if (!handle) {
        return false;
      }
      if (handle.kind !== "git") {
        return yield* unsupportedGitWorkflow(
          operation,
          cwd,
          `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}.`,
        );
      }
      return true;
    },
  );

  const detectGitRepositoryForCommand = Effect.fn(
    "GitWorkflowService.detectGitRepositoryForCommand",
  )(function* (operation: string, cwd: string) {
    const handle = yield* registry
      .detect({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitCommand(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (!handle) {
      return false;
    }
    if (handle.kind !== "git") {
      return yield* unsupportedGitCommand(
        operation,
        cwd,
        `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
    return true;
  });

  const recoverMissingCwd =
    <A, E>(cwd: string, fallback: A): ((error: E) => Effect.Effect<A, E>) =>
    (error) =>
      Effect.sync(() => existsSync(cwd)).pipe(
        Effect.flatMap((exists) => (exists ? Effect.fail(error) : Effect.succeed(fallback))),
      );

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    status: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.status", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager
                .status(input)
                .pipe(Effect.catch(recoverMissingCwd(input.cwd, nonRepositoryStatus())))
            : Effect.succeed(nonRepositoryStatus()),
        ),
      ),
    localStatus: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.localStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager
                .localStatus(input)
                .pipe(Effect.catch(recoverMissingCwd(input.cwd, nonRepositoryLocalStatus())))
            : Effect.succeed(nonRepositoryLocalStatus()),
        ),
      ),
    remoteStatus: (input) =>
      detectGitRepositoryForStatus("GitWorkflowService.remoteStatus", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? gitManager.remoteStatus(input).pipe(Effect.catch(recoverMissingCwd(input.cwd, null)))
            : Effect.succeed(null),
        ),
      ),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      ),
    runStackedAction: (input, options) =>
      ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.andThen(gitManager.runStackedAction(input, options)),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: routeGitManager(
      "GitWorkflowService.preparePullRequestThread",
      gitManager.preparePullRequestThread,
    ),
    // Authorize before repository-kind discovery; readers also validate Git's resolved root.
    readLineBlame: (input) =>
      authorizeGitReadCwd(input.cwd, "readLineBlame").pipe(
        Effect.flatMap((cwd) =>
          ensureGitCommand("GitWorkflowService.readLineBlame", cwd).pipe(
            Effect.andThen(readGitLineBlame(git.execute, { ...input, cwd })),
          ),
        ),
      ),
    readComparison: (input) =>
      authorizeGitReadCwd(input.cwd, "readComparison").pipe(
        Effect.flatMap((cwd) =>
          ensureGitCommand("GitWorkflowService.readComparison", cwd).pipe(
            Effect.andThen(readGitComparison(git.execute, { ...input, cwd })),
          ),
        ),
      ),
    listRefs: (input) =>
      detectGitRepositoryForCommand("GitWorkflowService.listRefs", input.cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? git
                .listRefs(input)
                .pipe(Effect.catch(recoverMissingCwd(input.cwd, nonRepositoryListRefs())))
            : Effect.succeed(nonRepositoryListRefs()),
        ),
      ),
    createWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(git.createWorktree(input)),
      ),
    removeWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      ),
    pruneWorktrees: (cwd) =>
      ensureGitCommand("GitWorkflowService.pruneWorktrees", cwd).pipe(
        Effect.andThen(git.pruneWorktrees(cwd)),
      ),
    listWorktreePaths: (cwd) => {
      const empty: readonly string[] = [];
      return detectGitRepositoryForCommand("GitWorkflowService.listWorktreePaths", cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? git.listWorktreePaths(cwd).pipe(Effect.catch(recoverMissingCwd(cwd, empty)))
            : Effect.succeed(empty),
        ),
      );
    },
    listLocalBranchNames: (cwd) => {
      const empty: readonly string[] = [];
      return detectGitRepositoryForCommand("GitWorkflowService.listLocalBranchNames", cwd).pipe(
        Effect.flatMap((isGitRepository) =>
          isGitRepository
            ? git.listLocalBranchNames(cwd).pipe(Effect.catch(recoverMissingCwd(cwd, empty)))
            : Effect.succeed(empty),
        ),
      );
    },
    createRef: (input) =>
      ensureGitCommand("GitWorkflowService.createRef", input.cwd).pipe(
        Effect.andThen(git.createRef(input)),
      ),
    deleteBranch: (input) =>
      ensureGitCommand("GitWorkflowService.deleteBranch", input.cwd).pipe(
        Effect.andThen(git.deleteBranch(input)),
      ),
    switchRef: (input) =>
      ensureGitCommand("GitWorkflowService.switchRef", input.cwd).pipe(
        Effect.andThen(Effect.scoped(git.switchRef(input))),
      ),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make());
