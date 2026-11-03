/**
 * turnRunning - When a thread still runs a turn for a sender queued behind it.
 *
 * The web and mobile follow-up queue and `ryco thread send` start the next turn only once
 * the thread's current turn is over, by the same rule.
 *
 * @module turnRunning
 */
export interface TurnRunningSession {
  readonly status: string;
  readonly activeTurnId?: string | null | undefined;
  readonly updatedAt: string;
}

export interface TurnRunningLatestTurn {
  readonly state: string;
  readonly requestedAt: string;
  readonly startedAt: string | null;
}

/**
 * Whether a thread still runs a turn for anyone that sends behind it: the follow-up queue
 * and `ryco thread send` start the next turn only once this is false. A starting session
 * counts, since a second turn start accepted then is orphaned by the reactor.
 *
 * A turn row can stay `running` after its session has settled (`ready` or `error` with no
 * active turn): non-git tool-only turns, a failed checkpoint capture and ACP prompt failures
 * leave it unfinalized. Waiting on such a turn would strand the sender. The session counts as
 * having released the turn only when it was updated after the turn started; an older session
 * update is stale ordering, not a release.
 */
export function isThreadTurnRunning(
  session: TurnRunningSession | null,
  latestTurn: TurnRunningLatestTurn | null,
): boolean {
  if (session?.status === "running" || session?.status === "starting" || session?.activeTurnId) {
    return true;
  }
  if (latestTurn?.state !== "running") return false;
  if (session === null) return true;
  const released =
    Date.parse(session.updatedAt) > Date.parse(latestTurn.startedAt ?? latestTurn.requestedAt);
  return !released;
}
