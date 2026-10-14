import { Context, DateTime, Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  VcsProcessExitError,
  type VcsSwitchRefInput,
  type VcsSwitchRefResult,
  type VcsCreateRefInput,
  type VcsCreateRefResult,
  type VcsCreateWorktreeInput,
  type ProjectId,
  type ServerSettings,
  type VcsCreateWorktreeResult,
  type VcsInitInput,
  type VcsListRefsInput,
  type VcsListRefsResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
} from "@ryco/contracts";
import type { VerifiedWorktreeCleanup } from "../storage/filesystem.ts";
import * as GitVcsDriverCore from "./GitVcsDriverCore.ts";
import * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

/** Server-derived context only; deliberately absent from public RPC schemas. */
export interface GitWorktreeCreationContext {
  readonly projectId?: ProjectId | undefined;
  readonly projectTitle?: string | undefined;
  readonly initialName?: string | undefined;
  readonly settingsSnapshot?: ServerSettings | undefined;
  /** Observes the fetch and checkout while the worktree is created. */
  readonly progress?: GitWorktreeCreationProgress | undefined;
}

export interface GitWorktreeCreationProgress {
  readonly onFetchStarted?: () => Effect.Effect<void>;
  /**
   * `reused`: a prefetch of the same base stood in for the fetch. `branch`:
   * the base's branch on origin (`origin/HEAD` resolved to its target).
   */
  readonly onFetchFinished?: (input: {
    readonly reused: boolean;
    readonly branch: string;
  }) => Effect.Effect<void>;
  readonly onCheckoutStarted?: () => Effect.Effect<void>;
  /** Git's own "Updating files" percentage. */
  readonly onCheckoutProgress?: (percent: number) => Effect.Effect<void>;
}

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
  readonly progress?: ExecuteGitProgress;
  /**
   * Collect stdout undecoded into `stdoutBytes` (object contents such as image
   * blobs). Output over `maxOutputBytes` fails instead of truncating.
   */
  readonly stdoutBytes?: boolean;
  /**
   * A read that must never take optional locks (`GIT_OPTIONAL_LOCKS=0`): a
   * background `git status` otherwise rewrites `.git/index` under
   * `index.lock`, racing agents' `git add` / `commit` in the same checkout.
   */
  readonly readOnly?: boolean;
}

/** Environment for read-only git commands; see {@link ExecuteGitInput.readOnly}. */
export const READ_ONLY_GIT_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: "0",
} satisfies NodeJS.ProcessEnv);

export interface ExecuteGitResult {
  readonly exitCode: ChildProcessSpawner.ExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  /** Present only when the input requested `stdoutBytes`; `stdout` is then empty. */
  readonly stdoutBytes?: Uint8Array;
}

/** Parsed `git config --list`: keys as git prints them (section and name lowercased). */
export interface GitConfigSnapshot {
  readonly get: (key: string) => string | null;
  /** Configured remote names, in config order. */
  readonly remoteNames: ReadonlyArray<string>;
}

