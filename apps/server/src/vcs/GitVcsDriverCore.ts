import { resolveWorktreeCheckoutPath } from "../project/worktreeCheckoutPaths.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { acquireWorktreeCreationLease, recordCreatedWorktree } from "../storage/lifecycle.ts";
import { removeVerifiedWorktree } from "../storage/filesystem.ts";
import type { Dirent } from "node:fs";
import fsPromises from "node:fs/promises";
import nodePath from "node:path";

import {
  Cache,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Ref,
  RcMap,
  Result,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DEFAULT_SERVER_SETTINGS, GitCommandError, type VcsRef } from "@ryco/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@ryco/shared/git";
import { makeKeyedSerialExecutor } from "@ryco/shared/KeyedSerialExecutor";
import { makeKeyedSingleFlight } from "@ryco/shared/KeyedSingleFlight";
import { withGitFilesystemGuidance } from "../git/gitFilesystemErrors.ts";
import { compactTraceAttributes } from "../observability/Attributes.ts";
import { gitCommandDuration, gitCommandsTotal, withMetrics } from "../observability/Metrics.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import { readCheckoutHead } from "./gitCheckoutHead.ts";
import {
  parseRemoteNames,
  parseRemoteNamesInGitOrder,
  parseRemoteRefWithRemoteNames,
} from "../git/remoteRefs.ts";
import { ServerConfig } from "../config.ts";
import { governChildProcess } from "../processGovernor.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  canonicalizeWorktreePath,
  selectConfiguredWorktreeRoot,
  validateWorktreeRoot,
} from "../project/worktreeRoot.ts";
import {
  assertWorktreeSetupComplete,
  beginWorktreeSetup,
  finishWorktreeSetup,
  recoverOrphanedWorktreeSetup,
  withWorktreeSetupOwnership,
} from "../project/worktreeSetupState.ts";
import { resolveWorktreeSubmodules } from "../project/worktreeSubmodules.ts";
import { makeWorkspaceAccessPolicy } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import { decodeJsonResult } from "@ryco/shared/schemaJson";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";
const PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES = 49_000;
const RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES = 19_000;
const RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES = 59_000;
const STATUS_UPSTREAM_REFRESH_INTERVAL = Duration.seconds(15);
const STATUS_UPSTREAM_REFRESH_TIMEOUT = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN = Duration.seconds(5);
const STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY = 2_048;
const STATUS_UPSTREAM_REFRESH_CONCURRENCY = 2;
const STATUS_UPSTREAM_REFRESH_ENV = Object.freeze({
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv);
const DEFAULT_BASE_BRANCH_CANDIDATES = ["main", "master"] as const;
const CONFIG_SNAPSHOT_CACHE_CAPACITY = 2_048;
const CONFIG_SNAPSHOT_CACHE_TTL = Duration.seconds(5);
const BRANCH_LISTING_CACHE_CAPACITY = 256;
const BRANCH_LISTING_CACHE_TTL = Duration.seconds(5);
const GIT_LIST_BRANCHES_DEFAULT_LIMIT = 100;
const DEPENDENCY_INSTALL_DIR_NAME = "node_modules";
const DEPENDENCY_INSTALL_DIR_SCAN_SKIP_DIRS = new Set([".git", ".ryco"]);
const NON_REPOSITORY_STATUS_DETAILS = Object.freeze<GitVcsDriver.GitStatusDetails>({
  isRepo: false,
  hasOriginRemote: false,
  isDefaultBranch: false,
  branch: null,
  upstreamRef: null,
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: false,
  aheadCount: 0,
  behindCount: 0,
  aheadOfDefaultCount: 0,
});

type GitDiffTotals = {
  files: Array<{ path: string; insertions: number; deletions: number }>;
  insertions: number;
  deletions: number;
};
const emptyDiffTotals = (): GitDiffTotals => ({ files: [], insertions: 0, deletions: 0 });

type TraceTailState = {
  processedChars: number;
  remainder: string;
};

class CommittedDiffCacheKey extends Data.Class<{
  cwd: string;
  baseCommit: string;
  headCommit: string;
}> {}

class StatusRemoteRefreshCacheKey extends Data.Class<{
  gitCommonDir: string;
  remoteName: string;
}> {}

interface ExecuteGitOptions {
  stdin?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  timeoutMs?: number | undefined;
  allowNonZeroExit?: boolean | undefined;
  fallbackErrorMessage?: string | undefined;
  maxOutputBytes?: number | undefined;
  truncateOutputAtMaxBytes?: boolean | undefined;
  progress?: GitVcsDriver.ExecuteGitProgress | undefined;
  /** See {@link GitVcsDriver.ExecuteGitInput.readOnly}. */
  readOnly?: boolean | undefined;
}

/** Whether a status compares the branch against a base: no upstream, or not the default branch. */
function statusNeedsBase(upstreamRef: string | null, isDefaultBranch: boolean): boolean {
  return upstreamRef === null || !isDefaultBranch;
}

/** `git rev-list --left-right --count A...B` output: commits only in A, then only in B. */
function parseLeftRightCounts(stdout: string): { left: number; right: number } | null {
  const match = /^(\d+)\s+(\d+)$/.exec(stdout.trim());
  return match ? { left: Number(match[1]), right: Number(match[2]) } : null;
}

function parseBranchAb(value: string): { ahead: number; behind: number } {
  const match = value.match(/^\+(\d+)\s+-(\d+)$/);
  if (!match) return { ahead: 0, behind: 0 };
  return {
    ahead: Number(match[1] ?? "0"),
    behind: Number(match[2] ?? "0"),
  };
}

function parseNumstatEntries(
  stdout: string,
): Array<{ path: string; insertions: number; deletions: number }> {
  const entries: Array<{ path: string; insertions: number; deletions: number }> = [];
  for (const line of stdout.split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split("\t");
    const rawPath =
      pathParts.length > 1 ? (pathParts.at(-1) ?? "").trim() : pathParts.join("\t").trim();
    if (rawPath.length === 0) continue;
    const added = Number.parseInt(addedRaw ?? "0", 10);
    const deleted = Number.parseInt(deletedRaw ?? "0", 10);
    const normalizedPath = numstatDestinationPath(rawPath);
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

/** The new path of a numstat rename (`old => new` or `dir/{old => new}/file`). */
function numstatDestinationPath(rawPath: string): string {
  const braced = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(rawPath);
  if (braced) {
    const [, prefix = "", , destination = "", suffix = ""] = braced;
    // `a/{ => b}/c` and `a/{b => }/c` leave a doubled separator.
    return `${prefix}${destination}${suffix}`.replace(/\/{2,}/g, "/");
  }
  const renameArrowIndex = rawPath.indexOf(" => ");
  return renameArrowIndex >= 0 ? rawPath.slice(renameArrowIndex + " => ".length).trim() : rawPath;
}

/** Space-separated fields before the path in each porcelain v2 entry type. */
const PORCELAIN_V2_FIELDS_BEFORE_PATH: Readonly<Record<string, number>> = {
  "1": 8,
  "2": 9,
  u: 10,
};

function parsePorcelainPath(line: string): string | null {
  if (line.startsWith("? ") || line.startsWith("! ")) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }

  const fieldsBeforePath = line[1] === " " ? PORCELAIN_V2_FIELDS_BEFORE_PATH[line[0] ?? ""] : null;
  if (fieldsBeforePath === undefined || fieldsBeforePath === null) {
    return null;
  }

  // The path may contain spaces; a rename (`2`) appends a tab and its original path.
  let pathStart = 0;
  for (let field = 0; field < fieldsBeforePath; field += 1) {
    const separator = line.indexOf(" ", pathStart);
    if (separator < 0) return null;
    pathStart = separator + 1;
  }
  const rest = line.slice(pathStart);
  const filePath = line[0] === "2" ? (rest.split("\t")[0] ?? "") : rest;
  return filePath.length > 0 ? filePath : null;
}

const LIST_REFS_FIELDS_WITHOUT_WORKTREE = [
  "%(refname)",
  "%(committerdate:unix)",
  "%(HEAD)",
  "%(symref)",
] as const;
const LIST_REFS_FIELDS = [...LIST_REFS_FIELDS_WITHOUT_WORKTREE, "%(worktreepath)"] as const;
const LIST_REFS_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

interface ListedRef {
  readonly refname: string;
  readonly lastCommit: number;
  readonly isHead: boolean;
  readonly symref: string;
  /** Empty when not checked out, or when the field was not requested. */
  readonly worktreePath: string;
}

/** Parses `for-each-ref` output in {@link LIST_REFS_FIELDS} order (NUL-separated fields). */
export function parseListedRefs(stdout: string): ReadonlyArray<ListedRef> {
  const refs: ListedRef[] = [];
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [refname = "", lastCommitRaw = "", head = "", symref = "", worktreePath = ""] =
      line.split("\0");
    if (refname.length === 0) continue;
    const lastCommit = Number.parseInt(lastCommitRaw, 10);
    refs.push({
      refname,
      lastCommit: Number.isFinite(lastCommit) ? lastCommit : 0,
      isHead: head.trim() === "*",
      symref: symref.trim(),
      worktreePath,
    });
  }
  return refs;
}

function filterBranchesForListQuery(
  refs: ReadonlyArray<VcsRef>,
  query?: string,
): ReadonlyArray<VcsRef> {
  if (!query) {
    return refs;
  }

  const normalizedQuery = query.toLowerCase();
  return refs.filter((refName) => refName.name.toLowerCase().includes(normalizedQuery));
}

function paginateBranches(input: {
  refs: ReadonlyArray<VcsRef>;
  cursor?: number | undefined;
  limit?: number | undefined;
}): {
  refs: ReadonlyArray<VcsRef>;
  nextCursor: number | null;
  totalCount: number;
} {
  const cursor = input.cursor ?? 0;
  const limit = input.limit ?? GIT_LIST_BRANCHES_DEFAULT_LIMIT;
  const totalCount = input.refs.length;
  const refs = input.refs.slice(cursor, cursor + limit);
  const nextCursor = cursor + refs.length < totalCount ? cursor + refs.length : null;

  return {
    refs,
    nextCursor,
    totalCount,
  };
}

function sanitizeRemoteName(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized : "fork";
}

function normalizeRemoteUrl(value: string): string {
  return value
    .trim()
    .replace(/\/+$/g, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

/** What base-branch resolution reads from config and refs before probing candidates. */
interface BaseBranchResolutionContext {
  readonly configuredBaseBranch: string | null;
  readonly primaryRemoteName: string | null;
  readonly defaultBranch: string | null;
}

interface BaseBranchCandidate {
  readonly name: string;
  readonly localRef: string;
  readonly remoteRef: string | null;
}

/**
 * Base branch candidates in preference order: the configured merge base, the
 * primary remote's default branch, then main / master. Each is tried as a
 * local branch first, then as the primary remote's branch.
 */
function baseBranchCandidates(
  refName: string,
  context: BaseBranchResolutionContext,
): ReadonlyArray<BaseBranchCandidate> {
  const { primaryRemoteName } = context;
  const remotePrefix =
    primaryRemoteName && primaryRemoteName !== "origin" ? `${primaryRemoteName}/` : null;
  const seen = new Set<string>();
  const candidates: BaseBranchCandidate[] = [];
  for (const candidate of [
    context.configuredBaseBranch,
    context.defaultBranch,
    ...DEFAULT_BASE_BRANCH_CANDIDATES,
  ]) {
    if (!candidate) continue;
    const name = candidate.startsWith("origin/")
      ? candidate.slice("origin/".length)
      : remotePrefix && candidate.startsWith(remotePrefix)
        ? candidate.slice(remotePrefix.length)
        : candidate;
    if (name.length === 0 || name === refName || seen.has(name)) continue;
    seen.add(name);
    candidates.push({
      name,
      localRef: `refs/heads/${name}`,
      remoteRef: primaryRemoteName ? `refs/remotes/${primaryRemoteName}/${name}` : null,
    });
  }
  return candidates;
}

/** Lowercases a config key's section and name; the subsection keeps its case, as in git. */
function normalizeGitConfigKey(key: string): string {
  const first = key.indexOf(".");
  const last = key.lastIndexOf(".");
  if (first < 0 || first === last) return key.toLowerCase();
  return `${key.slice(0, first).toLowerCase()}${key.slice(first, last)}${key.slice(last).toLowerCase()}`;
}

/** Parses `git config -z --list` (entries `key\nvalue\0`, or `key\0` without a value). */
export function parseGitConfigList(stdout: string): GitVcsDriver.GitConfigSnapshot {
  const values = new Map<string, string>();
  const remoteNames: string[] = [];
  for (const entry of stdout.split("\0")) {
    if (entry.length === 0) continue;
    const newlineIndex = entry.indexOf("\n");
    const key = normalizeGitConfigKey(newlineIndex >= 0 ? entry.slice(0, newlineIndex) : entry);
    // Last value wins, matching `git config --get`.
    values.set(key, newlineIndex >= 0 ? entry.slice(newlineIndex + 1) : "");
    if (key.startsWith("remote.")) {
      const nameEnd = key.lastIndexOf(".");
      if (nameEnd > "remote.".length) {
        const remoteName = key.slice("remote.".length, nameEnd);
        if (!remoteNames.includes(remoteName)) remoteNames.push(remoteName);
      }
    }
  }
  return {
    get: (key) => {
      const value = values.get(normalizeGitConfigKey(key))?.trim() ?? "";
      return value.length > 0 ? value : null;
    },
    remoteNames,
  };
}

/** `origin`, else the first remote `git remote` lists (it sorts them by name). */
function primaryRemoteFromNames(remoteNames: ReadonlyArray<string>): string | null {
  return remoteNames.includes("origin") ? "origin" : (remoteNames.toSorted()[0] ?? null);
}

function parseUpstreamRefWithRemoteNames(
  upstreamRef: string,
  remoteNames: ReadonlyArray<string>,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const parsed = parseRemoteRefWithRemoteNames(upstreamRef, remoteNames);
  if (!parsed) {
    return null;
  }

  return {
    upstreamRef,
    remoteName: parsed.remoteName,
    branchName: parsed.branchName,
  };
}

function parseUpstreamRefByFirstSeparator(
  upstreamRef: string,
): { upstreamRef: string; remoteName: string; branchName: string } | null {
  const separatorIndex = upstreamRef.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === upstreamRef.length - 1) {
    return null;
  }

  const remoteName = upstreamRef.slice(0, separatorIndex).trim();
  const branchName = upstreamRef.slice(separatorIndex + 1).trim();
  if (remoteName.length === 0 || branchName.length === 0) {
    return null;
  }

  return {
    upstreamRef,
    remoteName,
    branchName,
  };
}

function parseTrackingBranchByUpstreamRef(stdout: string, upstreamRef: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      continue;
    }
    const [branchNameRaw, upstreamBranchRaw = ""] = trimmedLine.split("\t");
    const branchName = branchNameRaw?.trim() ?? "";
    const candidateUpstreamRef = upstreamBranchRaw.trim();
    if (branchName.length === 0 || candidateUpstreamRef.length === 0) {
      continue;
    }
    if (candidateUpstreamRef === upstreamRef) {
      return branchName;
    }
  }

  return null;
}

