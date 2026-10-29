import {
  collectInterruptibleTurnsByEnvironment,
  type SidebarThreadOrStub,
} from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";

export {
  collectInterruptibleTurnsByEnvironment,
  interruptibleThreadStatus,
  type EnvironmentTurnActivity,
  type InterruptibleThreadStatus,
} from "@ryco/client-runtime/state/threads";

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