export interface GitStatusDetails {
  isRepo: boolean;
  sourceControlProvider?: VcsStatusResult["sourceControlProvider"];
  hasOriginRemote: boolean;
  isDefaultBranch: boolean;
  branch: string | null;
  upstreamRef: string | null;
  hasWorkingTreeChanges: boolean;
  workingTree: VcsStatusResult["workingTree"];
  committed?: VcsStatusResult["committed"];
  hasUpstream: boolean;
  aheadCount: number;
  behindCount: number;
  aheadOfDefaultCount: number;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  /**
   * Also end a stderr line at a bare carriage return, as a terminal shows a
   * progress meter redrawing itself. Off, such updates arrive only once the
   * meter prints its final newline.
   */
  readonly splitStderrAtCarriageReturn?: boolean;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitDeleteBranchInput {
  cwd: string;
  refName: string;
  force?: boolean;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitFetchRemoteTrackingBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitVcsDriverShape {
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
  /**
   * The effective git config (`git config -z --list`, every scope, last value
   * wins), briefly cached per cwd. For status-path reads only; mutation flows
   * read single keys with {@link readConfigValue}.
   */
  readonly readConfigSnapshot: (cwd: string) => Effect.Effect<GitConfigSnapshot, GitCommandError>;
  readonly status: (input: VcsStatusInput) => Effect.Effect<VcsStatusResult, GitCommandError>;
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  /**
   * Fetches the current branch's upstream remote unless that remote was
   * fetched recently (shared per repository and remote). Never fails; true
   * when a fetch completed during the call, so remote-tracking refs may have moved.
   */
  readonly refreshStatusUpstream: (cwd: string) => Effect.Effect<boolean>;
  readonly prepareCommitContext: (
    cwd: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
    options?: GitCommitOptions,
  ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
  readonly pushCurrentBranch: (
    cwd: string,
    fallbackBranch: string | null,
    options?: { readonly remoteName?: string | null },
  ) => Effect.Effect<GitPushResult, GitCommandError>;
  readonly readRangeContext: (
    cwd: string,
    baseRef: string,
    options?: { readonly remoteName?: string | null },
  ) => Effect.Effect<GitRangeContext, GitCommandError>;
  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly listRefs: (input: VcsListRefsInput) => Effect.Effect<VcsListRefsResult, GitCommandError>;
  /**
   * Drops the briefly cached branch listing for `cwd`, for refs that moved
   * outside this driver (an agent's git command): the status broadcaster's
   * refresh after a git action or agent turn calls it.
   */
  readonly invalidateRefListing: (cwd: string) => Effect.Effect<void>;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<VcsPullResult, GitCommandError>;
  readonly assertWorktreeSetupComplete: (
    checkoutPath: string,
  ) => Effect.Effect<void, GitCommandError>;
  readonly createWorktree: (
    input: VcsCreateWorktreeInput & GitWorktreeCreationContext,
  ) => Effect.Effect<VcsCreateWorktreeResult, GitCommandError>;
  /**
   * Fetches a worktree base from origin ahead of `createWorktree`, which reuses
   * the fetch while it runs and for a short while after it finished.
   */
  readonly prefetchWorktreeBase: (input: {
    readonly cwd: string;
    readonly refName: string;
  }) => Effect.Effect<void, GitCommandError>;
  readonly fetchPullRequestBranch: (
    input: GitFetchPullRequestBranchInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
  readonly resolvePrimaryRemoteName: (cwd: string) => Effect.Effect<string, GitCommandError>;
  readonly fetchRemoteBranch: (
    input: GitFetchRemoteBranchInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly fetchRemoteTrackingBranch: (
    input: GitFetchRemoteTrackingBranchInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly setBranchUpstream: (
    input: GitSetBranchUpstreamInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly removeWorktree: (
    input: VcsRemoveWorktreeInput & { readonly cleanup?: VerifiedWorktreeCleanup },
  ) => Effect.Effect<void, GitCommandError>;
  readonly pruneWorktrees: (cwd: string) => Effect.Effect<void, GitCommandError>;
  readonly renameBranch: (
    input: GitRenameBranchInput,
  ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
  readonly createRef: (
    input: VcsCreateRefInput,
  ) => Effect.Effect<VcsCreateRefResult, GitCommandError>;
  readonly deleteBranch: (input: GitDeleteBranchInput) => Effect.Effect<void, GitCommandError>;
  readonly switchRef: (
    input: VcsSwitchRefInput,
  ) => Effect.Effect<VcsSwitchRefResult, GitCommandError>;
  readonly initRepo: (input: VcsInitInput) => Effect.Effect<void, GitCommandError>;
  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
  readonly listWorktreePaths: (cwd: string) => Effect.Effect<readonly string[], GitCommandError>;
}

export class GitVcsDriver extends Context.Service<GitVcsDriver, GitVcsDriverShape>()(
  "ryco/vcs/GitVcsDriver",
) {}

// Sized for the workspace index's 200k-file corpus (paths average well under
// 100 bytes); larger listings are truncated and reported as such.
const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const WORKSPACE_FILES_TIMEOUT_MS = 20_000;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

/** Parses `git rev-parse --is-inside-work-tree --show-toplevel --git-common-dir`. */
export function parseDetectRepositoryOutput(
  exitCode: number,
  stdout: string,
): { readonly rootPath: string; readonly metadataPath: string | null } | null {
  if (exitCode !== 0) return null;
  const [insideWorkTree, rootPath, gitCommonDir] = stdout
    .split(/\r?\n/g)
    .map((line) => line.trim());
  if (insideWorkTree !== "true" || !rootPath) return null;
  return { rootPath, metadataPath: gitCommonDir || null };
}

function parseGitRemoteVerboseOutput(
  output: string,
): Map<string, { url?: string; pushUrl?: string }> {
  const remotes = new Map<string, { url?: string; pushUrl?: string }>();
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const name = match[1];
    const url = match[2];
    const direction = match[3];
    if (!name || !url || !direction) {
      continue;
    }
    const remote = remotes.get(name) ?? {};
    if (direction === "fetch") {
      remote.url = url;
    } else {
      remote.pushUrl = url;
    }
    remotes.set(name, remote);
  }
  return remotes;
}

const gitCommand = (
  process: VcsProcess.VcsProcessShape,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly truncateOutputAtMaxBytes?: boolean;
  },
) =>
  process.run({
    operation,
    command: "git",
    args,
    cwd,
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.env !== undefined ? { env: options.env } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.truncateOutputAtMaxBytes !== undefined
      ? { truncateOutputAtMaxBytes: options.truncateOutputAtMaxBytes }
      : {}),
  });

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const process = yield* VcsProcess.VcsProcess;
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
    ignoreClassifier: "native" as const,
  };

  const isInsideWorkTree: VcsDriver.VcsDriverShape["isInsideWorkTree"] = (cwd) =>
    gitCommand(
      process,
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
        env: READ_ONLY_GIT_ENV,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

  const execute: VcsDriver.VcsDriverShape["execute"] = (input) =>
    gitCommand(process, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.truncateOutputAtMaxBytes !== undefined
        ? { truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes }
        : {}),
    });

  // One rev-parse prints all three answers (one line each); outside a work
  // tree (no repository, a bare one, inside .git) it exits nonzero or says false.
  const detectRepository: VcsDriver.VcsDriverShape["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    const result = yield* gitCommand(
      process,
      "GitVcsDriver.detectRepository",
      cwd,
      ["rev-parse", "--is-inside-work-tree", "--show-toplevel", "--git-common-dir"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 16_384,
        env: READ_ONLY_GIT_ENV,
      },
    );
    const detected = parseDetectRepositoryOutput(result.exitCode, result.stdout);
    if (detected === null) {
      return null;
    }

    return {
      kind: "git" as const,
      rootPath: detected.rootPath,
      metadataPath: detected.metadataPath,
      freshness: yield* nowFreshness(),
    };
  });

