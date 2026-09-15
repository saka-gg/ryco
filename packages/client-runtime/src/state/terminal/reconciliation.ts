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

/** Shared by store projections and terminal surfaces. Activity never consumes output bytes. */
export function reconcileTerminalEvent(
  current: TerminalReconciliationState,
  event: TerminalEvent,
): TerminalReconciliationState | null {
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
