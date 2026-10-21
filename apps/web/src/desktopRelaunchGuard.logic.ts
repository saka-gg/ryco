import {
  deriveThreadActivityStatus,
  isUnarchivedThreadEntry,
  type SidebarThreadOrStub,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProviderInstanceId } from "@ryco/contracts";

/**
 * Activity that a desktop relaunch would kill.
 *
 * Relaunching stops the local backend, which ends every provider turn it owns,
 * including ones blocked on an approval or a question and subagent work still
 * running in the background. Watch loops ("monitoring") are excluded: they
 * never finish on their own, so waiting for them would wait forever.
 */
const INTERRUPTIBLE = new Set(["working", "approval", "input", "connecting"]);

/** Work on one environment that restarting its node (or updating a provider) would stop. */
export interface EnvironmentTurnActivity {
  /** Unarchived threads with an interruptible turn. */
  readonly runningChatCount: number;
  /** Provider instances those threads run on, each once, in first-seen order. */
  readonly busyProviderInstanceIds: ReadonlyArray<ProviderInstanceId>;
}

/**
 * Interruptible turns per environment, from the rows the store holds. Only
 * environments with such a turn are listed. Callers decide whether an
 * environment's rows can be trusted: rows hydrated from the cache, or held
 * over a reconnect, show nothing running whatever the node is doing.
 */
export function collectInterruptibleTurnsByEnvironment(
  /** Archived threads (stubs among them) never count. */
  threads: ReadonlyArray<SidebarThreadOrStub>,
): ReadonlyMap<EnvironmentId, EnvironmentTurnActivity> {
  const counts = new Map<EnvironmentId, { count: number; busy: Set<ProviderInstanceId> }>();
  for (const thread of threads) {
    if (!isUnarchivedThreadEntry(thread)) continue;
    if (!INTERRUPTIBLE.has(deriveThreadActivityStatus(thread))) continue;
    let entry = counts.get(thread.environmentId);
    if (entry === undefined) {
      entry = { count: 0, busy: new Set() };
      counts.set(thread.environmentId, entry);
    }
    entry.count += 1;
    const instanceId = thread.modelSelection?.instanceId;
    if (instanceId !== undefined) entry.busy.add(instanceId);
  }
  const activity = new Map<EnvironmentId, EnvironmentTurnActivity>();
  for (const [environmentId, entry] of counts) {
    activity.set(environmentId, {
      runningChatCount: entry.count,
      busyProviderInstanceIds: [...entry.busy],
    });
  }
  return activity;
}

/**
 * Turns on this desktop's own backend that a relaunch would stop, or `null`
 * while they cannot be counted: the local environment is not known yet, or
 * has no live snapshot. Rows hydrated from the cache, or held over a
 * reconnect, show nothing running whatever the backend is doing.
 */
export function countActiveDesktopTurns(
  /** Archived threads (stubs among them) never count. */
  threads: ReadonlyArray<SidebarThreadOrStub>,
  localEnvironmentId: EnvironmentId | null,
  localEnvironmentLive: boolean,
): number | null {
  if (localEnvironmentId === null || !localEnvironmentLive) return null;
  return (
    collectInterruptibleTurnsByEnvironment(threads).get(localEnvironmentId)?.runningChatCount ?? 0
  );
}

export function describeActiveDesktopTurns(count: number | null): string {
  if (count === null) return "Agent turns may still be running";
  return count === 1 ? "1 agent turn is still running" : `${count} agent turns are still running`;
}
