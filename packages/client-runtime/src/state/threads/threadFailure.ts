import {
  isRestartContinuationNotice,
  isRestartReleasedSession,
  type RestartReleaseSessionState,
} from "@ryco/shared/restartContinuation";

/** The quiet line a thread shows when a server restart interrupted it. */
export const RESTART_INTERRUPTION_NOTICE =
  "Interrupted by a server restart. Send a message to continue.";

export interface ThreadFailureState {
  readonly session: RestartReleaseSessionState | null | undefined;
  readonly latestTurn: { readonly state: string } | null | undefined;
}

/**
 * The thread failed: its session or its latest turn ended in an error. A session a
 * server restart released is interrupted, not failed (`isRestartReleasedSession`).
 */
export function isThreadFailed(thread: ThreadFailureState): boolean {
  return (
    (thread.session?.status === "error" && !isRestartReleasedSession(thread.session)) ||
    thread.latestTurn?.state === "error"
  );
}

/**
 * The provider error a session reports, or null. The marker a restart release carries
 * is not one, so a restart never shows as a thread error.
 */
export function sessionFailureDetail(
  session: RestartReleaseSessionState | null | undefined,
): string | null {
  if (!session || isRestartReleasedSession(session)) return null;
  return session.lastError ?? null;
}

export interface RestartInterruptionThread {
  readonly session: RestartReleaseSessionState | null | undefined;
  readonly latestTurn: { readonly turnId: string } | null | undefined;
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly turnId: string | null }>;
}

/**
 * The line a thread shows for a restart release, or null. A node that explains the
 * interruption itself appends a continuation notice to the interrupted turn; the line
 * stands in only where that notice is missing (older nodes, or a session released
 * before its turn started).
 */
export function restartInterruptionNotice(thread: RestartInterruptionThread): string | null {
  if (!isRestartReleasedSession(thread.session)) return null;
  const turnId = thread.latestTurn?.turnId ?? null;
  const explained =
    turnId !== null &&
    thread.activities.some(
      (activity) => activity.turnId === turnId && isRestartContinuationNotice(activity),
    );
  return explained ? null : RESTART_INTERRUPTION_NOTICE;
}
