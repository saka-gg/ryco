/**
 * The single source of what startup reconciliation treats as an orphaned provider
 * session and what it writes there. Restart continuation derives its candidates and
 * its decider fence from the same values, so the two can never drift apart.
 *
 * @module restartReconciliation
 */
import type { OrchestrationThread, ThreadId } from "@ryco/contracts";

export { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";

/** Latest-turn state that startup reconciliation leaves on an orphaned in-flight turn. */
export const ORPHANED_TURN_TERMINAL_STATE = "interrupted" as const;

/**
 * A projected session that claims to run (or names an active turn) whose provider
 * runtime is not live in this process.
 */
export function isOrphanedProviderSession(
  thread: Pick<OrchestrationThread, "id" | "session">,
  liveThreadIds: ReadonlySet<ThreadId>,
): boolean {
  const session = thread.session;
  return (
    session !== null &&
    (session.status === "starting" ||
      session.status === "running" ||
      session.activeTurnId !== null) &&
    !liveThreadIds.has(thread.id)
  );
}
