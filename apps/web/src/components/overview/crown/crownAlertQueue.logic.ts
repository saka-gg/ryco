import type { CrownEvent } from "./crownAlerts.logic";
import {
  CROWN_ALERT_DWELL_MS,
  CROWN_ALERT_DWELL_QUEUED_MS,
  CROWN_ALERT_QUEUE_MAX,
  CROWN_ALERT_RECENT_MAX,
} from "./crownLayout";

/**
 * The crown's alert queue, as in the prototype's `Crown.enqueue/next`: one
 * alert shows, up to {@link CROWN_ALERT_QUEUE_MAX} wait (oldest dropped), and
 * the face shows "+N" for the waiting ones. Immutable so React state can hold it.
 */
export interface CrownAlertQueueState {
  readonly current: CrownEvent | null;
  readonly queue: ReadonlyArray<CrownEvent>;
  /** Dedupe keys of the last {@link CROWN_ALERT_RECENT_MAX} accepted alerts, oldest first. */
  readonly recent: ReadonlyArray<string>;
}

export const EMPTY_CROWN_ALERT_QUEUE: CrownAlertQueueState = {
  current: null,
  queue: [],
  recent: [],
};

export function enqueueCrownAlerts(
  state: CrownAlertQueueState,
  events: ReadonlyArray<CrownEvent>,
  options: { readonly cardOpen: boolean },
): CrownAlertQueueState {
  // The open card already shows everything; alerts would only fight it.
  if (options.cardOpen) return state;
  let { current, queue, recent } = state;
  for (const event of events) {
    if (!event.loud || recent.includes(event.dedupeKey)) continue;
    recent = [...recent, event.dedupeKey].slice(-CROWN_ALERT_RECENT_MAX);
    // An idle crown shows the first alert at once; later ones wait behind it.
    if (current === null) current = event;
    else queue = [...queue, event].slice(-CROWN_ALERT_QUEUE_MAX);
  }
  if (recent === state.recent) return state;
  return { current, queue, recent };
}

/** Show the next waiting alert, or none (the crown folds back to its face). */
export function advanceCrownAlert(state: CrownAlertQueueState): CrownAlertQueueState {
  const [current = null, ...queue] = state.queue;
  if (current === null && state.current === null) return state;
  return { current, queue, recent: state.recent };
}

/** Drop the shown and waiting alerts; the dedupe memory stays. */
export function clearCrownAlerts(state: CrownAlertQueueState): CrownAlertQueueState {
  if (state.current === null && state.queue.length === 0) return state;
  return { current: null, queue: [], recent: state.recent };
}

/** How long the current alert stays: shorter while more wait. */
export function crownAlertDwellMs(state: CrownAlertQueueState): number {
  return state.queue.length > 0 ? CROWN_ALERT_DWELL_QUEUED_MS : CROWN_ALERT_DWELL_MS;
}