  const runLsFiles = (cwd: string, args: ReadonlyArray<string>) =>
    gitCommand(
      process,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "ls-files", "-z", ...args],
      {
        allowNonZeroExit: true,
        timeoutMs: WORKSPACE_FILES_TIMEOUT_MS,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.succeed({
              paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
              truncated: result.stdoutTruncated,
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: `git ls-files ${args.join(" ")}`,
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  // Three concurrent listings instead of `ls-files -co` piped through chunked
  // `check-ignore` runs: untracked files from `--others --exclude-standard`
  // are never ignored, so the only paths ignore rules can still remove are
  // tracked ones, which `--cached --ignored` lists directly (usually none).
  // Tracked files come first so a size cap keeps them over untracked ones.
  const listWorkspaceFiles: VcsDriver.VcsDriverShape["listWorkspaceFiles"] = Effect.fn(
    "GitVcsDriver.listWorkspaceFiles",
  )(function* (cwd, options) {
    const [tracked, ignoredTracked, untracked] = yield* Effect.all(
      [
        runLsFiles(cwd, ["--cached"]),
        runLsFiles(cwd, ["--cached", "--ignored", "--exclude-standard"]),
        options?.trackedOnly
          ? Effect.succeed({ paths: [] as string[], truncated: false })
          : runLsFiles(cwd, ["--others", "--exclude-standard"]),
      ],
      { concurrency: "unbounded" },
    );
    const ignored = ignoredTracked.paths.length > 0 ? new Set(ignoredTracked.paths) : null;
    const paths: string[] = [];
    let previousTracked: string | undefined;
    for (const trackedPath of tracked.paths) {
      // Unmerged paths are listed once per conflict stage, adjacently.
      if (trackedPath === previousTracked) continue;
      previousTracked = trackedPath;
      if (ignored?.has(trackedPath)) continue;
      paths.push(trackedPath);
    }
    for (const untrackedPath of untracked.paths) {
      paths.push(untrackedPath);
    }
    return {
      paths,
      truncated: tracked.truncated || ignoredTracked.truncated || untracked.truncated,
      freshness: yield* nowFreshness(),
    };
  });

  const listRemotes: VcsDriver.VcsDriverShape["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const result = yield* gitCommand(process, "GitVcsDriver.listRemotes", cwd, ["remote", "-v"], {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
        env: READ_ONLY_GIT_ENV,
      });

      if (result.exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.listRemotes",
          command: "git remote -v",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git remote -v failed",
        });
      }

