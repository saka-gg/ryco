/**
 * The mark a thread list shows for a thread whose node queue holds follow-ups. Its own subpath
 * (`@ryco/client-runtime/state/message-queue/queueBadge`), so only the lists that show it load it.
 *
 * @module queueBadge
 */
import type { ThreadFollowUpQueueShell } from "@ryco/contracts";
import { heldOnlyForDelegationSlot } from "@ryco/shared/delegationSlot";

import { describeQueueHold } from "./hold.ts";

/** How a thread list marks a thread with queued follow-ups (the node's shell summary). */
export interface FollowUpQueueBadge {
  /** "2 queued", or "2 held" when nothing goes out without the person. */
  readonly label: string;
  /** "2 queued follow-ups: Paused after an error" */
  readonly title: string;
  /** Held, or the next one waits for Retry: nothing goes out without the person. */
  readonly held: boolean;
}

/** The mark for a thread whose queue holds follow-ups, or null while it holds none. */
export function followUpQueueBadgeOf(
  summary: Pick<ThreadFollowUpQueueShell, "count" | "hold" | "headStatus"> | null | undefined,
): FollowUpQueueBadge | null {
  if (!summary || summary.count <= 0) return null;
  const queued = `${summary.count} queued follow-up${summary.count === 1 ? "" : "s"}`;
  // A delegated task waiting for a free slot: the node sends it on its own.
  if (heldOnlyForDelegationSlot(summary.hold)) {
    return {
      label: `${summary.count} queued`,
      title: `${queued}: Waiting for a free slot`,
      held: false,
    };
  }
  const why =
    summary.hold !== null
      ? describeQueueHold(summary.hold).title
      : summary.headStatus === "failed"
        ? "The next one waits for Retry"
        : null;
  return {
    label: `${summary.count} ${why === null ? "queued" : "held"}`,
    title: why === null ? queued : `${queued}: ${why}`,
    held: why !== null,
  };
}
