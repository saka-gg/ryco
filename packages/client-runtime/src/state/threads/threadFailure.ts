import { sanitizeThreadErrorMessage } from "../../errors/transportError.ts";
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

/**
 * What Continue sends after a failed turn: a plain user message, so it goes through the
 * normal send path (queue holds, mutation readiness, model selection).
 */
export const CONTINUE_AFTER_FAILURE_PROMPT =
  "Continue the task. First check what the last turn already finished, so nothing is done twice.";

export interface FailedTurnNoticeThread {
  readonly session: RestartReleaseSessionState | null | undefined;
  readonly latestTurn: { readonly turnId: string; readonly state: string } | null | undefined;
  /** A usage limit has its own notice and resume. */
  readonly usageLimit?: unknown;
}

export interface FailedTurnNotice {
  /** The failed turn; a later turn ends the notice, and a dismissal is kept per turn. */
  readonly turnId: string;
  readonly title: string;
  /** The provider's error, sanitized like the thread error; null when it gave none. */
  readonly detail: string | null;
}

/**
 * The notice a thread keeps under its composer while its latest turn has failed and nothing
 * runs: what failed, with Continue and Change model. Derived from the thread, so it survives a
 * reload and shows on every device. Null for a usage limit (its own notice) and for a restart
 * release (an interruption, see `restartInterruptionNotice`).
 */
export function failedTurnNotice(thread: FailedTurnNoticeThread): FailedTurnNotice | null {
  const turn = thread.latestTurn;
  if (!turn || turn.state !== "error") return null;
  if (thread.usageLimit) return null;
  // A new turn is on its way (the client's "connecting" is the server's "starting").
  const status = thread.session?.status;
  if (status === "running" || status === "starting" || status === "connecting") return null;
  if (isRestartReleasedSession(thread.session)) return null;
  return {
    turnId: turn.turnId,
    title: "The last turn failed",
    detail: sanitizeThreadErrorMessage(sessionFailureDetail(thread.session)),
  };
}