      const parsed = parseGitRemoteVerboseOutput(result.stdout);
      const remotes = Array.from(parsed.entries()).flatMap(([name, remote]) => {
        if (!remote.url) {
          return [];
        }
        return [
          {
            name,
            url: remote.url,
            pushUrl: remote.pushUrl ? Option.some(remote.pushUrl) : Option.none(),
            isPrimary: name === "origin",
          },
        ];
      });

      return {
        remotes,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const filterIgnoredPaths: VcsDriver.VcsDriverShape["filterIgnoredPaths"] = Effect.fn(
    "filterIgnoredPaths",
  )(function* (cwd, relativePaths) {
    if (relativePaths.length === 0) {
      return relativePaths;
    }

    const ignoredPaths = new Set<string>();
    const chunks = chunkPathsForGitCheckIgnore(relativePaths);

    for (const chunk of chunks) {
      const result = yield* gitCommand(
        process,
        "GitVcsDriver.filterIgnoredPaths",
        cwd,
        [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
        {
          stdin: `${chunk.join("\0")}\0`,
          allowNonZeroExit: true,
          timeoutMs: WORKSPACE_FILES_TIMEOUT_MS,
          maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
          truncateOutputAtMaxBytes: true,
        },
      );

      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return yield* new VcsProcessExitError({
          operation: "GitVcsDriver.filterIgnoredPaths",
          command: "git check-ignore",
          cwd,
          exitCode: result.exitCode,
          detail: result.stderr.trim() || "git check-ignore failed",
        });
      }

      for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)) {
        ignoredPaths.add(ignoredPath);
      }
    }

    if (ignoredPaths.size === 0) {
      return relativePaths;
    }

    return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
  });

  const initRepository: VcsDriver.VcsDriverShape["initRepository"] = (input) =>
    gitCommand(process, "GitVcsDriver.initRepository", input.cwd, ["init"], {
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
    }).pipe(Effect.asVoid);

  return VcsDriver.VcsDriver.of({
    capabilities,
    execute,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    listRemotes,
    filterIgnoredPaths,
    initRepository,
  });
});

export const makeVcsDriver = Effect.fn("makeGitVcsDriver")(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.VcsDriver.of(driver);
});

export const make = Effect.fn("makeGitVcsDriverService")(function* () {
  const git = yield* GitVcsDriverCore.makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const vcsLayer = Layer.effect(VcsDriver.VcsDriver, makeVcsDriver());
export const layer = Layer.effect(GitVcsDriver, make());
