import { deriveThreadActivityStatus, type ThreadActivityStatus } from "./threadActivityStatus.ts";
import { isUnarchivedThreadEntry, type SidebarThreadOrStub } from "./types.ts";
import type { EnvironmentId, ProviderInstanceId } from "@ryco/contracts";

/**
 * Activity that restarting a node (a desktop relaunch or quit, a node update)
 * would kill.
 *
 * Stopping the local backend ends every provider turn it owns, including ones
 * blocked on an approval or a question and subagent work still running in the
 * background. Watch loops ("monitoring") are excluded: they never finish on
 * their own, so waiting for them would wait forever.
 */
export type InterruptibleThreadStatus = Extract<
  ThreadActivityStatus,
  "working" | "approval" | "input" | "connecting"
>;

const INTERRUPTIBLE: ReadonlySet<ThreadActivityStatus> = new Set<InterruptibleThreadStatus>([
  "working",
  "approval",
  "input",
  "connecting",
]);

function isInterruptible(status: ThreadActivityStatus): status is InterruptibleThreadStatus {
  return INTERRUPTIBLE.has(status);
}

/**
 * What stopping its node would interrupt on this thread, or `null`: archived
 * (stubs among them), idle, monitoring or plan-ready threads have nothing to
 * interrupt. The relaunch and the quit confirmation share this one rule.
 */
export function interruptibleThreadStatus(
  thread: SidebarThreadOrStub,
): InterruptibleThreadStatus | null {
  if (!isUnarchivedThreadEntry(thread)) return null;
  const status = deriveThreadActivityStatus(thread);
  return isInterruptible(status) ? status : null;
}

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
    if (!isUnarchivedThreadEntry(thread) || interruptibleThreadStatus(thread) === null) continue;
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
