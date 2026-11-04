/**
 * gitCloneCommon - what every git transfer of a repository shares: the one-shot
 * `sourceControl.cloneRepository` clone (`gitCloneRun.ts`) and the cross-node project import's
 * clone, submodule and LFS steps (`projectCopy/`).
 *
 * - **Slots.** At most {@link CLONE_CONCURRENCY} of them run at once, counted together, so
 *   background git work keeps room in the process pool.
 * - **Stall limit.** A transfer fails after {@link CLONE_STALL_TIMEOUT_MS} without any output
 *   (on a responsive deadline, so machine sleep does not count).
 * - **Environment.** {@link CLONE_ENV}: never a prompt, and progress that starts at once.
 * - **git's messages.** Progress redraws are never part of an error; failure text is git's last
 *   real lines, credential-redacted.
 *
 * Small and free of the runners themselves, so both lazily loaded runners share it (and its slot
 * semaphore) without either pulling in the other.
 *
 * @module gitCloneCommon
 */
import { redactGitCredentials } from "@ryco/shared/gitRemoteUrl";
import { type Effect, Semaphore } from "effect";

import { GIT_PROCESS_LIMIT } from "../processGovernor.ts";
import { NON_INTERACTIVE_GIT_ENV } from "../vcs/GitVcsDriver.ts";

/** A clone (or an import's submodule or LFS transfer) fails after this long without any output. */
export const CLONE_STALL_TIMEOUT_MS = 5 * 60_000;

/**
 * A clone holds one git process permit for its whole life, so clones take at most half of the
 * process pool and background git work (status, sweeps) keeps room.
 */
export const CLONE_CONCURRENCY = Math.min(2, Math.max(1, Math.floor(GIT_PROCESS_LIMIT / 2)));
const cloneSlots = Semaphore.makeUnsafe(CLONE_CONCURRENCY);

/**
 * Runs `effect` in one of the {@link CLONE_CONCURRENCY} clone slots, waiting for one first. Take
 * it around the transfer only: a slot held while waiting on anything else would hold up clones.
 */
export const withGitCloneSlot = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  cloneSlots.withPermits(1)(effect);

/**
 * `NON_INTERACTIVE_GIT_ENV` (no prompt of any kind, the C locale), plus: the progress meters start
 * at once, and git-lfs prints progress to a pipe, so a long but healthy transfer keeps the stall
 * limit fed.
 */
export const CLONE_ENV: Readonly<Record<string, string>> = Object.freeze({
  ...NON_INTERACTIVE_GIT_ENV,
  GIT_PROGRESS_DELAY: "0",
  GIT_LFS_FORCE_PROGRESS: "1",
});

const PROGRESS_LINE =
  /^(?:remote:\s*)?(?:Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Unpacking objects|Updating files|Checking out files|Checking connectivity|Filtering content)\b/iu;
const REMOTE_TOTAL_LINE = /^remote:\s*Total \d+/u;
/** Any other meter, e.g. git-lfs's `Downloading LFS objects:  42% (1/2), 1.0 MB | 1.0 MB/s`. */
const PERCENT_METER_LINE = /^(?:remote:\s*)?[A-Za-z ]+:\s+\d{1,3}% \(/u;

/** A progress-meter redraw, never part of an error message. */
export function isGitCloneProgressLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    PROGRESS_LINE.test(trimmed) ||
    REMOTE_TOTAL_LINE.test(trimmed) ||
    PERCENT_METER_LINE.test(trimmed)
  );
}

const CLONE_FAILURE_DETAIL_MAX_CHARS = 1_000;

/** User-facing detail from git's last messages. */
export function cloneFailureDetail(
  tail: ReadonlyArray<string>,
  fallback = "The repository could not be cloned.",
): string {
  const joined = tail.join(" ").trim();
  if (joined.length === 0) return fallback;
  return joined.length <= CLONE_FAILURE_DETAIL_MAX_CHARS
    ? joined
    : `…${joined.slice(-(CLONE_FAILURE_DETAIL_MAX_CHARS - 1)).trimStart()}`;
}

/** ssh refusing a host whose key is unknown or changed. */
export const GIT_HOST_KEY_FAILURE =
  /host key verification failed|no \S+ host key is known for|remote host identification has changed/i;

/** git, ssh and curl wording for "this node cannot reach or read that remote". */
export const GIT_UNREACHABLE_PATTERNS: ReadonlyArray<RegExp> = [
  /could not resolve host/i,
  /nodename nor servname/i,
  /name or service not known/i,
  /temporary failure in name resolution/i,
  /connection refused/i,
  /connection timed out/i,
  /operation timed out/i,
  /connection reset/i,
  /connection closed by/i,
  /network is unreachable/i,
  /no route to host/i,
  /failed to connect to/i,
  /ssh: connect to host/i,
  /kex_exchange_identification/i,
  /permission denied \(/i,
  /authentication failed/i,
  /access denied/i,
  /could not read (?:username|password)/i,
  /terminal prompts disabled/i,
  /repository not found/i,
  /repository '[^']*' not found/i,
  /does not appear to be a git repository/i,
  /the requested url returned error/i,
  /unable to access/i,
  /ssl certificate problem/i,
  /could not read from remote repository/i,
];

const FAILURE_SUMMARY_MAX_CHARS = 500;

/**
 * The one line of git's stderr that says why it failed: the ssh host-key or network reason
 * first, then the first `fatal:`/`error:` line, then the last line; never a progress redraw.
 * Credential-redacted and bounded for messages.
 */
export function gitFailureSummary(stderr: string): string {
  const lines = stderr
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !isGitCloneProgressLine(line));
  const reason =
    lines.find((line) => GIT_HOST_KEY_FAILURE.test(line)) ??
    lines.find((line) => GIT_UNREACHABLE_PATTERNS.some((pattern) => pattern.test(line))) ??
    lines.find((line) => /^(?:fatal|error):/i.test(line)) ??
    lines.at(-1) ??
    "";
  const redacted = redactGitCredentials(reason).trim();
  return redacted.length <= FAILURE_SUMMARY_MAX_CHARS
    ? redacted
    : `…${redacted.slice(-(FAILURE_SUMMARY_MAX_CHARS - 1)).trimStart()}`;
}
