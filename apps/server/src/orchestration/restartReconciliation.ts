/**
 * The single source of what startup reconciliation treats as an orphaned provider
 * session and what it writes there. Restart continuation derives its candidates and
 * its decider fence from the same values, so the two can never drift apart.
 *
 * @module restartReconciliation
 */
import type {
  CommandId,
  OrchestrationCommand,
  OrchestrationSession,
  OrchestrationThread,
  ThreadId,
} from "@ryco/contracts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { latestIsoTimestamp } from "@ryco/shared/turnFinalization";

import { TURN_FINALIZATION_REASON } from "./turnFinalization.ts";

export { ORPHANED_PROVIDER_SESSION_ERROR };

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

/**
 * When work on a thread was last observed: its newest session, thread or latest-turn
 * timestamp. Startup repairs date the turns they settle here and never at boot, so a
 * restart does not count as fresh activity (the auto-settle clock keeps running).
 */
export function lastObservedWorkAt(
  thread: Pick<OrchestrationThread, "updatedAt" | "latestTurn">,
  session: Pick<OrchestrationSession, "updatedAt">,
): string {
  return latestIsoTimestamp(
    session.updatedAt,
    thread.updatedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  );
}

/**
 * The one session-set that releases an orphaned session and settles its turn atomically
 * (without an active turn id the decider still settles a running latest turn). The
 * session keeps the restart marker as its error, which clients key their restart handling
 * on. Session and turn end when work was last observed, the latest the runtime is known
 * to have lived, and the release does not wake a snoozed thread.
 */
export function orphanedSessionRelease(input: {
  readonly thread: Pick<OrchestrationThread, "id" | "updatedAt" | "latestTurn">;
  readonly session: OrchestrationSession;
  readonly commandId: CommandId;
  readonly reconciledAt: string;
}): Extract<OrchestrationCommand, { type: "thread.session.set" }> {
  const { thread, session } = input;
  const endedAt = lastObservedWorkAt(thread, session);
  return {
    type: "thread.session.set",
    commandId: input.commandId,
    threadId: thread.id,
    session: {
      ...session,
      status: "error",
      activeTurnId: null,
      lastError: ORPHANED_PROVIDER_SESSION_ERROR,
      updatedAt: endedAt,
    },
    turnOutcome: {
      ...(session.activeTurnId !== null ? { turnId: session.activeTurnId } : {}),
      state: ORPHANED_TURN_TERMINAL_STATE,
      reason: TURN_FINALIZATION_REASON.startupOrphanedSession,
      completedAt: endedAt,
    },
    wakesSnoozed: false,
    createdAt: input.reconciledAt,
  };
}
