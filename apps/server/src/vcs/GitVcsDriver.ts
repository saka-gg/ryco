import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { Context, DateTime, Effect, Layer, Option, Queue, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  GitCommandError,
  VcsProcessExitError,
  type VcsError,
  type GitStagedIndexChangedError,
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
  type VcsListRemotesResult,
  type VcsPullResult,
  type VcsRemoveWorktreeInput,
  type VcsStatusInput,
  type VcsStatusResult,
} from "@ryco/contracts";
import { governChildProcess } from "../processGovernor.ts";
import type { VerifiedWorktreeCleanup } from "../storage/filesystem.ts";
import { makeGitGrepOutputParser } from "./gitGrepOutput.ts";
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
   * Porcelain `git diff` against the working tree ignores that variable; such
   * reads also pass {@link NO_INDEX_REFRESH_DIFF_ARGS}.
   */
  readonly readOnly?: boolean;
}

/** Environment for read-only git commands; see {@link ExecuteGitInput.readOnly}. */
export const READ_ONLY_GIT_ENV = Object.freeze({
  GIT_OPTIONAL_LOCKS: "0",
} satisfies NodeJS.ProcessEnv);

/**
 * Leading arguments for a background porcelain `git diff` that reads the
 * working tree. With `diff.autoRefreshIndex` (on by default) such a diff locks
 * and rewrites `.git/index` whenever a tracked file's stat data changed but its
 * content did not — `GIT_OPTIONAL_LOCKS=0` does not stop it. Off, those files
 * are compared by content on every read instead, and an older Git may list
 * them as unchanged `0\t0` numstat rows.
 */
export const NO_INDEX_REFRESH_DIFF_ARGS = Object.freeze([
  "-c",
  "diff.autoRefreshIndex=false",
] as const);

/**
 * Leading arguments, the `diff` subcommand included, of every internal patch
 * Ryco parses or hands on (turn diffs, comparisons, index review, pull request
 * diffs, commit and PR text generation), so the patch keeps the format Ryco
 * parses whatever the user's git config says. They override forced color
 * (`color.ui=always`), external diff tools and textconv drivers
 * (`diff.external`, `.gitattributes`), the `a/` / `b/` prefixes
 * (`diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix` /
 * `diff.dstPrefix`), the context size (`diff.context`), cwd-relative paths
 * (`diff.relative`), submodule logs in place of patches (`diff.submodule`) and
 * blank context lines printed without their leading space
 * (`diff.suppressBlankEmpty`, which has no command-line option). Rename
 * detection stays with each reader. Settings that keep a valid patch still
 * apply: the diff algorithm and hunk heuristics, file order, path quoting and
 * ignored submodules.
 */
export const INTERNAL_PATCH_DIFF_ARGS = Object.freeze([
  "-c",
  "diff.suppressBlankEmpty=false",
  "diff",
  "--patch",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--unified=3",
  "--no-relative",
  "--submodule=short",
] as const);

/**
 * Leading arguments, the `diff` subcommand included, of the `--stat` and
 * `--name-status` summaries Ryco hands on next to an
 * {@link INTERNAL_PATCH_DIFF_ARGS} patch, so both list the same files under
 * the same repository-root paths: `diff.relative` would otherwise limit the
 * summary to the cwd and shorten its paths. Summaries never run external diff
 * tools or textconv drivers and print no prefixes or hunks, so forced color is
 * the only other setting to override.
 */
export const INTERNAL_DIFF_SUMMARY_ARGS = Object.freeze([
  "diff",
  "--no-color",
  "--no-relative",
] as const);

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

/** HEAD and the staged content a staged-only commit context was read from. */
export interface GitStagedIndexGuard {
  readonly headOid: string | null;
  readonly stagedDigest: string;
}

