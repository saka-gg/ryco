import type { WorktreeLaunch } from "@ryco/client-runtime/state/worktree-setup";
import { createContext } from "react";

export interface WorktreeSetupActions {
  /** Stops the setup before the agent starts (the send's Stop). */
  readonly onCancel: () => void;
  /** Sends the failed launch's message again. */
  readonly onRetry: () => void;
  /** Sends the failed launch's message again in the project checkout. */
  readonly onWorkLocally: () => void;
  /** Hands the failed launch's message back to the composer. */
  readonly onDismiss: () => void;
  readonly onOpenTerminal?: ((terminalId: string) => void) | undefined;
}

/**
 * What the timeline's working row needs to present a first send's worktree
 * setup in place of the generic "Working" state.
 */
export interface WorktreeSetupTimelineState {
  readonly launch: WorktreeLaunch;
  readonly actions: WorktreeSetupActions;
}

export const WorktreeSetupTimelineCtx = createContext<WorktreeSetupTimelineState | null>(null);

/** The user message a first send just placed, which rises into the timeline. */
export const EnteringMessageIdCtx = createContext<string | null>(null);
