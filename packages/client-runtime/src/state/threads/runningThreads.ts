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

/**
 * The scoped keys of threads with a turn in progress (a `starting` or `running` session, or a
 * running latest turn) in every environment the store holds, most recently updated first, at
 * most `limit`. Archived stubs are skipped. Consecutive calls with the same running set return
 * equal arrays, so a subscriber compares them element by element.
 */
export function listRunningThreadKeys(state: AppState, limit: number): string[] {
  const running: Array<{ readonly key: string; readonly updatedAt: string }> = [];
  for (const [environmentId, environmentState] of Object.entries(state.environmentStateById) as [
    EnvironmentId,
    EnvironmentState,
  ][]) {
    for (const threadId of Object.keys(environmentState.threadShellById) as ThreadId[]) {
      const shell = environmentState.threadShellById[threadId];
      if (shell === undefined || isArchivedThreadStub(shell)) continue;
      const session = ownEntry(environmentState.threadSessionById, threadId);
      const turnRunning =
        ownEntry(environmentState.threadTurnStateById, threadId)?.latestTurn?.state === "running";
      if (!turnRunning && !isWorkingSessionStatus(session?.orchestrationStatus)) continue;
      running.push({
        key: scopedThreadKey(scopeThreadRef(environmentId, threadId)),
        updatedAt: session?.updatedAt ?? "",
      });
    }
  }
  return running
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key),
    )
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.key);
}
