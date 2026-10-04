import {
  deriveThreadActivityStatus,
  type SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";

/**
 * Activity that a desktop relaunch would kill.
 *
 * Relaunching stops the local backend, which ends every provider turn it owns,
 * including ones blocked on an approval or a question and subagent work still
 * running in the background. Watch loops ("monitoring") are excluded: they
 * never finish on their own, so waiting for them would wait forever.
 */
const INTERRUPTIBLE = new Set(["working", "approval", "input", "connecting"]);

/**
 * Turns on this desktop's own backend that a relaunch would stop, or `null`
 * while the local environment is not known yet and they cannot be counted.
 */
export function countActiveDesktopTurns(
  threads: ReadonlyArray<SidebarThreadSummary>,
  localEnvironmentId: EnvironmentId | null,
): number | null {
  if (localEnvironmentId === null) return null;
  let count = 0;
  for (const thread of threads) {
    if (thread.environmentId !== localEnvironmentId || thread.archivedAt !== null) continue;
    if (INTERRUPTIBLE.has(deriveThreadActivityStatus(thread))) count += 1;
  }
  return count;
}

export function describeActiveDesktopTurns(count: number | null): string {
  if (count === null) return "Agent turns may still be running";
  return count === 1 ? "1 agent turn is still running" : `${count} agent turns are still running`;
}
