/**
 * Pure turn-finalization helpers shared by the server reducers (in-memory projector and
 * SQL projection pipeline) and the client thread store, so all three apply the same
 * explicit release and checkpoint rules.
 *
 * Rules:
 * - A turn ends when a `thread.session-set` carries `releasedTurn` for it. The release
 *   overrides `running`/`pending` and an inferred `completed`.
 * - `interrupted` and `error` are sticky: a later release never changes them.
 * - A checkpoint only decides the state of a turn entry it creates
 *   (`checkpointStatusToTurnState`); it never changes an existing turn's state.
 *
 * @module turnFinalization
 */

export type TerminalTurnState = "completed" | "error" | "interrupted";

/** The later of two ISO timestamps (null-tolerant). Ties and unparsable `next` keep `current`. */
export function laterIsoTimestamp(current: string | null, next: string): string {
  if (current === null) return next;
  const currentMs = Date.parse(current);
  const nextMs = Date.parse(next);
  if (!Number.isFinite(currentMs)) return next;
  if (!Number.isFinite(nextMs)) return current;
  return nextMs > currentMs ? next : current;
}

/** The latest of `first` and every non-null `others` timestamp. */
export function latestIsoTimestamp(
  first: string,
  ...others: ReadonlyArray<string | null | undefined>
): string {
  let latest = first;
  for (const value of others) {
    if (value !== null && value !== undefined) {
      latest = laterIsoTimestamp(latest, value);
    }
  }
  return latest;
}

/** `interrupted` and `error` are final: no release or checkpoint may change them. */
export function isStickyTurnState(state: string): state is "interrupted" | "error" {
  return state === "interrupted" || state === "error";
}

/**
 * Single mapping from a checkpoint status to the state of a turn entry the checkpoint
 * creates. Only used when no entry for that turn exists yet.
 */
export function checkpointStatusToTurnState(
  status: "ready" | "missing" | "error",
): TerminalTurnState {
  if (status === "error") return "error";
  if (status === "missing") return "interrupted";
  return "completed";
}

export interface ReleasableTurn {
  readonly state: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface ReleasedTurnOutcome {
  readonly state: TerminalTurnState;
  readonly completedAt: string;
}

/**
 * Apply an explicit release to an existing turn entry.
 *
 * - `interrupted`/`error` are sticky: the state and `completedAt` are kept (`completedAt`
 *   is filled when it is still null).
 * - `running`/`pending`/`completed` take the released state, and `completedAt` becomes the
 *   latest of the current `completedAt`, the released `completedAt` and `startedAt`, so a
 *   turn never completes before it started.
 */
export function mergeReleasedTurn(
  current: ReleasableTurn,
  released: ReleasedTurnOutcome,
): { readonly state: TerminalTurnState; readonly completedAt: string } {
  const releasedAt = latestIsoTimestamp(released.completedAt, current.startedAt);
  if (isStickyTurnState(current.state)) {
    return {
      state: current.state,
      completedAt: current.completedAt ?? releasedAt,
    };
  }
  return {
    state: released.state,
    completedAt: latestIsoTimestamp(releasedAt, current.completedAt),
  };
}
