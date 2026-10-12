import type { TerminalCursor, TerminalEvent, TerminalSessionSnapshot } from "@ryco/contracts";

export function isTerminalEventAfterSnapshot(
  event: TerminalEvent,
  snapshot: Pick<TerminalSessionSnapshot, "updatedAt" | "cursor">,
): boolean {
  if (snapshot.cursor && event.cursor) {
    return (
      event.cursor.generation === snapshot.cursor.generation &&
      event.cursor.sequence > snapshot.cursor.sequence
    );
  }
  // Older servers cannot disambiguate events in the same millisecond.
  return event.createdAt > snapshot.updatedAt;
}

/**
 * Whether a `terminal.open` answer is a delta for a surface that asked with `sinceCursor`: its
 * `history` then holds only the output after that cursor and is appended, not written over the
 * scrollback. Any other answer (an older server, a reset or trimmed history) is a full snapshot.
 */
export function isTerminalSnapshotDeltaFor(
  snapshot: Pick<TerminalSessionSnapshot, "historySince">,
  sinceCursor: TerminalCursor | undefined,
): boolean {
  return (
    sinceCursor !== undefined &&
    snapshot.historySince?.generation === sinceCursor.generation &&
    snapshot.historySince.sequence === sinceCursor.sequence
  );
}

export interface TerminalReconciliationState {
  readonly cursor?: TerminalCursor | undefined;
  readonly activityCursor?: TerminalCursor | undefined;
  readonly lifecycleSequence?: number | undefined;
  readonly snapshotExitPending?: boolean | undefined;
}

export function terminalReconciliationFromSnapshot(
  snapshot: TerminalSessionSnapshot,
): TerminalReconciliationState {
  return {
    cursor: snapshot.cursor,
    lifecycleSequence: snapshot.cursor?.sequence,
    snapshotExitPending: snapshot.status === "exited",
  };
}

export type TerminalReplayEvent = Extract<TerminalEvent, { type: "started" }> & {
  readonly replay: true;
};

/**
 * Subscription catch-up for an already-running session. It carries no history, so it may
 * advance metadata but must never replace a surface's scrollback or open/focus a terminal.
 */
export function isTerminalReplayEvent(event: TerminalEvent): event is TerminalReplayEvent {
  return event.type === "started" && event.replay === true;
}

/** Highest cursor a surface has accounted for, output or activity alike, in one generation. */
function latestAccountedSequence(
  current: TerminalReconciliationState,
  generation: string,
): number | null {
  if (current.cursor?.generation !== generation) return null;
  const activity =
    current.activityCursor?.generation === generation ? current.activityCursor.sequence : -1;
  return Math.max(current.cursor.sequence, activity);
}

/** Shared by store projections and terminal surfaces. Activity never consumes output bytes. */
export function reconcileTerminalEvent(
  current: TerminalReconciliationState,
  event: TerminalEvent,
): TerminalReconciliationState | null {
  if (isTerminalReplayEvent(event)) {
    // Accepted only when it proves the surface missed something (a later cursor or a new
    // server generation); a surface that saw everything keeps its state and scrollback.
    const next = event.snapshot.cursor;
    const accounted = next ? latestAccountedSequence(current, next.generation) : null;
    if (next && accounted !== null && next.sequence <= accounted) return null;
    return terminalReconciliationFromSnapshot(event.snapshot);
  }
  if (event.type === "started" || event.type === "restarted") {
    const next = event.snapshot.cursor;
    if (
      current.cursor &&
      next?.generation === current.cursor.generation &&
      next.sequence < current.cursor.sequence
    )
      return null;
    return terminalReconciliationFromSnapshot(event.snapshot);
  }
  const next = event.cursor;
  if (current.cursor && next && next.generation !== current.cursor.generation) return null;
  if (event.type === "activity") {
    if (
      next &&
      (next.sequence <= (current.lifecycleSequence ?? -1) ||
        (next.generation === current.activityCursor?.generation &&
          next.sequence <= current.activityCursor.sequence))
    )
      return null;
    return { ...current, activityCursor: next ?? current.activityCursor };
  }
  if (
    event.type === "exited" &&
    next &&
    next.generation === current.activityCursor?.generation &&
    next.sequence < current.activityCursor.sequence
  )
    return null;
  if (current.cursor && next) {
    const snapshotExit =
      event.type === "exited" &&
      current.snapshotExitPending &&
      next.sequence === current.cursor.sequence;
    if (next.sequence <= current.cursor.sequence && !snapshotExit) return null;
  }
  return {
    ...current,
    cursor: next ?? current.cursor,
    snapshotExitPending: false,
    lifecycleSequence:
      event.type === "cleared" || event.type === "exited" || event.type === "error"
        ? (next?.sequence ?? current.lifecycleSequence)
        : current.lifecycleSequence,
  };
}

/** One instance per surface; the shared store applies the same pure transition. */
export function createTerminalEventReconciler() {
  let state: TerminalReconciliationState = {};
  return {
    reset(snapshot: TerminalSessionSnapshot) {
      state = terminalReconciliationFromSnapshot(snapshot);
    },
    accept(event: TerminalEvent): boolean {
      const next = reconcileTerminalEvent(state, event);
      if (!next) return false;
      state = next;
      return true;
    },
  };
}