function deriveLocalBranchNameFromRemoteRef(branchName: string): string | null {
  const separatorIndex = branchName.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === branchName.length - 1) {
    return null;
  }
  const localBranch = branchName.slice(separatorIndex + 1).trim();
  return localBranch.length > 0 ? localBranch : null;
}

function commandLabel(args: readonly string[]): string {
  return `git ${args.join(" ")}`;
}

function parseDefaultBranchFromRemoteHeadRef(value: string, remoteName: string): string | null {
  const trimmed = value.trim();
  const prefix = `refs/remotes/${remoteName}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const refName = trimmed.slice(prefix.length).trim();
  return refName.length > 0 ? refName : null;
}

function createGitCommandError(
  operation: string,
  cwd: string,
  args: readonly string[],
  detail: string,
  cause?: unknown,
): GitCommandError {
  return new GitCommandError({
    operation,
    command: commandLabel(args),
    cwd,
    detail: withGitFilesystemGuidance(detail),
    ...(cause !== undefined ? { cause } : {}),
  });
}

function quoteGitCommand(args: ReadonlyArray<string>): string {
  return `git ${args.join(" ")}`;
}

function isMissingGitCwdError(error: GitCommandError): boolean {
  const normalized = `${error.detail}\n${error.message}`.toLowerCase();
  return (
    normalized.includes("no such file or directory") ||
    normalized.includes("notfound: filesystem.access") ||
    normalized.includes("enoent") ||
    normalized.includes("not a directory")
  );
}

function toGitCommandError(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  detail: string,
) {
  return (cause: unknown) =>
    Schema.is(GitCommandError)(cause)
      ? cause
      : new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${cause instanceof Error && cause.message.length > 0 ? cause.message : "Unknown error"} - ${detail}`,
          ...(cause !== undefined ? { cause } : {}),
        });
}

interface Trace2Monitor {
  readonly env: NodeJS.ProcessEnv;
  readonly flush: Effect.Effect<void, never>;
}

const nowUnixNano = DateTime.now.pipe(
  Effect.map((now) => BigInt(DateTime.toEpochMillis(now)) * 1_000_000n),
);

const addCurrentSpanEvent = (name: string, attributes: Record<string, unknown>) =>
  Effect.gen(function* () {
    const span = yield* Effect.currentSpan;
    const timestamp = yield* nowUnixNano;
    yield* Effect.sync(() => {
      span.event(name, timestamp, compactTraceAttributes(attributes));
    });
  }).pipe(Effect.catch(() => Effect.void));

function trace2ChildKey(record: Record<string, unknown>): string | null {
  const childId = record.child_id;
  if (typeof childId === "number" || typeof childId === "string") {
    return String(childId);
  }
  const hookName = record.hook_name;
  return typeof hookName === "string" && hookName.trim().length > 0 ? hookName.trim() : null;
}

const Trace2Record = Schema.Record(Schema.String, Schema.Unknown);

const createTrace2Monitor = Effect.fn("createTrace2Monitor")(function* (
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  progress: GitVcsDriver.ExecuteGitProgress | undefined,
): Effect.fn.Return<
  Trace2Monitor,
  PlatformError.PlatformError,
  Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  if (!progress?.onHookStarted && !progress?.onHookFinished) {
    return {
      env: {},
      flush: Effect.void,
    };
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const traceFilePath = yield* fs.makeTempFileScoped({
    prefix: `ryco-git-trace2-${process.pid}-`,
    suffix: ".json",
  });
  const hookStartByChildKey = new Map<string, { hookName: string; startedAtMs: number }>();
  const traceTailState = yield* Ref.make<TraceTailState>({
    processedChars: 0,
    remainder: "",
  });

  const handleTraceLine = Effect.fn("handleTraceLine")(function* (line: string) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) {
      return;
    }

    const traceRecord = decodeJsonResult(Trace2Record)(trimmedLine);
    if (Result.isFailure(traceRecord)) {
      yield* Effect.logDebug(
        `GitVcsDriver.trace2: failed to parse trace line for ${quoteGitCommand(input.args)} in ${input.cwd}`,
        traceRecord.failure,
      );
      return;
    }

    if (traceRecord.success.child_class !== "hook") {
      return;
    }

    const event = traceRecord.success.event;
    const childKey = trace2ChildKey(traceRecord.success);
    if (childKey === null) {
      return;
    }
    const started = hookStartByChildKey.get(childKey);
    const hookNameFromEvent =
      typeof traceRecord.success.hook_name === "string" ? traceRecord.success.hook_name.trim() : "";
    const hookName = hookNameFromEvent.length > 0 ? hookNameFromEvent : (started?.hookName ?? "");
    if (hookName.length === 0) {
      return;
    }

    if (event === "child_start") {
      const now = yield* DateTime.now;
      hookStartByChildKey.set(childKey, { hookName, startedAtMs: DateTime.toEpochMillis(now) });
      yield* addCurrentSpanEvent("git.hook.started", {
        hookName,
      });
      if (progress.onHookStarted) {
        yield* progress.onHookStarted(hookName);
      }
      return;
    }

    if (event === "child_exit") {
      hookStartByChildKey.delete(childKey);
      const code = traceRecord.success.exitCode;
      const exitCode = typeof code === "number" && Number.isInteger(code) ? code : null;
      const now = yield* DateTime.now;
      const durationMs = started
        ? Math.max(0, DateTime.toEpochMillis(now) - started.startedAtMs)
        : null;
      yield* addCurrentSpanEvent("git.hook.finished", {
        hookName: started?.hookName ?? hookName,
        exitCode,
        durationMs,
      });
      if (progress.onHookFinished) {
        yield* progress.onHookFinished({
          hookName: started?.hookName ?? hookName,
          exitCode,
          durationMs,
        });
      }
    }
  });

  const deltaMutex = yield* Semaphore.make(1);
  const readTraceDelta = deltaMutex.withPermit(
    fs.readFileString(traceFilePath).pipe(
      Effect.flatMap((contents) =>
        Effect.uninterruptible(
          Ref.modify(traceTailState, ({ processedChars, remainder }) => {
            if (contents.length <= processedChars) {
              return [[], { processedChars, remainder }];
            }

            const appended = contents.slice(processedChars);
            const combined = remainder + appended;
            const lines = combined.split("\n");
            const nextRemainder = lines.pop() ?? "";

            return [
              lines.map((line) => line.replace(/\r$/, "")),
              {
                processedChars: contents.length,
                remainder: nextRemainder,
              },
            ];
          }).pipe(
            Effect.flatMap((lines) => Effect.forEach(lines, handleTraceLine, { discard: true })),
          ),
        ),
      ),
      Effect.ignore({ log: true }),
    ),
  );
  const traceFileName = path.basename(traceFilePath);
  yield* Stream.runForEach(fs.watch(traceFilePath), (event) => {
    const eventPath = event.path;
    const isTargetTraceEvent =
      eventPath === traceFilePath ||
      eventPath === traceFileName ||
      path.basename(eventPath) === traceFileName;
    if (!isTargetTraceEvent) return Effect.void;
    return readTraceDelta;
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  const finalizeTrace2Monitor = Effect.fn("finalizeTrace2Monitor")(function* () {
    yield* readTraceDelta;
    const finalLine = yield* Ref.modify(traceTailState, ({ processedChars, remainder }) => [
      remainder.trim(),
      {
        processedChars,
        remainder: "",
      },
    ]);
    if (finalLine.length > 0) {
      yield* handleTraceLine(finalLine);
    }
  });

  yield* Effect.addFinalizer(finalizeTrace2Monitor);

  return {
    env: {
      GIT_TRACE2_EVENT: traceFilePath,
    },
    flush: readTraceDelta,
  };
});

const GIT_CHECKOUT_PROGRESS_LINE = /^Updating files:\s+(\d{1,3})%/;

/** The percentage of a `git checkout` meter line (`Updating files:  78% (2104/2700)`). */
export function parseGitCheckoutProgressPercent(line: string): number | null {
  const match = GIT_CHECKOUT_PROGRESS_LINE.exec(line);
  if (!match) return null;
  const percent = Number(match[1]);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
}

