/**
 * Restart-recovery facts shared by the server (startup reconciliation and restart
 * continuation) and the clients (the follow-up queue hold), so both recognise a
 * session that a server restart released.
 *
 * @module restartContinuation
 */

/** The `lastError` startup reconciliation writes on a session that did not survive a restart. */
export const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";