export interface GitPreparedStagedCommitContext extends GitPreparedCommitContext {
  readonly stagedIndex: GitStagedIndexGuard;
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
  /**
   * Commit only while HEAD and the staged content are still what
   * {@link GitVcsDriverShape.prepareStagedCommitContext} read and HEAD is on
   * `branch` (a branch name, null for a detached HEAD).
   */
  readonly stagedIndex?: GitStagedIndexGuard & { readonly branch: string | null };
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
   * `details` with only what a fetch can move recomputed — ahead / behind
   * against the upstream and the ahead-of-base count — without the working-tree
   * scans of {@link statusDetailsLocal}. Null when it cannot tell (HEAD left
   * `details.branch`, the upstream is unreadable, a detached HEAD); read in full then.
   */
  readonly refreshStatusTracking: (
    cwd: string,
    details: GitStatusDetails,
  ) => Effect.Effect<GitStatusDetails | null, GitCommandError>;
  /**
   * Fetches the current branch's upstream remote unless that remote was
   * fetched recently (shared per repository and remote). Never fails; true
   * when a fetch succeeded during the call, so remote-tracking refs may have moved.
   */
  readonly refreshStatusUpstream: (cwd: string) => Effect.Effect<boolean>;
  readonly prepareCommitContext: (
    cwd: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
  /**
   * The commit context of exactly the index as it stands: nothing is reset or
   * added. Refuses unmerged entries, an empty index, and an index whose staged
   * revision is no longer `expectedRevision` (HEAD, the branch or the staged
   * content moved since the review that returned it).
   */
  readonly prepareStagedCommitContext: (
    cwd: string,
    expectedRevision: string,
  ) => Effect.Effect<GitPreparedStagedCommitContext, GitCommandError | GitStagedIndexChangedError>;
  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
    options?: GitCommitOptions,
  ) => Effect.Effect<{ commitSha: string }, GitCommandError | GitStagedIndexChangedError>;
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
/**
 * A tracked-only listing (the workspace index's cold-read stand-in and its
 * fallback for a failed full listing) must cost one index read. Its ignore
 * filter reads `.gitignore` in every tracked directory, slow on network
 * volumes, so it is best effort within this budget.
 */
const WORKSPACE_TRACKED_IGNORE_FILTER_BUDGET_MS = 1_500;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;
const WORKSPACE_GREP_ENV = Object.freeze({
  ...READ_ONLY_GIT_ENV,
  // Unicode case folding for -i, as the workspace's own scanner folds; where
  // the locale is missing git falls back to C and folds ASCII only.
  LC_ALL: "C.UTF-8",
} satisfies NodeJS.ProcessEnv);
/** Matching files parsed ahead of the reader; git pauses on a full pipe after that. */
const WORKSPACE_GREP_BUFFERED_FILES = 16;

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

const REPOSITORY_MEMO_CAPACITY = 512;

/**
 * Answers per working directory, each valid while the repository metadata
 * fingerprint it was read under still matches. Least recently used entries go
 * first once the capacity is reached.
 */
interface RepositoryMemo<A> {
  readonly get: (cwd: string, fingerprint: string) => A | undefined;
  readonly set: (cwd: string, fingerprint: string, value: A) => void;
}

function makeRepositoryMemo<A>(): RepositoryMemo<A> {
  const entries = new Map<string, { readonly fingerprint: string; readonly value: A }>();
  return {
    get: (cwd, fingerprint) => {
      const entry = entries.get(cwd);
      if (entry === undefined) return undefined;
      entries.delete(cwd);
      if (entry.fingerprint !== fingerprint) return undefined;
      entries.set(cwd, entry);
      return entry.value;
    },
    set: (cwd, fingerprint, value) => {
      entries.delete(cwd);
      entries.set(cwd, { fingerprint, value });
      if (entries.size > REPOSITORY_MEMO_CAPACITY) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
  };
}

/**
 * Size, modification time and inode of a file, or null when it cannot be read.
 * Git replaces its files by renaming a lock file over them, so the inode
 * catches a rewrite that keeps the size and lands within one timestamp tick.
 */
const readFileSignature = (target: string) =>
  stat(target).then(
    (stats) => `${stats.size}:${stats.mtimeMs}:${stats.ino}`,
    () => null,
  );

/** The git directory a `.git` file names (linked worktrees, submodules). */
async function readGitDirPointer(dotGitFile: string): Promise<string | null> {
  const contents = await readFile(dotGitFile, "utf8").catch(() => null);
  const pointer = contents === null ? undefined : /^gitdir:\s*(.+?)\s*$/m.exec(contents)?.[1];
  return pointer ? path.resolve(path.dirname(dotGitFile), pointer) : null;
}

/**
 * A key for what git's answers about the repository enclosing `cwd` are read
 * from, built from a few `stat` calls and no process spawn: the checkout that
 * owns the nearest `.git`, the shared git directory, and the signature of its
 * `config` (where remotes live) and, with `includeHead`, of the checkout's
 * `HEAD` (git stops treating a directory as a repository without one).
 *
 * Null whenever the layout is unexpected or unreadable (no repository, a bare
 * one, a missing directory): such answers are asked of git every time.
 */
async function readRepositoryMetadataFingerprint(
  cwd: string,
  options: { readonly includeHead: boolean },
): Promise<string | null> {
  try {
    let directory = path.resolve(cwd);
    if (!(await stat(directory)).isDirectory()) return null;
    for (;;) {
      const dotGit = path.join(directory, ".git");
      const entry = await stat(dotGit).catch(() => null);
      if (entry !== null) {
        const gitDir = entry.isDirectory() ? dotGit : await readGitDirPointer(dotGit);
        if (gitDir === null) return null;
        const commonDirPointer = (
          await readFile(path.join(gitDir, "commondir"), "utf8").catch(() => "")
        ).trim();
        const commonDir = commonDirPointer ? path.resolve(gitDir, commonDirPointer) : gitDir;
        const [config, head] = await Promise.all([
          readFileSignature(path.join(commonDir, "config")),
          options.includeHead ? readFileSignature(path.join(gitDir, "HEAD")) : "",
        ]);
        return config === null || head === null
          ? null
          : [directory, commonDir, config, head].join("\0");
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  } catch {
    return null;
  }
}

/**
 * Answers from the memo while the repository metadata behind `cwd` is
 * unchanged, otherwise from `compute`. The fingerprint is read before
 * computing, so a change made meanwhile only makes the next call recompute.
 * Only values that pass `remember` are kept: a folder that is not a
 * repository may become one, so that answer is asked again.
 */
const memoizeByRepositoryMetadata = <A, E, R>(
  memo: RepositoryMemo<A>,
  cwd: string,
  options: {
    readonly includeHead: boolean;
    readonly remember?: (value: A) => boolean;
  },
  compute: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const fingerprint = yield* Effect.promise(() =>
      readRepositoryMetadataFingerprint(cwd, options),
    );
    if (fingerprint === null) return yield* compute;
    const key = path.resolve(cwd);
    const cached = memo.get(key, fingerprint);
    if (cached !== undefined) return cached;
    const value = yield* compute;
    if (options.remember?.(value) ?? true) memo.set(key, fingerprint, value);
    return value;
  });

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

  // Repositories and their remotes rarely change, but they are asked for
  // constantly: each answer is kept until the repository's metadata files change.
  const detectedRepositories = makeRepositoryMemo<ReturnType<typeof parseDetectRepositoryOutput>>();
  const listedRemotes = makeRepositoryMemo<VcsListRemotesResult["remotes"]>();

  // One rev-parse prints all three answers (one line each); outside a work
  // tree (no repository, a bare one, inside .git) it exits nonzero or says false.
  const detectRepository: VcsDriver.VcsDriverShape["detectRepository"] = Effect.fn(
    "detectRepository",
  )(function* (cwd) {
    const detected = yield* memoizeByRepositoryMetadata(
      detectedRepositories,
      cwd,
      { includeHead: true, remember: (detected) => detected !== null },
      gitCommand(
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
      ).pipe(Effect.map((result) => parseDetectRepositoryOutput(result.exitCode, result.stdout))),
    );
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
  // Tracked-only listings are flagged partial by their reader, so a late
  // ignore filter is skipped (a force-added ignored file may show) rather
  // than holding back an index read that takes milliseconds.
  const listWorkspaceFiles: VcsDriver.VcsDriverShape["listWorkspaceFiles"] = Effect.fn(
    "GitVcsDriver.listWorkspaceFiles",
  )(function* (cwd, options) {
    const noPaths = { paths: [] as string[], truncated: false };
    const ignoredTrackedListing = runLsFiles(cwd, ["--cached", "--ignored", "--exclude-standard"]);
    const [tracked, ignoredTracked, untracked] = yield* Effect.all(
      [
        runLsFiles(cwd, ["--cached"]),
        options?.trackedOnly
          ? ignoredTrackedListing.pipe(
              Effect.timeoutOption(WORKSPACE_TRACKED_IGNORE_FILTER_BUDGET_MS),
              Effect.map(Option.getOrElse(() => noPaths)),
              Effect.catch(() => Effect.succeed(noPaths)),
            )
          : ignoredTrackedListing,
        options?.trackedOnly
          ? Effect.succeed(noPaths)
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

  // `--untracked` searches the files `listWorkspaceFiles` lists, ignore rules
  // applied, sorted by path. The query goes to stdin, never into the arguments
  // (process lists, error text), and every option the user's config could
  // change (`grep.fullName`, `grep.patternType`, `color.grep`,
  // `submodule.recurse`) is set explicitly.
  const streamWorkspaceContentMatches: NonNullable<
    VcsDriver.VcsDriverShape["streamWorkspaceContentMatches"]
  > = (cwd, options) =>
    Stream.callback<VcsDriver.VcsWorkspaceContentFile, VcsError>(
      (queue) =>
        governChildProcess(
          "git",
          process.withProcess(
            {
              operation: "GitVcsDriver.streamWorkspaceContentMatches",
              command: "git",
              args: [
                ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
                "-c",
                "grep.fullName=false",
                "grep",
                "--untracked",
                "--no-recurse-submodules",
                "--threads=4",
                "-I",
                "-n",
                "--column",
                "-z",
                "--no-color",
                "-F",
                ...(options.caseSensitive ? [] : ["-i"]),
                ...(options.wholeWord ? ["-w"] : []),
                "-f",
                "-",
                "--",
                ".",
                ...options.excludedTopLevelNames.map((name) => `:(exclude,literal)${name}`),
              ],
              cwd,
              env: WORKSPACE_GREP_ENV,
            },
            (child) => {
              const parser = makeGitGrepOutputParser(options);
              return Effect.all(
                [
                  child.writeStdin(options.query),
                  // Warnings (an unreadable folder) are dropped; an undrained pipe would stall git.
                  Stream.runDrain(child.stderr),
                  Stream.runForEach(child.stdout, (chunk) =>
                    Queue.offerAll(queue, parser.push(chunk)),
                  ).pipe(
                    Effect.andThen(child.exitCode),
                    Effect.flatMap((exitCode) =>
                      // 1: nothing matched.
                      exitCode === 0 || exitCode === 1
                        ? Queue.offerAll(queue, parser.end())
                        : Effect.fail(
                            new VcsProcessExitError({
                              operation: "GitVcsDriver.streamWorkspaceContentMatches",
                              command: "git grep",
                              cwd,
                              exitCode,
                              detail: `git grep exited with code ${exitCode}.`,
                            }),
                          ),
                    ),
                  ),
                ],
                { concurrency: "unbounded", discard: true },
              );
            },
          ),
        ).pipe(Effect.andThen(Queue.end(queue))),
      { bufferSize: WORKSPACE_GREP_BUFFERED_FILES, strategy: "suspend" },
    );

  const listRemotes: VcsDriver.VcsDriverShape["listRemotes"] = Effect.fn("listRemotes")(
    function* (cwd) {
      const remotes = yield* memoizeByRepositoryMetadata(
        listedRemotes,
        cwd,
        { includeHead: false },
        Effect.gen(function* () {
          const result = yield* gitCommand(
            process,
            "GitVcsDriver.listRemotes",
            cwd,
            ["remote", "-v"],
            {
              allowNonZeroExit: true,
              timeoutMs: 5_000,
              maxOutputBytes: 64 * 1024,
              env: READ_ONLY_GIT_ENV,
            },
          );

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
          return Array.from(parsed.entries()).flatMap(([name, remote]) => {
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
        }),
      );

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
    streamWorkspaceContentMatches,
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
