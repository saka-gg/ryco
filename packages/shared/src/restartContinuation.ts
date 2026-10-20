/**
 * Restart-recovery facts shared by the server (startup reconciliation and restart
 * continuation) and the clients (the follow-up queue hold and thread presentation), so
 * both recognise a session that a server restart released.
 *
 * @module restartContinuation
 */

/** The `lastError` startup reconciliation writes on a session that did not survive a restart. */
export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";

/**
 * Activity kinds start with this when a node tells a thread what became of the work a
 * restart interrupted (its continuation was skipped or failed).
 */
export const RESTART_CONTINUATION_NOTICE_KIND_PREFIX = "restart.continuation-";

/** The session fields a restart release is recognised by. */
export interface RestartReleaseSessionState {
  readonly status: string;
  readonly lastError?: string | null | undefined;
}

/**
 * A server restart released this session: startup reconciliation found it starting or
 * running with no live runtime and ended it with the restart marker. Its work was
 * interrupted, not failed, so clients never present it as a thread error.
 */
export function isRestartReleasedSession(
  session: RestartReleaseSessionState | null | undefined,
): boolean {
  return session?.status === "error" && session.lastError === ORPHANED_PROVIDER_SESSION_ERROR;
}

/** The activity is a node's notice about restart continuation (`restart.continuation-*`). */
export function isRestartContinuationNotice(activity: { readonly kind: string }): boolean {
  return activity.kind.startsWith(RESTART_CONTINUATION_NOTICE_KIND_PREFIX);
}
