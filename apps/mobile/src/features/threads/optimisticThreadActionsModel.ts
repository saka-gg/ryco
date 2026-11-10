// The thread screen's own actions show their outcome the moment they are
// tapped and wait for the node behind it: a rename shows the new title, Stop
// shows the turn as stopping. Each is a local overlay that the node's echo
// ends (the title or the turn changes) and a failure takes back.

/** A rename on its way: the title it replaces, so any change from the node ends it. */
export interface PendingRename {
  readonly from: string;
  readonly to: string;
}

/** The title to show: the new one until the node's title moves off the one it replaced. */
export function displayedThreadTitle(
  serverTitle: string | null | undefined,
  pending: PendingRename | null,
): string | null {
  if (serverTitle === null || serverTitle === undefined) return pending?.to ?? null;
  return pending !== null && serverTitle === pending.from ? pending.to : serverTitle;
}

/** A Stop on its way, for the turn it stops (null: the session ran without a known turn). */
export interface PendingStop {
  readonly turnId: string | null;
}

/**
 * Whether the screen shows the turn as stopping: a Stop was tapped for the turn that still runs.
 * A new turn, or the turn's end, is the node's answer and ends it.
 */
export function threadStopping(input: {
  readonly pending: PendingStop | null;
  readonly running: boolean;
  readonly activeTurnId: string | null;
}): boolean {
  if (input.pending === null || !input.running) return false;
  // Only the turn it was for: a Stop never carries over to a turn that started after it.
  return input.pending.turnId === input.activeTurnId;
}
