import type { ThreadId } from "@ryco/contracts";

/**
 * The agents sheet's own state: whether it shows, and a delegated task to open
 * once it has gone. iOS slides a page sheet away before the screen beneath may
 * push another, so a task chosen in the sheet opens when the sheet reports it
 * is gone, not in the same moment.
 */
export interface ThreadAgentsSheetState {
  readonly open: boolean;
  readonly openAfterDismiss: ThreadId | null;
}

export const THREAD_AGENTS_SHEET_CLOSED: ThreadAgentsSheetState = {
  open: false,
  openAfterDismiss: null,
};

export function openThreadAgentsSheet(): ThreadAgentsSheetState {
  return { open: true, openAfterDismiss: null };
}

/**
 * Done, a swipe down, or the chat running out of agents. A sheet that closes
 * stays closed: the chat's next agent shows on the control, never by
 * reopening the sheet on its own.
 */
export function closeThreadAgentsSheet(state: ThreadAgentsSheetState): ThreadAgentsSheetState {
  return state.open ? { ...state, open: false } : state;
}

export interface ThreadAgentsSheetTransition {
  readonly state: ThreadAgentsSheetState;
  /** The delegated task to open now, if any. */
  readonly openNow: ThreadId | null;
}

/**
 * A delegated task's row: the sheet closes and the task opens once it is gone,
 * or at once where the platform never reports that (Android).
 */
export function chooseThreadAgentsSheetTask(
  threadId: ThreadId,
  reportsDismissal: boolean,
): ThreadAgentsSheetTransition {
  return reportsDismissal
    ? { state: { open: false, openAfterDismiss: threadId }, openNow: null }
    : { state: THREAD_AGENTS_SHEET_CLOSED, openNow: threadId };
}

/**
 * The sheet reports it is gone: a task chosen in it opens now. Reopening the
 * sheet before then dropped the task (`openThreadAgentsSheet`).
 */
export function threadAgentsSheetDismissed(
  state: ThreadAgentsSheetState,
): ThreadAgentsSheetTransition {
  if (state.openAfterDismiss === null) return { state, openNow: null };
  return { state: { ...state, openAfterDismiss: null }, openNow: state.openAfterDismiss };
}

/** The sheet stays mounted while it shows or a task waits for it to go, even with no agents left. */
export function isThreadAgentsSheetMounted(
  state: ThreadAgentsSheetState,
  hasAgents: boolean,
): boolean {
  return hasAgents || state.open || state.openAfterDismiss !== null;
}