const collectOutput = Effect.fn("collectOutput")(function* <E>(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
  truncateOutputAtMaxBytes: boolean,
  onLine: ((line: string) => Effect.Effect<void, never>) | undefined,
  splitAtCarriageReturn = false,
): Effect.fn.Return<{ readonly text: string; readonly truncated: boolean }, GitCommandError> {
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let lineBuffer = "";
  let truncated = false;

  // The index that ends the next line. A bare `\r` ends one only when asked,
  // and one at the end of the buffer waits: the next chunk may start with
  // the `\n` that makes it a plain line break.
  const nextLineBreak = (): number => {
    if (!splitAtCarriageReturn) return lineBuffer.indexOf("\n");
    for (let index = 0; index < lineBuffer.length; index += 1) {
      const character = lineBuffer[index];
      if (character === "\n") return index;
      if (character === "\r") {
        if (index + 1 === lineBuffer.length) return -1;
        return lineBuffer[index + 1] === "\n" ? index + 1 : index;
      }
    }
    return -1;
  };

  const emitCompleteLines = Effect.fn("emitCompleteLines")(function* (flush: boolean) {
    let newlineIndex = nextLineBreak();
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      if (line.length > 0 && onLine) {
        yield* onLine(line);
      }
      newlineIndex = nextLineBreak();
    }

    if (flush) {
      const trailing = lineBuffer.replace(/\r$/, "");
      lineBuffer = "";
      if (trailing.length > 0 && onLine) {
        yield* onLine(trailing);
      }
    }
  });

  const processChunk = Effect.fn("processChunk")(function* (chunk: Uint8Array) {
    if (truncateOutputAtMaxBytes && truncated) {
      return;
    }
    const nextBytes = bytes + chunk.byteLength;
    if (!truncateOutputAtMaxBytes && nextBytes > maxOutputBytes) {
      return yield* new GitCommandError({
        operation: input.operation,
        command: quoteGitCommand(input.args),
        cwd: input.cwd,
        detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes and was truncated.`,
      });
    }

    const chunkToDecode =
      truncateOutputAtMaxBytes && nextBytes > maxOutputBytes
        ? chunk.subarray(0, Math.max(0, maxOutputBytes - bytes))
        : chunk;
    bytes += chunkToDecode.byteLength;
    truncated = truncateOutputAtMaxBytes && nextBytes > maxOutputBytes;

    const decoded = decoder.decode(chunkToDecode, { stream: !truncated });
    text += decoded;
    lineBuffer += decoded;
    yield* emitCompleteLines(false);
  });

  yield* Stream.runForEach(stream, processChunk).pipe(
    Effect.mapError(toGitCommandError(input, "output stream failed.")),
  );

  const remainder = truncated ? "" : decoder.decode();
  text += remainder;
  lineBuffer += remainder;
  yield* emitCompleteLines(true);
  return {
    text,
    truncated,
  };
});

/** Undecoded stdout for object contents; a partial object is never returned. */
const collectOutputBytes = Effect.fn("collectOutputBytes")(function* <E>(
  input: Pick<GitVcsDriver.ExecuteGitInput, "operation" | "cwd" | "args">,
  stream: Stream.Stream<Uint8Array, E>,
  maxOutputBytes: number,
): Effect.fn.Return<Uint8Array, GitCommandError> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  yield* Stream.runForEach(stream, (chunk) => {
    bytes += chunk.byteLength;
    if (bytes > maxOutputBytes) {
      return Effect.fail(
        new GitCommandError({
          operation: input.operation,
          command: quoteGitCommand(input.args),
          cwd: input.cwd,
          detail: `${quoteGitCommand(input.args)} output exceeded ${maxOutputBytes} bytes.`,
        }),
      );
    }
    chunks.push(chunk);
    return Effect.void;
  }).pipe(Effect.mapError(toGitCommandError(input, "output stream failed.")));
  return Buffer.concat(chunks, bytes);
});

const copyWorktreeDependencyInstallDirs = Effect.fn("copyWorktreeDependencyInstallDirs")(
  function* (input: {
    readonly cwd: string;
    readonly worktreePath: string;
  }): Effect.fn.Return<void, GitCommandError> {
    const dependencyInstallDirs = yield* Effect.tryPromise({
      try: async () => {
        const dirs: string[] = [];

        const walk = async (dir: string): Promise<void> => {
          let entries: Dirent[];
          try {
            entries = await fsPromises.readdir(dir, { withFileTypes: true });
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
              return;
            }
            throw cause;
          }

          for (const entry of entries) {
            const entryPath = nodePath.join(dir, entry.name);
            if (DEPENDENCY_INSTALL_DIR_SCAN_SKIP_DIRS.has(entry.name)) {
              continue;
            }
            if (entry.name === DEPENDENCY_INSTALL_DIR_NAME) {
              dirs.push(entryPath);
              continue;
            }
            if (entry.isDirectory()) {
              await walk(entryPath);
            }
          }
        };

        await walk(input.cwd);
        return dirs.toSorted((left, right) => {
          const leftRelative = nodePath.relative(input.cwd, left);
          const rightRelative = nodePath.relative(input.cwd, right);
          const leftDepth = leftRelative.split(nodePath.sep).length;
          const rightDepth = rightRelative.split(nodePath.sep).length;
          return leftDepth - rightDepth || leftRelative.localeCompare(rightRelative);
        });
      },
      catch: (cause) =>
        new GitCommandError({
          operation: "GitVcsDriver.createWorktree",
          command: `find ${DEPENDENCY_INSTALL_DIR_NAME}`,
          cwd: input.cwd,
          detail: `Failed to find dependency install directories to copy into ${input.worktreePath}.`,
          cause,
        }),
    });

    yield* Effect.forEach(
      dependencyInstallDirs,
      (sourceDir) => {
        const relativeDir = nodePath.relative(input.cwd, sourceDir);
        const targetDir = nodePath.join(input.worktreePath, relativeDir);

        return Effect.tryPromise({
          try: async () => {
            try {
              await fsPromises.lstat(targetDir);
              return;
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
                throw cause;
              }
            }

            await fsPromises.mkdir(nodePath.dirname(targetDir), { recursive: true });
            await fsPromises.cp(sourceDir, targetDir, {
              dereference: false,
              errorOnExist: false,
              force: false,
              recursive: true,
              verbatimSymlinks: true,
            });
          },
          catch: (cause) =>
            new GitCommandError({
              operation: "GitVcsDriver.createWorktree",
              command: `copy ${DEPENDENCY_INSTALL_DIR_NAME}`,
              cwd: input.cwd,
              detail: `Failed to copy ${relativeDir} into ${input.worktreePath}.`,
              cause,
            }),
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning(
              `${error.message} The worktree was created without this dependency directory; run your package manager (e.g. bun install) inside the worktree to populate it.`,
              {
                cause:
                  error.cause instanceof Error
                    ? `${error.cause.name}: ${error.cause.message}`
                    : String(error.cause),
              },
            ).pipe(Effect.asVoid),
          ),
        );
      },
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  },
);

/**
 * How long a finished worktree base prefetch stands in for the fetch a worktree
 * creation would otherwise run. The composer prefetches when it enters worktree
 * mode; a send within this window starts from that fetch.
 */
export const WORKTREE_BASE_PREFETCH_REUSE_MS = 60_000;

/** A worktree base fetch, shared by every prefetch and creation that joined it. */
interface WorktreeBaseFetch {
  /** A prefetch started it: a creation that joined it retries its failure. */
  readonly prefetch: boolean;
  readonly outcome: Exit.Exit<string, GitCommandError>;
}

export const makeGitVcsDriverCore = Effect.fn("makeGitVcsDriverCore")(function* (options?: {
  executeOverride?: GitVcsDriver.GitVcsDriverShape["execute"];
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const worktreePolicy = yield* makeWorkspaceAccessPolicy(config.workspaceAccessRoot);
  const settingsService = yield* Effect.serviceOption(ServerSettingsService);
  const storageSql = yield* Effect.serviceOption(SqlClient.SqlClient);
  // Entries live only while callers hold/wait for this canonical destination.
  const worktreeDestinations = yield* RcMap.make({
    lookup: (_destination: string) => Semaphore.make(1),
  });

  let executeRaw: GitVcsDriver.GitVcsDriverShape["execute"];

  if (options?.executeOverride) {
    executeRaw = options.executeOverride;
  } else {
    const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    executeRaw = Effect.fnUntraced(function* (input) {
      const commandInput = {
        ...input,
        args: [...input.args],
      } as const;
      const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      const truncateOutputAtMaxBytes = input.truncateOutputAtMaxBytes ?? false;

      const runGitCommand = Effect.fn("runGitCommand")(function* () {
        const trace2Monitor = yield* createTrace2Monitor(commandInput, input.progress).pipe(
          Effect.provideService(Path.Path, path),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.mapError(toGitCommandError(commandInput, "failed to create trace2 monitor.")),
        );
        const child = yield* commandSpawner
          .spawn(
            ChildProcess.make("git", commandInput.args, {
              cwd: commandInput.cwd,
              env: {
                ...process.env,
                // Force English locale so stderr parsing (e.g. "not a git repository")
                // is deterministic across user systems. We only ever parse git's output
                // programmatically — we never display it to the user — so localization
                // is a liability, not a feature.
                LC_ALL: "C",
                LANG: "C",
                ...(input.readOnly ? GitVcsDriver.READ_ONLY_GIT_ENV : {}),
                ...input.env,
                ...trace2Monitor.env,
              },
            }),
          )
          .pipe(Effect.mapError(toGitCommandError(commandInput, "failed to spawn.")));

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            input.stdoutBytes === true
              ? collectOutputBytes(commandInput, child.stdout, maxOutputBytes).pipe(
                  Effect.map((bytes) => ({ text: "", truncated: false, bytes })),
                )
              : collectOutput(
                  commandInput,
                  child.stdout,
                  maxOutputBytes,
                  truncateOutputAtMaxBytes,
                  input.progress?.onStdoutLine,
                ).pipe(Effect.map((output) => ({ ...output, bytes: undefined }))),
            collectOutput(
              commandInput,
              child.stderr,
              maxOutputBytes,
              truncateOutputAtMaxBytes,
              input.progress?.onStderrLine,
              input.progress?.splitStderrAtCarriageReturn === true,
            ),
            child.exitCode.pipe(
              Effect.mapError(toGitCommandError(commandInput, "failed to report exit code.")),
            ),
            input.stdin === undefined
              ? Effect.void
              : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                  Effect.mapError(toGitCommandError(commandInput, "failed to write stdin.")),
                ),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));
        yield* trace2Monitor.flush;

        if (!input.allowNonZeroExit && exitCode !== 0) {
          const trimmedStderr = stderr.text.trim();
          return yield* new GitCommandError({
            operation: commandInput.operation,
            command: quoteGitCommand(commandInput.args),
            cwd: commandInput.cwd,
            detail:
              trimmedStderr.length > 0
                ? `${quoteGitCommand(commandInput.args)} failed: ${trimmedStderr}`
                : `${quoteGitCommand(commandInput.args)} failed with code ${exitCode}.`,
          });
        }

        return {
          exitCode,
          stdout: stdout.text,
          stderr: stderr.text,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          ...(stdout.bytes !== undefined ? { stdoutBytes: stdout.bytes } : {}),
        } satisfies GitVcsDriver.ExecuteGitResult;
      });

      // Governed by the process-wide git pool; queue time is not part of the timeout.
      return yield* governChildProcess(
        "git",
        runGitCommand().pipe(Effect.scoped, Effect.timeoutOption(timeoutMs)),
      ).pipe(
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () =>
              Effect.fail(
                new GitCommandError({
                  operation: commandInput.operation,
                  command: quoteGitCommand(commandInput.args),
                  cwd: commandInput.cwd,
                  detail: `${quoteGitCommand(commandInput.args)} timed out.`,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    });
  }

  // Filled in below once the caches exist: a command that may write (config,
  // refs) drops the cached config snapshots and branch listings, so reads
  // never answer from before a change this driver made.
  let invalidateReadCaches: Effect.Effect<void> = Effect.void;

  const execute: GitVcsDriver.GitVcsDriverShape["execute"] = (input) =>
    executeRaw(input).pipe(
      input.readOnly
        ? (effect) => effect
        : Effect.ensuring(Effect.suspend(() => invalidateReadCaches)),
      withMetrics({
        counter: gitCommandsTotal,
        timer: gitCommandDuration,
        attributes: {
          operation: input.operation,
        },
      }),
      Effect.withSpan(input.operation, {
        kind: "client",
        attributes: {
          "git.operation": input.operation,
          "git.cwd": input.cwd,
          "git.args_count": input.args.length,
        },
      }),
    );

  const executeGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<GitVcsDriver.ExecuteGitResult, GitCommandError> =>
    execute({
      operation,
      cwd,
      args,
      ...(options.stdin !== undefined ? { stdin: options.stdin } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      allowNonZeroExit: true,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
      ...(options.truncateOutputAtMaxBytes !== undefined
        ? { truncateOutputAtMaxBytes: options.truncateOutputAtMaxBytes }
        : {}),
      ...(options.progress ? { progress: options.progress } : {}),
      ...(options.readOnly ? { readOnly: true } : {}),
    }).pipe(
      Effect.flatMap((result) => {
        if (options.allowNonZeroExit || result.exitCode === 0) {
          return Effect.succeed(result);
        }
        const stderr = result.stderr.trim();
        if (stderr.length > 0) {
          return Effect.fail(createGitCommandError(operation, cwd, args, stderr));
        }
        if (options.fallbackErrorMessage) {
          return Effect.fail(
            createGitCommandError(operation, cwd, args, options.fallbackErrorMessage),
          );
        }
        return Effect.fail(
          createGitCommandError(
            operation,
            cwd,
            args,
            `${commandLabel(args)} failed: code=${result.exitCode ?? "null"}`,
          ),
        );
      }),
    );

  const configSnapshotCache = yield* Cache.makeWith(
    (cwd: string) =>
      executeGit("GitVcsDriver.readConfigSnapshot", cwd, ["config", "-z", "--list"], {
        allowNonZeroExit: true,
        readOnly: true,
        timeoutMs: 5_000,
      }).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(parseGitConfigList(result.stdout))
            : Effect.fail(
                createGitCommandError(
                  "GitVcsDriver.readConfigSnapshot",
                  cwd,
                  ["config", "-z", "--list"],
                  result.stderr.trim() || "git config --list failed",
                ),
              ),
        ),
      ),
    {
      capacity: CONFIG_SNAPSHOT_CACHE_CAPACITY,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? CONFIG_SNAPSHOT_CACHE_TTL : Duration.zero),
    },
  );
  invalidateReadCaches = Cache.invalidateAll(configSnapshotCache);

  const readConfigSnapshot: GitVcsDriver.GitVcsDriverShape["readConfigSnapshot"] = (cwd) =>
    Cache.get(configSnapshotCache, path.resolve(cwd));

  const runGit = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<void, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(Effect.asVoid);

  const runGitStdout = (
    operation: string,
    cwd: string,
    args: readonly string[],
    allowNonZeroExit = false,
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, { allowNonZeroExit }).pipe(
      Effect.map((result) => result.stdout),
    );

  const runGitStdoutWithOptions = (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: ExecuteGitOptions = {},
  ): Effect.Effect<string, GitCommandError> =>
    executeGit(operation, cwd, args, options).pipe(
      Effect.map((result) =>
        result.stdoutTruncated ? `${result.stdout}${OUTPUT_TRUNCATED_MARKER}` : result.stdout,
      ),
    );

  const branchExists = (cwd: string, refName: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.branchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${refName}`],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const resolveAvailableBranchName = Effect.fn("resolveAvailableBranchName")(function* (
    cwd: string,
    desiredBranch: string,
  ) {
    const isDesiredTaken = yield* branchExists(cwd, desiredBranch);
    if (!isDesiredTaken) {
      return desiredBranch;
    }

    for (let suffix = 1; suffix <= 100; suffix += 1) {
      const candidate = `${desiredBranch}-${suffix}`;
      const isCandidateTaken = yield* branchExists(cwd, candidate);
      if (!isCandidateTaken) {
        return candidate;
      }
    }

    return yield* createGitCommandError(
      "GitVcsDriver.renameBranch",
      cwd,
      ["branch", "-m", "--", desiredBranch],
      `Could not find an available branch name for '${desiredBranch}'.`,
    );
  });

  const resolveCurrentUpstream = Effect.fn("resolveCurrentUpstream")(function* (cwd: string) {
    const upstreamRef = yield* executeGit(
      "GitVcsDriver.resolveCurrentUpstream",
      cwd,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { allowNonZeroExit: true, readOnly: true },
    ).pipe(Effect.map((result) => result.stdout.trim()));

    if (upstreamRef.length === 0 || upstreamRef === "@{upstream}") {
      return null;
    }

    const remoteNames = yield* executeGit("GitVcsDriver.listRemoteNames", cwd, ["remote"], {
      readOnly: true,
    }).pipe(
      Effect.map((result) => parseRemoteNames(result.stdout)),
      Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])),
    );
    return (
      parseUpstreamRefWithRemoteNames(upstreamRef, remoteNames) ??
      parseUpstreamRefByFirstSeparator(upstreamRef)
    );
  });

  // Status fetches are network round trips that may wake an SSH agent; a
  // couple at a time is plenty (they are already shared per repository and remote).
  const statusFetchPermits = yield* Semaphore.make(STATUS_UPSTREAM_REFRESH_CONCURRENCY);
  /** True when the fetch succeeded; offline, auth and other git failures are false. */
  const fetchRemoteForStatus = (
    gitCommonDir: string,
    remoteName: string,
  ): Effect.Effect<boolean, GitCommandError> => {
    const fetchCwd =
      path.basename(gitCommonDir) === ".git" ? path.dirname(gitCommonDir) : gitCommonDir;
    return statusFetchPermits
      .withPermits(1)(
        executeGit(
          "GitVcsDriver.fetchRemoteForStatus",
          fetchCwd,
          ["--git-dir", gitCommonDir, "fetch", "--quiet", "--no-tags", remoteName],
          {
            allowNonZeroExit: true,
            env: STATUS_UPSTREAM_REFRESH_ENV,
            timeoutMs: Duration.toMillis(STATUS_UPSTREAM_REFRESH_TIMEOUT),
          },
        ),
      )
      .pipe(Effect.map((result) => result.exitCode === 0));
  };

  const resolveGitCommonDir = Effect.fn("resolveGitCommonDir")(function* (cwd: string) {
    const gitCommonDir = yield* executeGit(
      "GitVcsDriver.resolveGitCommonDir",
      cwd,
      ["rev-parse", "--git-common-dir"],
      { readOnly: true },
    ).pipe(Effect.map((result) => result.stdout.trim()));
    return path.isAbsolute(gitCommonDir) ? gitCommonDir : path.resolve(cwd, gitCommonDir);
  });

  // Successful fetches per (common dir, remote), so a caller can tell whether
  // remote-tracking refs may have moved while it waited.
  const statusRemoteFetchGenerations = new Map<string, number>();
  const statusRemoteFetchGenerationKey = (cacheKey: StatusRemoteRefreshCacheKey) =>
    `${cacheKey.gitCommonDir}\0${cacheKey.remoteName}`;

  // A fetch that git rejected (offline, signed out) moved no refs, so it bumps
  // nothing; it still holds the entry for the full interval, so an unreachable
  // remote is not retried more often than a reachable one is refreshed.
  const refreshStatusRemoteCacheEntry = Effect.fn("refreshStatusRemoteCacheEntry")(function* (
    cacheKey: StatusRemoteRefreshCacheKey,
  ) {
    const fetched = yield* fetchRemoteForStatus(cacheKey.gitCommonDir, cacheKey.remoteName);
    if (fetched) {
      const key = statusRemoteFetchGenerationKey(cacheKey);
      statusRemoteFetchGenerations.set(key, (statusRemoteFetchGenerations.get(key) ?? 0) + 1);
    }
    return fetched;
  });

  const statusRemoteRefreshCache = yield* Cache.makeWith(refreshStatusRemoteCacheEntry, {
    capacity: STATUS_UPSTREAM_REFRESH_CACHE_CAPACITY,
    // Keep successful refreshes warm and briefly back off failed refreshes to avoid retry storms.
    timeToLive: (exit) =>
      Exit.isSuccess(exit)
        ? STATUS_UPSTREAM_REFRESH_INTERVAL
        : STATUS_UPSTREAM_REFRESH_FAILURE_COOLDOWN,
  });

  /** Fetches the upstream's remote at most once per interval; true when a fetch completed meanwhile. */
  const refreshStatusUpstreamIfStale = Effect.fn("refreshStatusUpstreamIfStale")(function* (
    cwd: string,
  ) {
    const upstream = yield* resolveCurrentUpstream(cwd);
    if (!upstream) return false;
    const gitCommonDir = yield* resolveGitCommonDir(cwd);
    const cacheKey = new StatusRemoteRefreshCacheKey({
      gitCommonDir,
      remoteName: upstream.remoteName,
    });
    const generationKey = statusRemoteFetchGenerationKey(cacheKey);
    const before = statusRemoteFetchGenerations.get(generationKey) ?? 0;
    yield* Cache.get(statusRemoteRefreshCache, cacheKey);
    return (statusRemoteFetchGenerations.get(generationKey) ?? 0) !== before;
  });

  const refreshStatusUpstream: GitVcsDriver.GitVcsDriverShape["refreshStatusUpstream"] = (cwd) =>
    refreshStatusUpstreamIfStale(cwd).pipe(
      Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(false)),
      Effect.catchCause(() => Effect.succeed(false)),
    );

  const resolveDefaultBranchName = (
    cwd: string,
    remoteName: string,
  ): Effect.Effect<string | null, GitCommandError> =>
    executeGit(
      "GitVcsDriver.resolveDefaultBranchName",
      cwd,
      ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`],
      { allowNonZeroExit: true, readOnly: true },
    ).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return null;
        }
        return parseDefaultBranchFromRemoteHeadRef(result.stdout, remoteName);
      }),
    );

  const remoteBranchExists = (
    cwd: string,
    remoteName: string,
    refName: string,
  ): Effect.Effect<boolean, GitCommandError> =>
    executeGit(
      "GitVcsDriver.remoteBranchExists",
      cwd,
      ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteName}/${refName}`],
      {
        allowNonZeroExit: true,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0));

  const originRemoteExists = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    executeGit("GitVcsDriver.originRemoteExists", cwd, ["remote", "get-url", "origin"], {
      allowNonZeroExit: true,
    }).pipe(Effect.map((result) => result.exitCode === 0));

  const listRemoteNames = (cwd: string): Effect.Effect<ReadonlyArray<string>, GitCommandError> =>
    runGitStdout("GitVcsDriver.listRemoteNames", cwd, ["remote"]).pipe(
      Effect.map(parseRemoteNamesInGitOrder),
    );

  const resolvePublishBranchName = Effect.fn("resolvePublishBranchName")(function* (
    cwd: string,
    branchName: string,
  ) {
    const remoteNames = yield* listRemoteNames(cwd).pipe(Effect.catch(() => Effect.succeed([])));
    const parsedRemoteRef = parseRemoteRefWithRemoteNames(branchName, remoteNames);
    return parsedRemoteRef?.branchName ?? branchName;
  });

  const resolvePrimaryRemoteName = Effect.fn("resolvePrimaryRemoteName")(function* (cwd: string) {
    if (yield* originRemoteExists(cwd)) {
      return "origin";
    }
    const remotes = yield* listRemoteNames(cwd);
    const [firstRemote] = remotes;
    if (firstRemote) {
      return firstRemote;
    }
    return yield* createGitCommandError(
      "GitVcsDriver.resolvePrimaryRemoteName",
      cwd,
      ["remote"],
      "No git remote is configured for this repository.",
    );
  });

  const resolvePushRemoteName = Effect.fn("resolvePushRemoteName")(function* (
    cwd: string,
    refName: string,
  ) {
    const branchPushRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.branchPushRemote",
      cwd,
      ["config", "--get", `branch.${refName}.pushRemote`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (branchPushRemote.length > 0) {
      return branchPushRemote;
    }

    const pushDefaultRemote = yield* runGitStdout(
      "GitVcsDriver.resolvePushRemoteName.remotePushDefault",
      cwd,
      ["config", "--get", "remote.pushDefault"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (pushDefaultRemote.length > 0) {
      return pushDefaultRemote;
    }

    return yield* resolvePrimaryRemoteName(cwd).pipe(Effect.catch(() => Effect.succeed(null)));
  });

  const ensureRemote: GitVcsDriver.GitVcsDriverShape["ensureRemote"] = Effect.fn("ensureRemote")(
    function* (input) {
      const preferredName = sanitizeRemoteName(input.preferredName);
      const normalizedTargetUrl = normalizeRemoteUrl(input.url);
      const remoteFetchUrls = yield* runGitStdout(
        "GitVcsDriver.ensureRemote.listRemoteUrls",
        input.cwd,
        ["remote", "-v"],
      ).pipe(Effect.map((stdout) => parseRemoteFetchUrls(stdout)));

      for (const [remoteName, remoteUrl] of remoteFetchUrls.entries()) {
        if (normalizeRemoteUrl(remoteUrl) === normalizedTargetUrl) {
          return remoteName;
        }
      }

      let remoteName = preferredName;
      let suffix = 1;
      while (remoteFetchUrls.has(remoteName)) {
        remoteName = `${preferredName}-${suffix}`;
        suffix += 1;
      }

      yield* runGit("GitVcsDriver.ensureRemote.add", input.cwd, [
        "remote",
        "add",
        remoteName,
        input.url,
      ]);
      return remoteName;
    },
  );

  /** Reads, one key at a time, what base-branch resolution needs (mutation paths). */
  const readBaseBranchResolutionContext = Effect.fn("readBaseBranchResolutionContext")(function* (
    cwd: string,
    refName: string,
  ) {
    const configuredBaseBranch = yield* runGitStdout(
      "GitVcsDriver.resolveBaseBranchForNoUpstream.config",
      cwd,
      ["config", "--get", `branch.${refName}.gh-merge-base`],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const primaryRemoteName = yield* resolvePrimaryRemoteName(cwd).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const defaultBranch =
      primaryRemoteName === null ? null : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
    return {
      configuredBaseBranch: configuredBaseBranch.length > 0 ? configuredBaseBranch : null,
      primaryRemoteName,
      defaultBranch,
    } satisfies BaseBranchResolutionContext;
  });

  const resolveBaseBranchForNoUpstream = Effect.fn("resolveBaseBranchForNoUpstream")(function* (
    cwd: string,
    refName: string,
    precomputedContext?: BaseBranchResolutionContext,
  ) {
    const context = precomputedContext ?? (yield* readBaseBranchResolutionContext(cwd, refName));
    const candidates = baseBranchCandidates(refName, context);
    if (candidates.length === 0) {
      return null;
    }

    // One for-each-ref answers every candidate instead of a show-ref per candidate and remote.
    const patterns = candidates.flatMap((candidate) =>
      candidate.remoteRef === null
        ? [candidate.localRef]
        : [candidate.localRef, candidate.remoteRef],
    );
    const existingRefs = yield* executeGit(
      "GitVcsDriver.resolveBaseBranchForNoUpstream.refs",
      cwd,
      ["for-each-ref", "--format=%(refname)", ...patterns],
      { allowNonZeroExit: true, readOnly: true, timeoutMs: 5_000 },
    ).pipe(
      Effect.map((result) =>
        result.exitCode === 0 ? new Set(result.stdout.split(/\r?\n/g)) : null,
      ),
    );
    if (existingRefs === null) {
      return null;
    }

    for (const candidate of candidates) {
      if (existingRefs.has(candidate.localRef)) {
        return candidate.name;
      }
      if (candidate.remoteRef !== null && existingRefs.has(candidate.remoteRef)) {
        return `${context.primaryRemoteName}/${candidate.name}`;
      }
    }

    return null;
  });

  const commitPairCacheOptions = {
    capacity: 256,
    timeToLive: (exit: Exit.Exit<unknown, unknown>) =>
      Exit.isSuccess(exit) ? Duration.minutes(5) : Duration.zero,
  };

  // Keyed by both commit ids, so any ref movement misses and recomputes.
  const aheadCountCache = yield* Cache.makeWith(
    Effect.fn("readAheadCount")(function* (key: CommittedDiffCacheKey) {
      const result = yield* executeGit(
        "GitVcsDriver.computeAheadCountAgainstBase",
        key.cwd,
        ["rev-list", "--count", `${key.baseCommit}..${key.headCommit}`],
        { allowNonZeroExit: true, readOnly: true },
      );
      if (result.exitCode !== 0) {
        return 0;
      }
      const parsed = Number.parseInt(result.stdout.trim(), 10);
      return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    }),
    commitPairCacheOptions,
  );

  const committedDiffCache = yield* Cache.makeWith(
    Effect.fn("readCommittedDiff")(function* (key: CommittedDiffCacheKey) {
      const result = yield* executeGit(
        "GitVcsDriver.readCommittedAgainstBase.diff",
        key.cwd,
        ["diff", "--numstat", `${key.baseCommit}...${key.headCommit}`],
        { readOnly: true },
      );
      let insertions = 0;
      let deletions = 0;
      const files = parseNumstatEntries(result.stdout)
        .map((entry) => {
          insertions += entry.insertions;
          deletions += entry.deletions;
          return { path: entry.path, insertions: entry.insertions, deletions: entry.deletions };
        })
        .toSorted((a, b) => a.path.localeCompare(b.path));
      return { files, insertions, deletions };
    }),
    commitPairCacheOptions,
  );

  // Pin both ends once; the ahead count and the expensive three-dot diff are
  // then cached by commit pair. Ref changes miss immediately, while
  // working-tree status remains uncached.
  const resolveBaseCommitPair = Effect.fn("resolveBaseCommitPair")(function* (
    cwd: string,
    baseRef: string,
  ) {
    const commits = yield* executeGit(
      "GitVcsDriver.readCommittedAgainstBase.resolve",
      cwd,
      ["rev-parse", "--revs-only", "--end-of-options", `${baseRef}^{commit}`, "HEAD^{commit}"],
      { readOnly: true },
    ).pipe(Effect.map((result) => result.stdout.trim().split(/\r?\n/)));
    const [baseCommit, headCommit] = commits;
    if (
      commits.length !== 2 ||
      !baseCommit ||
      !headCommit ||
      !/^[a-f0-9]{40,64}$/.test(baseCommit) ||
      !/^[a-f0-9]{40,64}$/.test(headCommit)
    ) {
      return null;
    }
    return new CommittedDiffCacheKey({ cwd: path.resolve(cwd), baseCommit, headCommit });
  });

  /**
   * The base a status compares a branch against, and the branch's commits
   * ahead of it (cached by commit pair). Any git failure degrades to no base.
   */
  const readStatusBase = Effect.fn("readStatusBase")(function* (
    cwd: string,
    refName: string,
    configSnapshot: GitVcsDriver.GitConfigSnapshot | null,
    originDefaultBranch: string | null,
  ) {
    const baseCommitPair = yield* Effect.gen(function* () {
      const baseContext =
        configSnapshot === null
          ? undefined
          : yield* statusBaseBranchContext(cwd, refName, configSnapshot, originDefaultBranch);
      const baseRef = yield* resolveBaseBranchForNoUpstream(cwd, refName, baseContext);
      return baseRef === null ? null : yield* resolveBaseCommitPair(cwd, baseRef);
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    const aheadOfBase =
      baseCommitPair === null
        ? 0
        : yield* Cache.get(aheadCountCache, baseCommitPair).pipe(
            Effect.catch(() => Effect.succeed(0)),
          );
    return { baseCommitPair, aheadOfBase };
  });

  const readStatusDetailsLocal = Effect.fn("readStatusDetailsLocal")(function* (cwd: string) {
    const statusResult = yield* executeGit(
      "GitVcsDriver.statusDetails.status",
      cwd,
      ["status", "--porcelain=2", "--branch"],
      {
        allowNonZeroExit: true,
        readOnly: true,
      },
    ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(null)));

    if (statusResult === null) {
      return NON_REPOSITORY_STATUS_DETAILS;
    }

    if (statusResult.exitCode !== 0) {
      const stderr = statusResult.stderr.trim();
      if (stderr.toLowerCase().includes("not a git repository")) {
        return NON_REPOSITORY_STATUS_DETAILS;
      }
      return yield* createGitCommandError(
        "GitVcsDriver.statusDetails.status",
        cwd,
        ["status", "--porcelain=2", "--branch"],
        stderr || "git status failed",
      );
    }

    // The config snapshot (cached briefly per cwd) answers the remote and
    // merge-base lookups that used to be one `git config` / `git remote` each.
    const [trackedNumstatResult, defaultRefResult, configSnapshot] = yield* Effect.all(
      [
        executeGit(
          "GitVcsDriver.statusDetails.trackedNumstat",
          cwd,
          [...GitVcsDriver.NO_INDEX_REFRESH_DIFF_ARGS, "diff", "HEAD", "--numstat"],
          { allowNonZeroExit: true, readOnly: true },
        ),
        executeGit(
          "GitVcsDriver.statusDetails.defaultRef",
          cwd,
          ["symbolic-ref", "refs/remotes/origin/HEAD"],
          {
            allowNonZeroExit: true,
            readOnly: true,
          },
        ),
        readConfigSnapshot(cwd).pipe(Effect.catch(() => Effect.succeed(null))),
      ],
      { concurrency: "unbounded" },
    );
    const trackedNumstatStdout =
      trackedNumstatResult.exitCode === 0
        ? trackedNumstatResult.stdout
        : yield* Effect.all(
            [
              executeGit(
                "GitVcsDriver.statusDetails.unstagedNumstat",
                cwd,
                [...GitVcsDriver.NO_INDEX_REFRESH_DIFF_ARGS, "diff", "--numstat"],
                { readOnly: true },
              ),
              executeGit(
                "GitVcsDriver.statusDetails.stagedNumstat",
                cwd,
                ["diff", "--cached", "--numstat"],
                { readOnly: true },
              ),
            ],
            { concurrency: "unbounded" },
          ).pipe(Effect.map((outputs) => outputs.map((output) => output.stdout).join("\n")));
    const hasPrimaryRemote =
      configSnapshot !== null
        ? configSnapshot.remoteNames.includes("origin")
        : yield* originRemoteExists(cwd).pipe(Effect.catch(() => Effect.succeed(false)));
    const statusStdout = statusResult.stdout;
    const defaultBranch =
      defaultRefResult.exitCode === 0
        ? defaultRefResult.stdout.trim().replace(/^refs\/remotes\/origin\//, "")
        : null;

    let refName: string | null = null;
    let upstreamRef: string | null = null;
    let aheadCount = 0;
    let behindCount = 0;
    let aheadOfDefaultCount = 0;
    let hasWorkingTreeChanges = false;
    const changedFilesWithoutNumstat = new Set<string>();

    for (const line of statusStdout.split(/\r?\n/g)) {
      if (line.startsWith("# branch.head ")) {
        const value = line.slice("# branch.head ".length).trim();
        refName = value.startsWith("(") ? null : value;
        continue;
      }
      if (line.startsWith("# branch.upstream ")) {
        const value = line.slice("# branch.upstream ".length).trim();
        upstreamRef = value.length > 0 ? value : null;
        continue;
      }
      if (line.startsWith("# branch.ab ")) {
        const value = line.slice("# branch.ab ".length).trim();
        const parsed = parseBranchAb(value);
        aheadCount = parsed.ahead;
        behindCount = parsed.behind;
        continue;
      }
      if (line.trim().length > 0 && !line.startsWith("#")) {
        hasWorkingTreeChanges = true;
        const pathValue = parsePorcelainPath(line);
        if (pathValue) changedFilesWithoutNumstat.add(pathValue);
      }
    }

    const isDefaultBranch =
      refName !== null &&
      (refName === defaultBranch ||
        (defaultBranch === null && (refName === "main" || refName === "master")));

    // The base branch is resolved once per status and shared by the
    // no-upstream ahead count, the ahead-of-default count and the committed
    // diff; the latter two are cached by (base, HEAD) commit pair.
    const { baseCommitPair, aheadOfBase } =
      refName !== null && statusNeedsBase(upstreamRef, isDefaultBranch)
        ? yield* readStatusBase(cwd, refName, configSnapshot, defaultBranch)
        : { baseCommitPair: null, aheadOfBase: 0 };

    if (refName !== null && upstreamRef === null) {
      aheadCount = aheadOfBase;
      behindCount = 0;
    }
    if (refName !== null && !isDefaultBranch) {
      aheadOfDefaultCount = aheadOfBase;
    }

    // Without the index refresh an older Git lists stat-only changes as `0 0`
    // rows; status (which compares content) is the authority on what changed.
    const trackedEntries = parseNumstatEntries(trackedNumstatStdout).filter(
      (entry) =>
        entry.insertions !== 0 ||
        entry.deletions !== 0 ||
        changedFilesWithoutNumstat.has(entry.path),
    );
    const fileStatMap = new Map<string, { insertions: number; deletions: number }>();
    for (const entry of trackedEntries) {
      const existing = fileStatMap.get(entry.path) ?? { insertions: 0, deletions: 0 };
      existing.insertions += entry.insertions;
      existing.deletions += entry.deletions;
      fileStatMap.set(entry.path, existing);
    }

    let insertions = 0;
    let deletions = 0;
    const files = Array.from(fileStatMap.entries())
      .map(([filePath, stat]) => {
        insertions += stat.insertions;
        deletions += stat.deletions;
        return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
      })
      .toSorted((a, b) => a.path.localeCompare(b.path));

    for (const filePath of changedFilesWithoutNumstat) {
      if (fileStatMap.has(filePath)) continue;
      files.push({ path: filePath, insertions: 0, deletions: 0 });
    }
    files.sort((a, b) => a.path.localeCompare(b.path));

    // On the default branch there is no base to diff against, so committed work
    // vs base is undefined (all changes there are working-tree only). Any git
    // failure degrades to empty rather than failing the whole status read.
    const committed =
      refName && !isDefaultBranch
        ? baseCommitPair === null
          ? emptyDiffTotals()
          : yield* Cache.get(committedDiffCache, baseCommitPair).pipe(
              Effect.catch(() => Effect.succeed(emptyDiffTotals())),
            )
        : undefined;

    return {
      isRepo: true,
      hasOriginRemote: hasPrimaryRemote,
      isDefaultBranch,
      branch: refName,
      upstreamRef,
      hasWorkingTreeChanges,
      workingTree: {
        files,
        insertions,
        deletions,
      },
      ...(committed ? { committed } : {}),
      hasUpstream: upstreamRef !== null,
      aheadCount,
      behindCount,
      aheadOfDefaultCount,
    };
  });

  /** Base-branch inputs for a status read, from its config snapshot and `origin/HEAD`. */
  const statusBaseBranchContext = Effect.fn("statusBaseBranchContext")(function* (
    cwd: string,
    refName: string,
    configSnapshot: GitVcsDriver.GitConfigSnapshot,
    originDefaultBranch: string | null,
  ) {
    const primaryRemoteName = primaryRemoteFromNames(configSnapshot.remoteNames);
    const defaultBranch =
      primaryRemoteName === null
        ? null
        : primaryRemoteName === "origin"
          ? originDefaultBranch
          : yield* resolveDefaultBranchName(cwd, primaryRemoteName);
    return {
      configuredBaseBranch: configSnapshot.get(`branch.${refName}.gh-merge-base`),
      primaryRemoteName,
      defaultBranch,
    } satisfies BaseBranchResolutionContext;
  });

  const statusDetailsLocal: GitVcsDriver.GitVcsDriverShape["statusDetailsLocal"] = Effect.fn(
    "statusDetailsLocal",
  )(function* (cwd) {
    return yield* readStatusDetailsLocal(cwd);
  });

  const refreshStatusTracking: GitVcsDriver.GitVcsDriverShape["refreshStatusTracking"] = Effect.fn(
    "refreshStatusTracking",
  )(function* (cwd, details) {
    if (!details.isRepo || details.branch === null) return null;
    const refName = details.branch;
    // Spawn-free; also null for a folder below the checkout root, which then reads in full.
    const head = yield* readCheckoutHead(cwd);
    if (head === null || head.branch !== refName) return null;

    const [upstreamCounts, configSnapshot] = yield* Effect.all(
      [
        details.upstreamRef === null
          ? Effect.succeed(null)
          : executeGit(
              "GitVcsDriver.refreshStatusTracking.upstreamCounts",
              cwd,
              ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
              { allowNonZeroExit: true, readOnly: true },
            ).pipe(
              Effect.map((result) =>
                result.exitCode === 0 ? parseLeftRightCounts(result.stdout) : null,
              ),
            ),
        statusNeedsBase(details.upstreamRef, details.isDefaultBranch)
          ? readConfigSnapshot(cwd).pipe(Effect.catch(() => Effect.succeed(null)))
          : Effect.succeed(null),
      ],
      { concurrency: "unbounded" },
    );
    // The upstream went away or cannot be read: only a full status can tell.
    if (details.upstreamRef !== null && upstreamCounts === null) return null;

    const { aheadOfBase } = statusNeedsBase(details.upstreamRef, details.isDefaultBranch)
      ? yield* readStatusBase(cwd, refName, configSnapshot, head.originDefaultBranch)
      : { aheadOfBase: 0 };
    return {
      ...details,
      aheadCount: upstreamCounts === null ? aheadOfBase : upstreamCounts.right,
      behindCount: upstreamCounts === null ? 0 : upstreamCounts.left,
      aheadOfDefaultCount: details.isDefaultBranch ? details.aheadOfDefaultCount : aheadOfBase,
    };
  });

  const statusDetails: GitVcsDriver.GitVcsDriverShape["statusDetails"] = Effect.fn("statusDetails")(
    function* (cwd) {
      yield* refreshStatusUpstream(cwd);
      return yield* readStatusDetailsLocal(cwd);
    },
  );

  const status: GitVcsDriver.GitVcsDriverShape["status"] = (input) =>
    statusDetails(input.cwd).pipe(
      Effect.map((details) => ({
        isRepo: details.isRepo,
        hasPrimaryRemote: details.hasOriginRemote,
        isDefaultRef: details.isDefaultBranch,
        refName: details.branch,
        hasWorkingTreeChanges: details.hasWorkingTreeChanges,
        workingTree: details.workingTree,
        ...(details.committed ? { committed: details.committed } : {}),
        hasUpstream: details.hasUpstream,
        aheadCount: details.aheadCount,
        behindCount: details.behindCount,
        aheadOfDefaultCount: details.aheadOfDefaultCount,
        pr: null,
      })),
    );

  const prepareCommitContext: GitVcsDriver.GitVcsDriverShape["prepareCommitContext"] = Effect.fn(
    "prepareCommitContext",
  )(function* (cwd, filePaths) {
    if (filePaths && filePaths.length > 0) {
      yield* runGit("GitVcsDriver.prepareCommitContext.reset", cwd, ["reset"]).pipe(
        Effect.catch(() => Effect.void),
      );
      yield* runGit("GitVcsDriver.prepareCommitContext.addSelected", cwd, [
        "add",
        "-A",
        "--",
        ...filePaths,
      ]);
    } else {
      yield* runGit("GitVcsDriver.prepareCommitContext.addAll", cwd, ["add", "-A"]);
    }

    const stagedSummary = yield* runGitStdout(
      "GitVcsDriver.prepareCommitContext.stagedSummary",
      cwd,
      ["diff", "--cached", "--name-status"],
    ).pipe(Effect.map((stdout) => stdout.trim()));
    if (stagedSummary.length === 0) {
      return null;
    }

    const stagedPatch = yield* runGitStdoutWithOptions(
      "GitVcsDriver.prepareCommitContext.stagedPatch",
      cwd,
      ["diff", "--cached", "--patch", "--minimal"],
      {
        maxOutputBytes: PREPARED_COMMIT_PATCH_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
      },
    );

    return {
      stagedSummary,
      stagedPatch,
    };
  });

  const commit: GitVcsDriver.GitVcsDriverShape["commit"] = Effect.fn("commit")(function* (
    cwd,
    subject,
    body,
    options?: GitVcsDriver.GitCommitOptions,
  ) {
    const args = ["commit", "-m", subject];
    const trimmedBody = body.trim();
    if (trimmedBody.length > 0) {
      args.push("-m", trimmedBody);
    }
    const progress =
      options?.progress?.onOutputLine === undefined
        ? options?.progress
        : {
            ...options.progress,
            onStdoutLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stdout", text: line }) ?? Effect.void,
            onStderrLine: (line: string) =>
              options.progress?.onOutputLine?.({ stream: "stderr", text: line }) ?? Effect.void,
          };
    yield* executeGit("GitVcsDriver.commit.commit", cwd, args, {
      ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(progress ? { progress } : {}),
    }).pipe(Effect.asVoid);
    const commitSha = yield* runGitStdout("GitVcsDriver.commit.revParseHead", cwd, [
      "rev-parse",
      "HEAD",
    ]).pipe(Effect.map((stdout) => stdout.trim()));

    return { commitSha };
  });

  const pushCurrentBranch: GitVcsDriver.GitVcsDriverShape["pushCurrentBranch"] = Effect.fn(
    "pushCurrentBranch",
  )(function* (cwd, fallbackBranch, options) {
    const details = yield* statusDetails(cwd);
    const branch = details.branch ?? fallbackBranch;
    if (!branch) {
      return yield* createGitCommandError(
        "GitVcsDriver.pushCurrentBranch",
        cwd,
        ["push"],
        "Cannot push from detached HEAD.",
      );
    }

    const requestedRemoteName = options?.remoteName?.trim() || null;
    if (requestedRemoteName) {
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushWithRequestedRemote", cwd, [
        "push",
        "-u",
        requestedRemoteName,
        `HEAD:refs/heads/${publishBranch}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${requestedRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const hasNoLocalDelta = details.aheadCount === 0 && details.behindCount === 0;
    if (hasNoLocalDelta) {
      if (details.hasUpstream) {
        return {
          status: "skipped_up_to_date" as const,
          branch,
          ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
        };
      }

      const comparableBaseBranch = yield* resolveBaseBranchForNoUpstream(cwd, branch).pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (comparableBaseBranch) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (!publishRemoteName) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }

        const hasRemoteBranch = yield* remoteBranchExists(cwd, publishRemoteName, branch).pipe(
          Effect.catch(() => Effect.succeed(false)),
        );
        if (hasRemoteBranch) {
          return {
            status: "skipped_up_to_date" as const,
            branch,
          };
        }
      }
    }

    if (!details.hasUpstream) {
      const publishRemoteName = yield* resolvePushRemoteName(cwd, branch);
      if (!publishRemoteName) {
        return yield* createGitCommandError(
          "GitVcsDriver.pushCurrentBranch",
          cwd,
          ["push"],
          "Cannot push because no git remote is configured for this repository.",
        );
      }
      const publishBranch = yield* resolvePublishBranchName(cwd, branch);
      yield* runGit("GitVcsDriver.pushCurrentBranch.pushWithUpstream", cwd, [
        "push",
        "-u",
        publishRemoteName,
        `HEAD:refs/heads/${publishBranch}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: `${publishRemoteName}/${publishBranch}`,
        setUpstream: true,
      };
    }

    const currentUpstream = yield* resolveCurrentUpstream(cwd).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    if (currentUpstream) {
      // A branch tracking a differently named ref was cut from it, the way
      // `git checkout -b feature origin/dev` and our own worktree flow leave
      // it. That upstream is the branch's base, not its publish target, and
      // pushing HEAD onto it would write feature commits to a shared branch.
      // The one same-repo tracking setup that legitimately differs is a
      // git-mangled alias such as local `upstream/effect-atom` for remote
      // `my-org/upstream`'s `effect-atom`: the local branch name ends in the
      // upstream head while the upstream ref ends in the local branch name.
      const isAliasOfUpstreamHead =
        branch === currentUpstream.branchName ||
        (branch.endsWith(`/${currentUpstream.branchName}`) &&
          currentUpstream.upstreamRef.endsWith(`/${branch}`));
      if (!isAliasOfUpstreamHead) {
        const publishRemoteName = yield* resolvePushRemoteName(cwd, branch).pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        const remoteName = publishRemoteName ?? currentUpstream.remoteName;
        const publishBranch = yield* resolvePublishBranchName(cwd, branch);

        // `-u` retargets the upstream to the published branch. Record the old
        // upstream first so base resolution keeps using it for the later PR.
        const configuredMergeBase = yield* runGitStdout(
          "GitVcsDriver.pushCurrentBranch.readMergeBase",
          cwd,
          ["config", "--get", `branch.${branch}.gh-merge-base`],
          true,
        ).pipe(Effect.map((stdout) => stdout.trim()));
        if (configuredMergeBase.length === 0) {
          yield* runGit("GitVcsDriver.pushCurrentBranch.recordMergeBase", cwd, [
            "config",
            `branch.${branch}.gh-merge-base`,
            currentUpstream.branchName,
          ]);
        }

        yield* runGit("GitVcsDriver.pushCurrentBranch.pushOwnBranch", cwd, [
          "push",
          "-u",
          remoteName,
          `HEAD:refs/heads/${publishBranch}`,
        ]);
        return {
          status: "pushed" as const,
          branch,
          upstreamBranch: `${remoteName}/${publishBranch}`,
          setUpstream: true,
        };
      }

      yield* runGit("GitVcsDriver.pushCurrentBranch.pushUpstream", cwd, [
        "push",
        currentUpstream.remoteName,
        `HEAD:refs/heads/${currentUpstream.branchName}`,
      ]);
      return {
        status: "pushed" as const,
        branch,
        upstreamBranch: currentUpstream.upstreamRef,
        setUpstream: false,
      };
    }

    yield* runGit("GitVcsDriver.pushCurrentBranch.push", cwd, ["push"]);
    return {
      status: "pushed" as const,
      branch,
      ...(details.upstreamRef ? { upstreamBranch: details.upstreamRef } : {}),
      setUpstream: false,
    };
  });

  const pullCurrentBranch: GitVcsDriver.GitVcsDriverShape["pullCurrentBranch"] = Effect.fn(
    "pullCurrentBranch",
  )(function* (cwd) {
    const details = yield* statusDetails(cwd);
    const refName = details.branch;
    if (!refName) {
      return yield* createGitCommandError(
        "GitVcsDriver.pullCurrentBranch",
        cwd,
        ["pull", "--ff-only"],
        "Cannot pull from detached HEAD.",
      );
    }
    if (!details.hasUpstream) {
      return yield* createGitCommandError(
        "GitVcsDriver.pullCurrentBranch",
        cwd,
        ["pull", "--ff-only"],
        "Current branch has no upstream configured. Push with upstream first.",
      );
    }
    const beforeSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.beforeSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));
    yield* executeGit("GitVcsDriver.pullCurrentBranch.pull", cwd, ["pull", "--ff-only"], {
      timeoutMs: 30_000,
      fallbackErrorMessage: "git pull failed",
    });
    const afterSha = yield* runGitStdout(
      "GitVcsDriver.pullCurrentBranch.afterSha",
      cwd,
      ["rev-parse", "HEAD"],
      true,
    ).pipe(Effect.map((stdout) => stdout.trim()));

    const refreshed = yield* statusDetails(cwd);
    return {
      status: beforeSha.length > 0 && beforeSha === afterSha ? "skipped_up_to_date" : "pulled",
      refName,
      upstreamRef: refreshed.upstreamRef,
    };
  });

  const readRangeContext: GitVcsDriver.GitVcsDriverShape["readRangeContext"] = Effect.fn(
    "readRangeContext",
  )(function* (cwd, baseRef, options) {
    const remoteName = options?.remoteName;
    if (
      remoteName &&
      remoteName !== "." &&
      !baseRef.startsWith("refs/") &&
      (yield* remoteBranchExists(cwd, remoteName, baseRef))
    ) {
      // Prefer the PR target's tracking branch, without requiring a local checkout.
      // Explicit refs and bases that only exist locally retain their meaning.
      baseRef = `refs/remotes/${remoteName}/${baseRef}`;
    }
    const commitRange = `${baseRef}..HEAD`;
    const mergeBaseArgs = ["merge-base", "--all", baseRef, "HEAD"];
    const mergeBaseResult = yield* executeGit(
      "GitVcsDriver.readRangeContext.mergeBase",
      cwd,
      mergeBaseArgs,
      { allowNonZeroExit: true },
    );
    const mergeBases = mergeBaseResult.stdout.trim().split("\n").filter(Boolean);
    if (mergeBaseResult.exitCode !== 0 || mergeBases.length !== 1) {
      const detail =
        mergeBaseResult.exitCode === 1 && mergeBases.length === 0
          ? `Cannot generate PR content: '${baseRef}' and HEAD have no common ancestor. Fetch the base branch and its history (deepen a shallow clone), then retry. For unrelated histories, choose the correct base or rebase or cherry-pick your changes onto it.`
          : mergeBaseResult.exitCode === 0 && mergeBases.length > 1
            ? `Cannot generate PR content: '${baseRef}' and HEAD have multiple merge bases. Merge or rebase the base branch into your feature branch to establish a unique common ancestor, then retry.`
            : mergeBaseResult.stderr.trim() || "git merge-base failed";
      return yield* createGitCommandError(
        "GitVcsDriver.readRangeContext.mergeBase",
        cwd,
        mergeBaseArgs,
        detail,
      );
    }
    // Resolve once so stat and patch use the same unambiguous common ancestor.
    const diffRange = `${mergeBases[0]}..HEAD`;
    const [commitSummary, diffSummary, diffPatch] = yield* Effect.all(
      [
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.log",
          cwd,
          ["log", "--oneline", commitRange],
          {
            maxOutputBytes: RANGE_COMMIT_SUMMARY_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffStat",
          cwd,
          ["diff", "--stat", diffRange],
          {
            maxOutputBytes: RANGE_DIFF_SUMMARY_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        ),
        runGitStdoutWithOptions(
          "GitVcsDriver.readRangeContext.diffPatch",
          cwd,
          ["diff", "--patch", "--minimal", diffRange],
          {
            maxOutputBytes: RANGE_DIFF_PATCH_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        ),
      ],
      { concurrency: "unbounded" },
    );

    return {
      commitSummary,
      diffSummary,
      diffPatch,
    };
  });

  const readConfigValue: GitVcsDriver.GitVcsDriverShape["readConfigValue"] = (cwd, key) =>
    runGitStdout("GitVcsDriver.readConfigValue", cwd, ["config", "--get", key], true).pipe(
      Effect.map((stdout) => stdout.trim()),
      Effect.map((trimmed) => (trimmed.length > 0 ? trimmed : null)),
    );

  const fetchOrigin = (cwd: string) =>
    runGit("GitVcsDriver.fetchOrigin", cwd, [
      "fetch",
      "--prune",
      "--no-tags",
      "origin",
      "+refs/heads/*:refs/remotes/origin/*",
    ]);

  /**
   * Fetches only `branch` from origin: a worktree needs just its base branch,
   * not every head of the remote. Always fetches (creation must see origin as
   * it is now, even right after the branch picker fetched).
   */
  const fetchOriginBranch = (cwd: string, branch: string) =>
    runGit("GitVcsDriver.fetchOriginBranch", cwd, [
      "fetch",
      "--no-tags",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);

  /**
   * Origin's default branch as this clone recorded it in
   * `refs/remotes/origin/HEAD` (clone and `git remote set-head` write it), or
   * null when it was never recorded.
   */
  const readRecordedOriginDefaultBranch = (cwd: string) =>
    executeGit(
      "GitVcsDriver.originHead.local",
      cwd,
      ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
      { allowNonZeroExit: true, readOnly: true },
    ).pipe(
      Effect.map((local) => {
        const branch =
          local.exitCode === 0
            ? /^refs\/remotes\/origin\/(.+)$/.exec(local.stdout.trim())?.[1]
            : undefined;
        return branch && branch !== "HEAD" ? branch : null;
      }),
    );

  /** Origin's default branch as origin reports it now. */
  const readOriginDefaultBranch = (cwd: string) =>
    Effect.gen(function* () {
      const head = yield* runGitStdout("GitVcsDriver.originHead", cwd, [
        "ls-remote",
        "--symref",
        "origin",
        "HEAD",
      ]);
      const defaultBranch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(head)?.[1];
      if (!defaultBranch) {
        return yield* createGitCommandError(
          "GitVcsDriver.originHead",
          cwd,
          ["ls-remote", "--symref", "origin", "HEAD"],
          "Origin has no default branch.",
        );
      }
      return defaultBranch;
    });

  /**
   * Fetches origin's default branch for a worktree based on `origin/HEAD`
   * and returns its name. The recorded `origin/HEAD` answers without a
   * network round trip; origin is asked (`ls-remote --symref`) when nothing
   * is recorded, or when the recorded branch no longer exists there (a
   * default branch renamed after this clone, e.g. master to main).
   */
  const fetchOriginDefaultBranch = (cwd: string) =>
    Effect.gen(function* () {
      const recorded = yield* readRecordedOriginDefaultBranch(cwd);
      if (recorded !== null) {
        const fetched = yield* fetchOriginBranch(cwd, recorded).pipe(Effect.result);
        if (Result.isSuccess(fetched)) return recorded;
        const current = yield* readOriginDefaultBranch(cwd).pipe(Effect.option);
        if (Option.isNone(current) || current.value === recorded) {
          return yield* Effect.fail(fetched.failure);
        }
        yield* fetchOriginBranch(cwd, current.value);
        return current.value;
      }
      const current = yield* readOriginDefaultBranch(cwd);
      yield* fetchOriginBranch(cwd, current);
      return current;
    });

  /**
   * A worktree base by repository and the remote-tracking ref its fetch
   * updates: `origin/main` and `main` name one ref, so they share one key.
   */
  const worktreeBaseKey = (cwd: string, refName: string) => {
    const base = refName === "origin/HEAD" ? refName : refName.replace(/^origin\//, "");
    return `${path.resolve(cwd)}\u0000${base}`;
  };
  /** Fetches the base a worktree names and returns its branch on origin. */
  const fetchWorktreeBase = (cwd: string, refName: string) => {
    if (refName === "origin/HEAD") return fetchOriginDefaultBranch(cwd);
    const branch = refName.startsWith("origin/") ? refName.slice("origin/".length) : refName;
    return fetchOriginBranch(cwd, branch).pipe(Effect.as(branch));
  };
  /**
   * Base fetches of one repository run one at a time: two that update one ref
   * (`origin/HEAD` and the branch it names) race for its lock.
   */
  const worktreeBaseFetchLocks = yield* makeKeyedSerialExecutor<string>();
  /**
   * The branches this driver creates, renames and cleans up in one repository
   * (by its common directory) change one at a time. Each change writes the
   * shared `.git/config` (a new branch's upstream, a renamed or deleted
   * branch's section), and a Git without `core.configLockTimeout` (Apple's
   * among them) fails at once on a lock another holds: a rename then even
   * stops halfway, its ref moved but its section not. A rename also picks a
   * free name before it takes it.
   */
  const branchChangeLocks = yield* makeKeyedSerialExecutor<string>();
  /** Prefetched bases, by `worktreeBaseKey`: a creation reuses one for a while. */
  const settledWorktreeBasePrefetches = new Map<
    string,
    { readonly branch: string; readonly settledAt: number }
  >();
  const recentWorktreeBasePrefetch = (key: string): string | null => {
    const settled = settledWorktreeBasePrefetches.get(key);
    if (!settled) return null;
    if (Date.now() - settled.settledAt > WORKTREE_BASE_PREFETCH_REUSE_MS) {
      settledWorktreeBasePrefetches.delete(key);
      return null;
    }
    return settled.branch;
  };
  const recordWorktreeBasePrefetch = (key: string, outcome: WorktreeBaseFetch["outcome"]) => {
    if (Exit.isSuccess(outcome)) {
      settledWorktreeBasePrefetches.set(key, { branch: outcome.value, settledAt: Date.now() });
    }
  };
  /**
   * The base fetch running for each `worktreeBaseKey`. Prefetches and
   * creations that start together (one prompt sent to several models, the
   * composer prefetching meanwhile) share one: parallel fetches of one ref race
   * for its lock, and all but one of them fail.
   */
  const worktreeBaseFetches = makeKeyedSingleFlight<string, WorktreeBaseFetch, never>();
  const joinWorktreeBaseFetch = (cwd: string, refName: string, prefetch: boolean) => {
    const key = worktreeBaseKey(cwd, refName);
    // Built only by the caller that starts the fetch, not by every one that joins it.
    const fetchBase = Effect.suspend(() => fetchWorktreeBase(cwd, refName));
    return worktreeBaseFetches.join(
      key,
      worktreeBaseFetchLocks.withLock(path.resolve(cwd), fetchBase).pipe(
        Effect.exit,
        // Recorded by the run itself, so a prefetch whose client stopped
        // waiting (it navigated away) still serves the send that follows.
        Effect.tap((outcome) =>
          Effect.sync(() => {
            if (prefetch) recordWorktreeBasePrefetch(key, outcome);
          }),
        ),
        Effect.map((outcome): WorktreeBaseFetch => ({ prefetch, outcome })),
      ),
    );
  };
  const prefetchWorktreeBase: GitVcsDriver.GitVcsDriverShape["prefetchWorktreeBase"] = (input) =>
    Effect.gen(function* () {
      const key = worktreeBaseKey(input.cwd, input.refName);
      if (recentWorktreeBasePrefetch(key) !== null) return;
      // Forget the stale prefetches of other bases.
      for (const candidate of settledWorktreeBasePrefetches.keys()) {
        recentWorktreeBasePrefetch(candidate);
      }
      const fetched = yield* joinWorktreeBaseFetch(input.cwd, input.refName, true);
      // It joined a creation's fetch, which serves as well as its own would.
      if (!fetched.prefetch) recordWorktreeBasePrefetch(key, fetched.outcome);
      yield* Effect.asVoid(fetched.outcome);
    });

  const notARepositoryRefs = {
    exitCode: ChildProcessSpawner.ExitCode(128),
    stdout: "",
    stderr: "fatal: not a git repository",
    stdoutTruncated: false,
    stderrTruncated: false,
  } satisfies GitVcsDriver.ExecuteGitResult;

  const readListedRefs = (cwd: string, fields: ReadonlyArray<string>) =>
    executeGit(
      "GitVcsDriver.listRefs.forEachRef",
      cwd,
      ["for-each-ref", `--format=${fields.join("%00")}`, "refs/heads", "refs/remotes"],
      {
        timeoutMs: 15_000,
        allowNonZeroExit: true,
        readOnly: true,
        maxOutputBytes: LIST_REFS_MAX_OUTPUT_BYTES,
      },
    ).pipe(Effect.catchIf(isMissingGitCwdError, () => Effect.succeed(notARepositoryRefs)));

  /** Branch to checkout path from `git worktree list` (git without `%(worktreepath)`). */
  const readWorktreeBranchPaths = (cwd: string) =>
    executeGit("GitVcsDriver.listRefs.worktreeList", cwd, ["worktree", "list", "--porcelain"], {
      timeoutMs: 5_000,
      allowNonZeroExit: true,
      readOnly: true,
    }).pipe(
      Effect.map((result) => {
        const branchPaths = new Map<string, string>();
        if (result.exitCode !== 0) return branchPaths;
        let currentPath: string | null = null;
        for (const line of result.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            currentPath = line.slice("worktree ".length);
          } else if (line.startsWith("branch refs/heads/") && currentPath) {
            branchPaths.set(line.slice("branch refs/heads/".length), currentPath);
          } else if (line === "") {
            currentPath = null;
          }
        }
        return branchPaths;
      }),
      Effect.catch(() => Effect.succeed(new Map<string, string>())),
    );

  /**
   * Every branch of `cwd`, sorted for listing (unfiltered, unpaginated); null
   * outside a repository. Cached briefly so a branch picker's later pages and
   * searches reuse one read; any git command that may write drops it.
   */
  const readBranchListing = Effect.fn("readBranchListing")(function* (cwd: string) {
    // One for-each-ref yields every branch with its recency, the current
    // branch, its checkout and origin/HEAD, where this used to take six
    // processes (branch, branch --remotes, remote, symbolic-ref, worktree
    // list, for-each-ref).
    let refsResult = yield* readListedRefs(cwd, LIST_REFS_FIELDS);
    let worktreeBranchPaths: Map<string, string> | null = null;
    if (refsResult.exitCode !== 0 && /unknown field name/i.test(refsResult.stderr)) {
      // Git older than 2.25 has no %(worktreepath).
      refsResult = yield* readListedRefs(cwd, LIST_REFS_FIELDS_WITHOUT_WORKTREE);
      worktreeBranchPaths = yield* readWorktreeBranchPaths(cwd);
    }

    if (refsResult.exitCode !== 0) {
      const stderr = refsResult.stderr.trim();
      if (stderr.toLowerCase().includes("not a git repository")) {
        return null;
      }
      return yield* createGitCommandError(
        "GitVcsDriver.listRefs",
        cwd,
        ["for-each-ref", "refs/heads", "refs/remotes"],
        stderr || "git for-each-ref failed",
      );
    }

    // Longest first, so `my-org/upstream/x` is not read as remote `my-org`.
    const remoteNames = yield* readConfigSnapshot(cwd).pipe(
      Effect.map((snapshot) => snapshot.remoteNames.toSorted((a, b) => b.length - a.length)),
      Effect.catch((error) =>
        Effect.logWarning(
          `GitVcsDriver.listRefs: remote name lookup failed for ${cwd}: ${error.message}. Falling back to an empty remote name list.`,
        ).pipe(Effect.as<ReadonlyArray<string>>([])),
      ),
    );

    const listed = parseListedRefs(refsResult.stdout);
    const defaultBranch =
      listed
        .find((ref) => ref.refname === "refs/remotes/origin/HEAD")
        ?.symref.replace(/^refs\/remotes\/origin\//, "") || null;

    // A checkout that no longer exists on disk (prunable) is not offered as a target.
    const candidateWorktreePaths = new Set<string>();
    for (const ref of listed) {
      const worktreePath = worktreeBranchPaths
        ? (worktreeBranchPaths.get(ref.refname.slice("refs/heads/".length)) ?? "")
        : ref.worktreePath;
      if (ref.refname.startsWith("refs/heads/") && worktreePath.length > 0) {
        candidateWorktreePaths.add(worktreePath);
      }
    }
    const existingWorktreePaths = new Set<string>();
    yield* Effect.forEach(
      candidateWorktreePaths,
      (candidatePath) =>
        fileSystem.stat(candidatePath).pipe(
          Effect.map(() => {
            existingWorktreePaths.add(candidatePath);
          }),
          Effect.catch(() => Effect.void),
        ),
      { concurrency: 8, discard: true },
    );

    const branchLastCommit = new Map<string, number>();
    const localBranchRefs: Array<{
      name: string;
      current: boolean;
      worktreePath: string | null;
    }> = [];
    const remoteBranchNames: string[] = [];
    for (const ref of listed) {
      if (ref.symref.length > 0) continue;
      if (ref.refname.startsWith("refs/heads/")) {
        const name = ref.refname.slice("refs/heads/".length);
        if (name.length === 0) continue;
        const worktreePath = worktreeBranchPaths
          ? (worktreeBranchPaths.get(name) ?? "")
          : ref.worktreePath;
        branchLastCommit.set(name, ref.lastCommit);
        localBranchRefs.push({
          name,
          current: ref.isHead,
          worktreePath: existingWorktreePaths.has(worktreePath) ? worktreePath : null,
        });
      } else if (ref.refname.startsWith("refs/remotes/")) {
        const name = ref.refname.slice("refs/remotes/".length);
        if (name.length === 0) continue;
        branchLastCommit.set(name, ref.lastCommit);
        remoteBranchNames.push(name);
      }
    }

    const localBranches = localBranchRefs
      .map((refName) => ({
        name: refName.name,
        current: refName.current,
        isRemote: false,
        isDefault: refName.name === defaultBranch,
        worktreePath: refName.worktreePath,
      }))
      .toSorted((a, b) => {
        const aPriority = a.current ? 0 : a.isDefault ? 1 : 2;
        const bPriority = b.current ? 0 : b.isDefault ? 1 : 2;
        if (aPriority !== bPriority) return aPriority - bPriority;

        const aLastCommit = branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchLastCommit.get(b.name) ?? 0;
        if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
        return a.name.localeCompare(b.name);
      });

    const remoteBranches = remoteBranchNames
      .map((name) => {
        const parsedRemoteRef = parseRemoteRefWithRemoteNames(name, remoteNames);
        const remoteBranch: {
          name: string;
          current: boolean;
          isRemote: boolean;
          remoteName?: string;
          isDefault: boolean;
          worktreePath: string | null;
        } = {
          name,
          current: false,
          isRemote: true,
          isDefault: false,
          worktreePath: null,
        };
        if (parsedRemoteRef) {
          remoteBranch.remoteName = parsedRemoteRef.remoteName;
        }
        return remoteBranch;
      })
      .toSorted((a, b) => {
        const aLastCommit = branchLastCommit.get(a.name) ?? 0;
        const bLastCommit = branchLastCommit.get(b.name) ?? 0;
        if (aLastCommit !== bLastCommit) return bLastCommit - aLastCommit;
        return a.name.localeCompare(b.name);
      });

    return {
      localBranches,
      remoteBranches,
      hasPrimaryRemote: remoteNames.includes("origin"),
    };
  });

  const branchListingCache = yield* Cache.makeWith(readBranchListing, {
    capacity: BRANCH_LISTING_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? BRANCH_LISTING_CACHE_TTL : Duration.zero),
  });
  invalidateReadCaches = Effect.andThen(
    Cache.invalidateAll(configSnapshotCache),
    Cache.invalidateAll(branchListingCache),
  );

  const invalidateRefListing: GitVcsDriver.GitVcsDriverShape["invalidateRefListing"] = (cwd) =>
    Cache.invalidate(branchListingCache, path.resolve(cwd));

  const listRefs: GitVcsDriver.GitVcsDriverShape["listRefs"] = Effect.fn("listRefs")(
    function* (input) {
      const cacheKey = path.resolve(input.cwd);
      if (input.fetchOrigin) {
        yield* fetchOrigin(input.cwd);
        yield* Cache.invalidate(branchListingCache, cacheKey);
      }
      const listing = yield* Cache.get(branchListingCache, cacheKey);
      if (listing === null) {
        return {
          refs: [],
          isRepo: false,
          hasPrimaryRemote: false,
          nextCursor: null,
          totalCount: 0,
        };
      }
      const { localBranches, remoteBranches } = listing;

      const refs = paginateBranches({
        refs: filterBranchesForListQuery(
          input.originOnly
            ? remoteBranches.filter((ref) => ref.remoteName === "origin")
            : dedupeRemoteBranchesWithLocalMatches([...localBranches, ...remoteBranches]),
          input.query,
        ),
        cursor: input.cursor,
        limit: input.limit,
      });

      return {
        refs: [...refs.refs],
        isRepo: true,
        hasPrimaryRemote: listing.hasPrimaryRemote,
        nextCursor: refs.nextCursor,
        totalCount: refs.totalCount,
      };
    },
  );

  const worktreePathIdentity = (candidate: string) =>
    Effect.tryPromise({
      try: () => canonicalizeWorktreePath(candidate),
      catch: (cause) =>
        createGitCommandError(
          "GitVcsDriver.worktreeSetup",
          candidate,
          [],
          "Cannot resolve the canonical worktree path.",
          cause,
        ),
    });

  // Recovery needs proof of absence. The ordinary discovery method tolerates
  // non-repositories; never use its empty-list fallback for journal recovery.
  const registeredWorktreePathsForRecovery = (cwd: string) =>
    Effect.gen(function* () {
      const args = ["worktree", "list", "--porcelain", "-z"];
      const result = yield* executeGit("GitVcsDriver.worktreeSetup.registration", cwd, args, {
        timeoutMs: 5_000,
      });
      if (result.stdoutTruncated || !result.stdout.endsWith("\0\0"))
        return yield* createGitCommandError(
          "GitVcsDriver.worktreeSetup.registration",
          cwd,
          args,
          "Cannot prove worktree registration is absent: incomplete Git worktree listing.",
        );
      const paths: string[] = [];
      for (const record of result.stdout.slice(0, -2).split("\0\0")) {
        const field = record.split("\0")[0];
        const candidate = field?.startsWith("worktree ")
          ? field.slice("worktree ".length)
          : undefined;
        if (!candidate || !nodePath.isAbsolute(candidate))
          return yield* createGitCommandError(
            "GitVcsDriver.worktreeSetup.registration",
            cwd,
            args,
            "Cannot prove worktree registration is absent: invalid Git worktree listing.",
          );
        paths.push(yield* worktreePathIdentity(candidate));
      }
      return paths;
    });

  const worktreeRepositoryIdentity = (cwd: string) =>
    resolveGitCommonDir(cwd).pipe(Effect.flatMap(worktreePathIdentity));

  const recoverSetup = (cwd: string, checkoutPath: string) =>
    Effect.gen(function* () {
      return yield* recoverOrphanedWorktreeSetup({
        stateDir: config.stateDir,
        checkoutPath,
        repositoryPath: worktreeRepositoryIdentity(cwd),
        registeredWorktreePaths: registeredWorktreePathsForRecovery(cwd),
      });
    });

  const createWorktree: GitVcsDriver.GitVcsDriverShape["createWorktree"] = Effect.fn(
    "createWorktree",
  )(function* (input) {
    const settings =
      input.settingsSnapshot ??
      (Option.isSome(settingsService)
        ? yield* settingsService.value.getSettings.pipe(
            Effect.mapError((cause) =>
              createGitCommandError(
                "GitVcsDriver.createWorktree.settings",
                input.cwd,
                ["worktree", "add"],
                `Cannot load worktree settings: ${cause.message}`,
                cause,
              ),
            ),
          )
        : DEFAULT_SERVER_SETTINGS);
    let baseRef = input.refName;
    if (input.fetchOrigin) {
      // Only the base branch is fetched (not every head of origin): it is on
      // the critical path before the first turn exists. A prefetch of the same
      // base (the composer asks for one when it enters worktree mode) stands in
      // for it while running or recently finished; a failed one is retried here.
      yield* input.progress?.onFetchStarted?.() ?? Effect.void;
      const prefetched = recentWorktreeBasePrefetch(worktreeBaseKey(input.cwd, baseRef));
      let reused = prefetched !== null;
      let baseBranch = prefetched;
      if (baseBranch === null) {
        let fetched = yield* joinWorktreeBaseFetch(input.cwd, baseRef, false);
        // A failed prefetch is retried here; a creation's failed fetch is the
        // answer for every creation that joined it.
        if (fetched.prefetch && Exit.isFailure(fetched.outcome)) {
          fetched = yield* joinWorktreeBaseFetch(input.cwd, baseRef, false);
        }
        reused = fetched.prefetch;
        baseBranch = yield* fetched.outcome;
      }
      yield* input.progress?.onFetchFinished?.({ reused, branch: baseBranch }) ?? Effect.void;
      // Fully qualified refs prevent a same-named local branch from winning.
      baseRef = `refs/remotes/origin/${baseBranch}`;
    }
    const targetBranch = input.newRefName ?? baseRef;
    const worktreePath = yield* Effect.gen(function* () {
      const candidate =
        input.path ??
        (yield* resolveWorktreeCheckoutPath({
          location: undefined,
          appWorktreesRoot: selectConfiguredWorktreeRoot({
            settings,
            projectId: input.projectId,
            config,
          }),
          projectTitle: input.projectTitle,
          initialName: input.initialName,
          projectId: input.projectId ?? input.cwd,
          workspaceRoot: input.cwd,
          projectMetadataDir: null,
          branchName: targetBranch,
        }));
      const canonical = yield* validateWorktreeRoot(candidate, worktreePolicy);
      return canonical;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.createWorktree",
            command: "git worktree add",
            cwd: input.cwd,
            detail: cause.message,
            cause,
          }),
      ),
    );

    if (Option.isSome(storageSql)) {
      const release = yield* acquireWorktreeCreationLease(storageSql.value, worktreePath).pipe(
        Effect.mapError((cause) =>
          createGitCommandError(
            "GitVcsDriver.createWorktree",
            input.cwd,
            ["worktree", "add"],
            cause instanceof Error ? cause.message : "Storage admission failed.",
            cause,
          ),
        ),
      );
      yield* Effect.addFinalizer(() => release);
    }

    // A new branch is created first, as `worktree add -b` does itself (tracking
    // included), but under `branchChangeLocks`: only that short config write
    // waits for other creations, not the checkout.
    const newRefName = input.newRefName;
    const args = ["worktree", "add", worktreePath, newRefName ?? baseRef];
    const onCheckoutProgress = input.progress?.onCheckoutProgress;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const destinationLock = yield* RcMap.get(worktreeDestinations, worktreePath);
        return yield* destinationLock.withPermit(
          withWorktreeSetupOwnership(config.stateDir, worktreePath, (mutation, ownerToken) =>
            Effect.gen(function* () {
              // Concurrent Git processes can remove a winner's checkout while cleaning
              // up a failed add. Hold this destination through setup and explicit removal
              // so an older completion cannot clear a newer attempt's journal.
              const exists = yield* fileSystem.exists(worktreePath).pipe(
                Effect.mapError(
                  (cause) =>
                    new GitCommandError({
                      operation: "GitVcsDriver.createWorktree",
                      command: "git worktree add",
                      cwd: input.cwd,
                      detail: cause.message,
                      cause,
                    }),
                ),
              );
              if (exists) {
                yield* assertWorktreeSetupComplete(config.stateDir, worktreePath, ownerToken);
                return yield* createGitCommandError(
                  "GitVcsDriver.createWorktree",
                  input.cwd,
                  args,
                  "Worktree destination already exists. Choose a different branch or root.",
                );
              }
              yield* recoverSetup(input.cwd, worktreePath);
              const repositoryPath = yield* worktreeRepositoryIdentity(input.cwd);
              const createBranch = newRefName
                ? branchChangeLocks.withLock(
                    repositoryPath,
                    executeGit(
                      "GitVcsDriver.createWorktree.createBranch",
                      input.cwd,
                      ["branch", "--", newRefName, baseRef],
                      { fallbackErrorMessage: "git branch failed" },
                    ),
                  )
                : Effect.void;
              // A branch created here is deleted again when its checkout fails or
              // is cut off, so an identical retry is not refused on it. Git keeps
              // a branch a registered checkout uses: a partial checkout keeps it.
              const removeCreatedBranch = newRefName
                ? branchChangeLocks
                    .withLock(
                      repositoryPath,
                      executeGit(
                        "GitVcsDriver.createWorktree.removeBranch",
                        input.cwd,
                        ["branch", "-D", "--", newRefName],
                        { allowNonZeroExit: true, timeoutMs: 10_000 },
                      ),
                    )
                    .pipe(Effect.ignore)
                : Effect.void;
              yield* input.progress?.onCheckoutStarted?.() ?? Effect.void;
              // Persist journal and mutation ownership before Git can register a
              // checkout. A cancelled child leaves an uncertain guard for inspection.
              yield* Effect.uninterruptibleMask((restore) =>
                beginWorktreeSetup(config.stateDir, worktreePath, repositoryPath).pipe(
                  Effect.andThen(mutation),
                  Effect.andThen(restore(createBranch)),
                  Effect.andThen(
                    restore(
                      executeGit("GitVcsDriver.createWorktree", input.cwd, args, {
                        fallbackErrorMessage: "git worktree add failed",
                        ...(onCheckoutProgress
                          ? {
                              // Git prints its checkout meter to a pipe only once
                              // the delay passes; zero makes every update visible.
                              env: { GIT_PROGRESS_DELAY: "0" },
                              progress: {
                                splitStderrAtCarriageReturn: true,
                                onStderrLine: (line: string) => {
                                  const percent = parseGitCheckoutProgressPercent(line);
                                  return percent === null
                                    ? Effect.void
                                    : onCheckoutProgress(percent);
                                },
                              },
                            }
                          : {}),
                      }),
                    ).pipe(Effect.onError(() => removeCreatedBranch)),
                  ),
                ),
              );

              yield* worktreePolicy
                .assertExistingPath({
                  path: worktreePath,
                  operation: "GitVcsDriver.createWorktree",
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new GitCommandError({
                        operation: "GitVcsDriver.createWorktree",
                        command: "git worktree add",
                        cwd: input.cwd,
                        detail: cause.message,
                        cause,
                      }),
                  ),
                );
              const submodules = yield* resolveWorktreeSubmodules({
                checkoutPath: worktreePath,
                settings,
                projectId: input.projectId,
                policy: worktreePolicy,
              }).pipe(
                Effect.mapError((cause) =>
                  createGitCommandError(
                    "GitVcsDriver.createWorktree.resolveSubmodules",
                    worktreePath,
                    ["worktree", "add"],
                    `The worktree was created at ${worktreePath}, but submodule setup could not start: ${cause.message}`,
                    cause,
                  ),
                ),
              );
              const gitmodulesPath = path.join(worktreePath, ".gitmodules");
              const hasGitmodules = yield* fileSystem.exists(gitmodulesPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new GitCommandError({
                      operation: "GitVcsDriver.createWorktree.inspectSubmodules",
                      command: "inspect .gitmodules",
                      cwd: worktreePath,
                      detail: `Failed to inspect ${gitmodulesPath} after creating the worktree.`,
                      cause,
                    }),
                ),
              );

              if (hasGitmodules && submodules.mode !== "none") {
                const submoduleArgs = [
                  "submodule",
                  "update",
                  "--init",
                  ...(submodules.mode === "recursive" ? ["--recursive"] : []),
                ];
                yield* executeGit(
                  "GitVcsDriver.createWorktree.initializeSubmodules",
                  worktreePath,
                  submoduleArgs,
                  {
                    timeoutMs: 120_000,
                    fallbackErrorMessage: "git submodule initialization failed",
                  },
                ).pipe(
                  Effect.mapError((error) =>
                    createGitCommandError(
                      "GitVcsDriver.createWorktree.initializeSubmodules",
                      worktreePath,
                      submoduleArgs,
                      `The worktree was created at ${worktreePath}, but its submodules could not be initialized (${submodules.mode}): ${error.detail}. Check submodule URLs and credentials, then remove this incomplete checkout through source control and recreate it using its existing branch (preserve any work first).`,
                      error,
                    ),
                  ),
                );
              }

              if (input.dependencyHydration === "copyInstallDirs") {
                yield* copyWorktreeDependencyInstallDirs({ cwd: input.cwd, worktreePath });
              }

              yield* finishWorktreeSetup(config.stateDir, worktreePath);
              // Only completed setup becomes cleanup-owned. A retained failed
              // checkout keeps its incomplete journal and remains protected.
              if (Option.isSome(storageSql)) {
                yield* recordCreatedWorktree(storageSql.value, input.cwd, worktreePath).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning(
                      "Worktree ownership could not be persisted; storage cleanup will protect it",
                      { detail: String(cause) },
                    ),
                  ),
                );
              }

              return {
                worktree: {
                  path: worktreePath,
                  refName: targetBranch,
                },
                submoduleInitialization: {
                  ...submodules,
                  status:
                    hasGitmodules && submodules.mode !== "none"
                      ? ("initialized" as const)
                      : ("skipped" as const),
                  reason: !hasGitmodules
                    ? "No .gitmodules file in this checkout."
                    : submodules.mode === "none"
                      ? `Submodule initialization disabled by ${submodules.source} settings.`
                      : submodules.mode === "top-level"
                        ? "Initialized top-level submodules; nested submodules were left uninitialized."
                        : "Initialized submodules recursively.",
                },
              };
            }),
          ),
        );
      }),
    );
  }, Effect.scoped);

  const fetchPullRequestBranch: GitVcsDriver.GitVcsDriverShape["fetchPullRequestBranch"] =
    Effect.fn("fetchPullRequestBranch")(function* (input) {
      const remoteName = yield* resolvePrimaryRemoteName(input.cwd);
      yield* executeGit(
        "GitVcsDriver.fetchPullRequestBranch",
        input.cwd,
        [
          "fetch",
          "--quiet",
          "--no-tags",
          remoteName,
          `+refs/pull/${input.prNumber}/head:refs/heads/${input.branch}`,
        ],
        {
          fallbackErrorMessage: "git fetch pull request branch failed",
        },
      );
    });

  const fetchRemoteBranch: GitVcsDriver.GitVcsDriverShape["fetchRemoteBranch"] = Effect.fn(
    "fetchRemoteBranch",
  )(function* (input) {
    yield* runGit("GitVcsDriver.fetchRemoteBranch.fetch", input.cwd, [
      "fetch",
      "--quiet",
      "--no-tags",
      input.remoteName,
      `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
    ]);

    const localBranchAlreadyExists = yield* branchExists(input.cwd, input.localBranch);
    const targetRef = `${input.remoteName}/${input.remoteBranch}`;
    yield* runGit(
      "GitVcsDriver.fetchRemoteBranch.materialize",
      input.cwd,
      localBranchAlreadyExists
        ? ["branch", "--force", input.localBranch, targetRef]
        : ["branch", input.localBranch, targetRef],
    );
  });

  const fetchRemoteTrackingBranch: GitVcsDriver.GitVcsDriverShape["fetchRemoteTrackingBranch"] =
    Effect.fn("fetchRemoteTrackingBranch")(function* (input) {
      yield* runGit("GitVcsDriver.fetchRemoteTrackingBranch", input.cwd, [
        "fetch",
        "--quiet",
        "--no-tags",
        input.remoteName,
        `+refs/heads/${input.remoteBranch}:refs/remotes/${input.remoteName}/${input.remoteBranch}`,
      ]);
    });

  const setBranchUpstream: GitVcsDriver.GitVcsDriverShape["setBranchUpstream"] = (input) =>
    runGit("GitVcsDriver.setBranchUpstream", input.cwd, [
      "branch",
      "--set-upstream-to",
      `${input.remoteName}/${input.remoteBranch}`,
      input.branch,
    ]);

  const removeWorktree: GitVcsDriver.GitVcsDriverShape["removeWorktree"] = Effect.fn(
    "removeWorktree",
  )(function* (input) {
    if (input.cleanup) {
      if (input.force)
        return yield* createGitCommandError(
          "GitVcsDriver.removeWorktree",
          input.cwd,
          [],
          "Verified cleanup cannot force removal.",
        );
      const markerPath = yield* worktreePathIdentity(input.path);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const destinationLock = yield* RcMap.get(worktreeDestinations, markerPath);
          yield* destinationLock.withPermit(
            withWorktreeSetupOwnership(config.stateDir, markerPath, (mutation, ownerToken) =>
              Effect.gen(function* () {
                yield* assertWorktreeSetupComplete(config.stateDir, markerPath, ownerToken);
                yield* mutation;
                yield* Effect.tryPromise({
                  try: () => removeVerifiedWorktree(input.cwd, markerPath, input.cleanup!),
                  catch: (cause) =>
                    createGitCommandError(
                      "GitVcsDriver.removeWorktree",
                      input.cwd,
                      [],
                      cause instanceof Error ? cause.message : "Verified cleanup failed",
                      cause,
                    ),
                }).pipe(Effect.uninterruptible);
              }),
            ),
          );
        }),
      );
      return;
    }
    const args = ["worktree", "remove"];
    if (input.force) {
      args.push("--force");
    }
    args.push(input.path);
    const removedPath = yield* worktreePolicy
      .assertPath({ path: input.path, operation: "GitVcsDriver.removeWorktree" })
      .pipe(
        Effect.mapError((cause) =>
          createGitCommandError(
            "GitVcsDriver.removeWorktree",
            input.cwd,
            args,
            cause.message,
            cause,
          ),
        ),
      );
    const markerPath = yield* worktreePathIdentity(removedPath);
    args[args.length - 1] = markerPath;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const destinationLock = yield* RcMap.get(worktreeDestinations, markerPath);
        yield* destinationLock.withPermit(
          withWorktreeSetupOwnership(config.stateDir, markerPath, (mutation) =>
            Effect.gen(function* () {
              if (yield* recoverSetup(input.cwd, markerPath)) return;
              yield* mutation;
              yield* executeGit("GitVcsDriver.removeWorktree", input.cwd, args, {
                timeoutMs: 15_000,
                fallbackErrorMessage: "git worktree remove failed",
              }).pipe(
                Effect.mapError((error) =>
                  createGitCommandError(
                    "GitVcsDriver.removeWorktree",
                    input.cwd,
                    args,
                    `${commandLabel(args)} failed (cwd: ${input.cwd}): ${error.message}`,
                    error,
                  ),
                ),
              );
              yield* finishWorktreeSetup(config.stateDir, markerPath);
            }),
          ),
        );
      }),
    );
  });

  const pruneWorktrees: GitVcsDriver.GitVcsDriverShape["pruneWorktrees"] = (cwd) =>
    executeGit("GitVcsDriver.pruneWorktrees", cwd, ["worktree", "prune", "--expire", "now"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git worktree prune failed",
    }).pipe(Effect.asVoid);

  const renameBranch: GitVcsDriver.GitVcsDriverShape["renameBranch"] = Effect.fn("renameBranch")(
    function* (input) {
      if (input.oldBranch === input.newBranch) {
        return { branch: input.newBranch };
      }
      // Threads started together rename their branches as each goes idle, often
      // to the same name: the free name is picked and taken under the lock.
      const repositoryPath = yield* worktreeRepositoryIdentity(input.cwd);
      return yield* branchChangeLocks.withLock(
        repositoryPath,
        Effect.gen(function* () {
          const targetBranch = yield* resolveAvailableBranchName(input.cwd, input.newBranch);
          yield* executeGit(
            "GitVcsDriver.renameBranch",
            input.cwd,
            ["branch", "-m", "--", input.oldBranch, targetBranch],
            {
              timeoutMs: 10_000,
              fallbackErrorMessage: "git branch rename failed",
            },
          );
          return { branch: targetBranch };
        }),
      );
    },
  );

  const switchRef: GitVcsDriver.GitVcsDriverShape["switchRef"] = Effect.fn("switchRef")(
    function* (input) {
      const [localInputExists, remoteExists] = yield* Effect.all(
        [
          executeGit(
            "GitVcsDriver.switchRef.localInputExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/heads/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
          executeGit(
            "GitVcsDriver.switchRef.remoteExists",
            input.cwd,
            ["show-ref", "--verify", "--quiet", `refs/remotes/${input.refName}`],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(Effect.map((result) => result.exitCode === 0)),
        ],
        { concurrency: "unbounded" },
      );

      const localTrackingBranch = remoteExists
        ? yield* executeGit(
            "GitVcsDriver.switchRef.localTrackingBranch",
            input.cwd,
            ["for-each-ref", "--format=%(refname:short)\t%(upstream:short)", "refs/heads"],
            {
              timeoutMs: 5_000,
              allowNonZeroExit: true,
            },
          ).pipe(
            Effect.map((result) =>
              result.exitCode === 0
                ? parseTrackingBranchByUpstreamRef(result.stdout, input.refName)
                : null,
            ),
          )
        : null;

      const localTrackedBranchCandidate = deriveLocalBranchNameFromRemoteRef(input.refName);
      const localTrackedBranchTargetExists =
        remoteExists && localTrackedBranchCandidate
          ? yield* executeGit(
              "GitVcsDriver.switchRef.localTrackedBranchTargetExists",
              input.cwd,
              ["show-ref", "--verify", "--quiet", `refs/heads/${localTrackedBranchCandidate}`],
              {
                timeoutMs: 5_000,
                allowNonZeroExit: true,
              },
            ).pipe(Effect.map((result) => result.exitCode === 0))
          : false;

      const checkoutArgs = localInputExists
        ? ["checkout", input.refName]
        : remoteExists && !localTrackingBranch && localTrackedBranchTargetExists
          ? ["checkout", input.refName]
          : remoteExists && !localTrackingBranch
            ? ["checkout", "--track", input.refName]
            : remoteExists && localTrackingBranch
              ? ["checkout", localTrackingBranch]
              : ["checkout", input.refName];

      yield* executeGit("GitVcsDriver.switchRef.checkout", input.cwd, checkoutArgs, {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git checkout failed",
      });

      const refName = yield* runGitStdout("GitVcsDriver.switchRef.currentBranch", input.cwd, [
        "branch",
        "--show-current",
      ]).pipe(Effect.map((stdout) => stdout.trim() || null));

      return { refName };
    },
  );

  const createRef: GitVcsDriver.GitVcsDriverShape["createRef"] = Effect.fn("createRef")(
    function* (input) {
      yield* executeGit("GitVcsDriver.createRef", input.cwd, ["branch", input.refName], {
        timeoutMs: 10_000,
        fallbackErrorMessage: "git branch create failed",
      });
      if (input.switchRef) {
        yield* switchRef({ cwd: input.cwd, refName: input.refName });
      }

      return { refName: input.refName };
    },
  );

  const deleteBranch: GitVcsDriver.GitVcsDriverShape["deleteBranch"] = Effect.fn("deleteBranch")(
    function* (input) {
      // Deleting a branch drops its config section: a cancelled send cleans up
      // while other branches of the repository are being created.
      const repositoryPath = yield* worktreeRepositoryIdentity(input.cwd);
      yield* branchChangeLocks.withLock(
        repositoryPath,
        executeGit(
          "GitVcsDriver.deleteBranch",
          input.cwd,
          ["branch", input.force ? "-D" : "-d", input.refName],
          {
            timeoutMs: 10_000,
            fallbackErrorMessage: "git branch delete failed",
          },
        ),
      );
    },
  );

  const initRepo: GitVcsDriver.GitVcsDriverShape["initRepo"] = (input) =>
    executeGit("GitVcsDriver.initRepo", input.cwd, ["init"], {
      timeoutMs: 10_000,
      fallbackErrorMessage: "git init failed",
    }).pipe(Effect.asVoid);

  const listLocalBranchNames: GitVcsDriver.GitVcsDriverShape["listLocalBranchNames"] = (cwd) =>
    executeGit(
      "GitVcsDriver.listLocalBranchNames",
      cwd,
      ["branch", "--list", "--no-column", "--format=%(refname:short)"],
      { readOnly: true },
    ).pipe(
      Effect.map((result) =>
        result.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      ),
    );

  const listWorktreePaths: GitVcsDriver.GitVcsDriverShape["listWorktreePaths"] = (cwd) =>
    executeGit("GitVcsDriver.listWorktreePaths", cwd, ["worktree", "list", "--porcelain"], {
      timeoutMs: 5_000,
      allowNonZeroExit: true,
      readOnly: true,
    }).pipe(
      Effect.map((result) => {
        if (result.exitCode !== 0) {
          return [] as string[];
        }
        const paths: string[] = [];
        for (const line of result.stdout.split("\n")) {
          if (line.startsWith("worktree ")) {
            paths.push(line.slice("worktree ".length));
          }
        }
        return paths;
      }),
    );

  return GitVcsDriver.GitVcsDriver.of({
    execute,
    readConfigSnapshot,
    status,
    statusDetails,
    statusDetailsLocal,
    refreshStatusTracking,
    refreshStatusUpstream,
    prepareCommitContext,
    commit,
    pushCurrentBranch,
    pullCurrentBranch,
    readRangeContext,
    readConfigValue,
    listRefs,
    invalidateRefListing,
    createWorktree,
    prefetchWorktreeBase,
    assertWorktreeSetupComplete: (checkoutPath) =>
      worktreePolicy
        .assertExistingPath({ path: checkoutPath, operation: "GitVcsDriver.worktreeSetup" })
        .pipe(
          Effect.mapError((cause) =>
            createGitCommandError(
              "GitVcsDriver.worktreeSetup",
              checkoutPath,
              [],
              cause.message,
              cause,
            ),
          ),
          Effect.flatMap((authorized) => assertWorktreeSetupComplete(config.stateDir, authorized)),
        ),
    fetchPullRequestBranch,
    ensureRemote,
    resolvePrimaryRemoteName,
    fetchRemoteBranch,
    fetchRemoteTrackingBranch,
    setBranchUpstream,
    removeWorktree,
    pruneWorktrees,
    renameBranch,
    createRef,
    deleteBranch,
    switchRef,
    initRepo,
    listLocalBranchNames,
    listWorktreePaths,
  });
});
