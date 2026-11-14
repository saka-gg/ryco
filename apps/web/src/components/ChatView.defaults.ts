import type { OrchestrationThreadActivity, ServerProvider } from "@ryco/contracts";
import type {
  PendingFollowUpAdd,
  QueuedMessageSteerAttempts,
} from "@ryco/client-runtime/state/message-queue";

import type { PresentationTier } from "../lib/presentationTier";
import type { QueuedMessage } from "../messageQueue.logic";
import type { SessionTabItem } from "../sessionTabs.selectors";

export const EMPTY_ACTIVITIES: OrchestrationThreadActivity[] = [];
export const EMPTY_PROVIDERS: ServerProvider[] = [];
export const EMPTY_PROVIDER_SKILLS: ServerProvider["skills"] = [];
export const EMPTY_SESSION_TABS: ReadonlyArray<SessionTabItem> = Object.freeze([]);

// Stable identity so the message-queue selector doesn't churn on empty threads.
export const EMPTY_QUEUED_MESSAGES: readonly QueuedMessage[] = Object.freeze([]);
export const EMPTY_PENDING_FOLLOW_UPS: readonly PendingFollowUpAdd[] = Object.freeze([]);
export const EMPTY_STEER_ATTEMPTS: QueuedMessageSteerAttempts = Object.freeze({});

/** A launch handed off this recently is still being carried over by a new view. */
export const CONTINUED_LAUNCH_WINDOW_MS = 5_000;
/** setTimeout's largest delay: an open thread's snooze ending later is not waited for. */
export const MAX_SNOOZE_WAKE_DELAY_MS = 2 ** 31 - 1;

/** How long the composer keeps focus on a thread before that focus prewarms its session. */
export const PROVIDER_SESSION_PREWARM_FOCUS_DWELL_MS = 400;

/**
 * Whether a thread opens with the overview rail docked: only where the rail
 * sits inline. Narrow viewports and split panes present right-hand panels as
 * sheets, and the phone tier's overview is a full-screen surface that never
 * opens on its own.
 */
export function overviewOpensByDefault(
  shouldUseRightPanelSheet: boolean,
  presentationTier: PresentationTier,
): boolean {
  return !shouldUseRightPanelSheet && presentationTier !== "phone";
}
