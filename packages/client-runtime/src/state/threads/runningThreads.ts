/**
 * Threads with a turn in progress across every environment the store holds, for the desktop
 * keep-alive (apps/web RunningThreadKeepAlive). Its own module, off the first download: the
 * residency module it reads is on it.
 *
 * @module runningThreads
 */
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import type { AppState, EnvironmentState } from "./store.ts";
import { isWorkingSessionStatus } from "./threadBodyResidency.ts";
import { isArchivedThreadStub } from "./types.ts";

function ownEntry<K extends string, V>(record: Readonly<Record<K, V>>, key: K): V | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

interface RunningThreadEntry {
  readonly key: string;
  readonly updatedAt: string;
}

/**
 * One environment's running threads, cached on the identity of the three maps they come from: the
 * store keeps a map's object when nothing in it changed, so streamed messages, which touch none of
 * them, reuse the last answer instead of scanning every thread again.
 */
const runningByShells = new WeakMap<
  object,
  {
    readonly sessions: object;
    readonly turns: object;
    readonly running: ReadonlyArray<RunningThreadEntry>;
  }
>();

function runningThreadsOf(
  environmentId: EnvironmentId,
  environmentState: EnvironmentState,
): ReadonlyArray<RunningThreadEntry> {
  const { threadShellById, threadSessionById, threadTurnStateById } = environmentState;
  const cached = runningByShells.get(threadShellById);
  if (
    cached !== undefined &&
    cached.sessions === threadSessionById &&
    cached.turns === threadTurnStateById
  ) {
    return cached.running;
  }
  const running: RunningThreadEntry[] = [];
  for (const threadId of Object.keys(threadShellById) as ThreadId[]) {
    const shell = threadShellById[threadId];
    if (shell === undefined || isArchivedThreadStub(shell)) continue;
    const session = ownEntry(threadSessionById, threadId);
    const turnRunning = ownEntry(threadTurnStateById, threadId)?.latestTurn?.state === "running";
    if (!turnRunning && !isWorkingSessionStatus(session?.orchestrationStatus)) continue;
    running.push({
      key: scopedThreadKey(scopeThreadRef(environmentId, threadId)),
      updatedAt: session?.updatedAt ?? "",
    });
  }
  runningByShells.set(threadShellById, {
    sessions: threadSessionById,
    turns: threadTurnStateById,
    running,
  });
  return running;
}

/**
 * The scoped keys of threads with a turn in progress (a `starting` or `running` session, or a
 * running latest turn) in every environment the store holds, most recently updated first, at
 * most `limit`. Archived stubs are skipped. Consecutive calls with the same running set return
 * equal arrays, so a subscriber compares them element by element.
 */
export function listRunningThreadKeys(state: AppState, limit: number): string[] {
  const running: RunningThreadEntry[] = [];
  for (const [environmentId, environmentState] of Object.entries(state.environmentStateById) as [
    EnvironmentId,
    EnvironmentState,
  ][]) {
    running.push(...runningThreadsOf(environmentId, environmentState));
  }
  return running
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key),
    )
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.key);
}

/**
 * The running threads to keep, at most `limit`: the ones kept before that still run, in their
 * order, then the most recently updated others into the free places. Sticky, so a thread stays
 * kept until it stops instead of dropping out whenever others update: a running thread's
 * subscription is never evicted, so letting one go before it stops would not free anything.
 * Returns `previous` itself when nothing changed.
 */
export function keepRunningThreadKeys(
  previous: ReadonlyArray<string>,
  running: ReadonlyArray<string>,
  limit: number,
): ReadonlyArray<string> {
  const stillRunning = new Set(running);
  const kept = previous.filter((key) => stillRunning.has(key));
  const keptSet = new Set(kept);
  for (const key of running) {
    if (kept.length >= limit) break;
    if (!keptSet.has(key)) kept.push(key);
  }
  return kept.length === previous.length && kept.every((key, index) => key === previous[index])
    ? previous
    : kept;
}
