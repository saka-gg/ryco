import type {
  EnvironmentId,
  ThreadId,
  ThreadPullRequestWatchShell,
  ThreadPullRequestWatchSummary,
} from "@ryco/contracts";

/**
 * Watched pull requests whose checks just passed, read from accepted thread
 * shells. The server's watch reads the pull request with no client open; its
 * summary's `passed` turning true is the client's "checks passed" notice for
 * a watched pull request (an unwatched one keeps the client's own notice).
 */

/**
 * Watches in `next` whose pass gate passed since `previous`: the same watch
 * (id and start) that had not passed, or had passed on another head. A watch
 * seen for the first time never counts, so loading a thread or starting a
 * watch on green checks stays quiet.
 */
export function pullRequestWatchPasses(
  previous: ThreadPullRequestWatchShell | null | undefined,
  next: ThreadPullRequestWatchShell | null | undefined,
): ReadonlyArray<ThreadPullRequestWatchSummary> {
  if (!previous || !next) return [];
  return next.active.filter((watch) => {
    if (!watch.passed || watch.headSha === null) return false;
    const before = previous.active.find(
      (entry) => entry.watchId === watch.watchId && entry.startedAt === watch.startedAt,
    );
    return before !== undefined && (!before.passed || before.headSha !== watch.headSha);
  });
}

export interface PullRequestWatchPass {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly watch: ThreadPullRequestWatchSummary;
}

/** Passes remembered so a pull request several threads watch is reported once per head. */
const REPORTED_PASSES_KEPT = 256;

/**
 * Remembers the last accepted watches of each watching thread per environment
 * and reports the passes between them. `baseline` takes what the store holds
 * after a snapshot or a new connection, silently; `observe` takes one accepted
 * thread shell and returns its new passes, each pull request and head once.
 * Threads without watches are not kept: a missing entry reads as no watches.
 */
export function createPullRequestWatchPassTracker() {
  const environments = new Map<EnvironmentId, Map<ThreadId, ThreadPullRequestWatchShell>>();
  const reported = new Set<string>();
  const remember = (key: string) => {
    reported.add(key);
    if (reported.size <= REPORTED_PASSES_KEPT) return;
    const oldest = reported.values().next();
    if (!oldest.done) reported.delete(oldest.value);
  };
  return {
    baseline(
      environmentId: EnvironmentId,
      threads: Iterable<{
        readonly id: ThreadId;
        readonly pullRequestWatches?: ThreadPullRequestWatchShell | undefined;
      }>,
    ): void {
      const watches = new Map<ThreadId, ThreadPullRequestWatchShell>();
      for (const thread of threads) {
        if (thread.pullRequestWatches) watches.set(thread.id, thread.pullRequestWatches);
      }
      environments.set(environmentId, watches);
    },
    observe(
      environmentId: EnvironmentId,
      threadId: ThreadId,
      next: ThreadPullRequestWatchShell | undefined,
    ): ReadonlyArray<PullRequestWatchPass> {
      const watches = environments.get(environmentId);
      // Not baselined yet: nothing to compare with.
      if (watches === undefined) return [];
      const previous = watches.get(threadId);
      if (next) watches.set(threadId, next);
      else watches.delete(threadId);
      const passes: PullRequestWatchPass[] = [];
      for (const watch of pullRequestWatchPasses(previous, next)) {
        const key = JSON.stringify([environmentId, watch.watchId, watch.headSha]);
        if (reported.has(key)) continue;
        remember(key);
        passes.push({ environmentId, threadId, watch });
      }
      return passes;
    },
    remove(environmentId: EnvironmentId, threadId: ThreadId): void {
      environments.get(environmentId)?.delete(threadId);
    },
    clear(environmentId: EnvironmentId): void {
      environments.delete(environmentId);
    },
    reset(): void {
      environments.clear();
      reported.clear();
    },
  };
}

export type PullRequestWatchPassTracker = ReturnType<typeof createPullRequestWatchPassTracker>;
