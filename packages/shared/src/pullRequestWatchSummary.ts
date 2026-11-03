/**
 * The parts of a pull request watch the server's boot path and every client
 * need: the summary a thread shell carries, and the bookkeeping of ended
 * watches. Kept apart from `@ryco/shared/pullRequestWatch` (the decision
 * rules, renderers and read planning) and importing nothing from it, so the
 * projector and the shell builders never pull the decision module into the
 * server's boot chunk or a client's startup graph.
 */
import type {
  PullRequestWatchEndReason,
  ThreadPullRequestWatch,
  ThreadPullRequestWatchEnded,
  ThreadPullRequestWatches,
  ThreadPullRequestWatchShell,
  ThreadPullRequestWatchSummary,
} from "@ryco/contracts";

/** Fix turns in a row without a green run before Auto-fix CI pauses (Synara `PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS`). */
export const PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS = 3;
/** Ended watches a thread keeps, newest first, so clients can say why watching stopped. */
export const PULL_REQUEST_WATCH_ENDED_KEPT = 4;
/** Thread shells leave ended watches out after a day; the thread's full state keeps them. */
export const PULL_REQUEST_WATCH_ENDED_SHELL_MS = 24 * 60 * 60_000;
/** Pull requests one thread may watch at once (a stack's layers). */
export const PULL_REQUEST_WATCHES_PER_THREAD = 8;
/** Updates of one watch refused in a row before it ends (= completion returns' `MAX_DELIVERY_ATTEMPTS`). */
export const PULL_REQUEST_WATCH_MAX_REJECTED_UPDATES = 5;

export const EMPTY_PULL_REQUEST_WATCHES: ThreadPullRequestWatches = { active: [], ended: [] };

export function summarizePullRequestWatch(
  watch: ThreadPullRequestWatch,
): ThreadPullRequestWatchSummary {
  return {
    watchId: watch.watchId,
    number: watch.number,
    url: watch.url,
    worktreeId: watch.worktreeId,
    startedAt: watch.startedAt,
    startedBy: watch.startedBy,
    news: watch.news,
    autoFix:
      watch.autoFix === null
        ? null
        : {
            status: watch.autoFix.status,
            pauseReason: watch.autoFix.pauseReason,
            attempts: watch.autoFix.attempts,
            maxAttempts: PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
          },
    headSha: watch.headSha,
    failingChecks: watch.failingChecks,
    passed: watch.passed,
    conflicting: watch.conflicting,
    delivering: watch.delivery !== null,
    lastChangeAt: watch.lastChangeAt,
  };
}

/** The shell form of a thread's watches; computed once when the state changes (the projector stores it). */
export function summarizePullRequestWatches(
  watches: ThreadPullRequestWatches,
): ThreadPullRequestWatchShell {
  return {
    active: watches.active.map(summarizePullRequestWatch),
    ended: watches.ended,
  };
}

/**
 * What a thread shell shows at `nowMs`: ended watches older than a day are
 * left out, and null (no shell key) when nothing is left, so shells of
 * threads that never watched, or stopped long ago, do not grow.
 */
export function pullRequestWatchShellAt(
  shell: ThreadPullRequestWatchShell | null | undefined,
  nowMs: number,
): ThreadPullRequestWatchShell | null {
  if (!shell) return null;
  const ended = shell.ended.filter((entry) => {
    const endedAtMs = Date.parse(entry.endedAt);
    return Number.isFinite(endedAtMs) && nowMs - endedAtMs < PULL_REQUEST_WATCH_ENDED_SHELL_MS;
  });
  if (shell.active.length === 0 && ended.length === 0) return null;
  return ended.length === shell.ended.length ? shell : { active: shell.active, ended };
}

/**
 * End the active watches `watchIds` names (every one when it is omitted) for
 * `reason`. Ended entries go first, the list keeps the newest few. Returns
 * `watches` itself when nothing was active, so callers can skip a no-op event.
 */
export function endPullRequestWatches(
  watches: ThreadPullRequestWatches,
  input: {
    readonly watchIds?: ReadonlySet<string>;
    readonly reason: PullRequestWatchEndReason;
    readonly endedAt: string;
  },
): ThreadPullRequestWatches {
  const ending = watches.active.filter(
    (watch) => input.watchIds === undefined || input.watchIds.has(watch.watchId),
  );
  if (ending.length === 0) return watches;
  const endedEntries: ReadonlyArray<ThreadPullRequestWatchEnded> = ending.map((watch) => ({
    watchId: watch.watchId,
    number: watch.number,
    reason: input.reason,
    endedAt: input.endedAt,
  }));
  return {
    active: watches.active.filter((watch) => !ending.includes(watch)),
    ended: [...endedEntries, ...watches.ended].slice(0, PULL_REQUEST_WATCH_ENDED_KEPT),
  };
}

/**
 * Put `next` in place of the active watch with its id, or add it at the end. Watching a pull
 * request again drops its ended entries: why it stopped no longer applies.
 */
export function upsertPullRequestWatch(
  watches: ThreadPullRequestWatches,
  next: ThreadPullRequestWatch,
): ThreadPullRequestWatches {
  const index = watches.active.findIndex((watch) => watch.watchId === next.watchId);
  if (index !== -1) {
    return {
      active: watches.active.map((watch, position) => (position === index ? next : watch)),
      ended: watches.ended,
    };
  }
  return {
    active: [...watches.active, next],
    ended: watches.ended.filter((entry) => entry.watchId !== next.watchId),
  };
}
