/**
 * The hold a capped `ryco_create_threads` request (`maxConcurrent`) puts on the follow-up queue
 * of each task that waits for a free slot, and how the node tells it from the other holds.
 *
 * Agent Control's execution queues such a task's first message with this hold; the slot runtime
 * (`agentControl/delegationSlotRuntime.ts`, loaded lazily) releases it, cause by cause, when an
 * earlier task of the same request stops working. `ryco_task_cancel` takes a waiting task's
 * first message out of its queue instead, so it never starts. Boot modules import this file; the
 * runtime gets its values passed in.
 *
 * @module delegationSlotHold
 */
import type {
  CommandId,
  FollowUpQueueHold,
  FollowUpQueueHoldInput,
  MessageId,
  OrchestrationThread,
  QueuedFollowUp,
} from "@ryco/contracts";

/** Cause keys of slot holds: `delegation-slot:<proposalId>`. */
export const DELEGATION_SLOT_CAUSE_PREFIX = "delegation-slot:";

/** The hold of a task that waits for a free slot of request `proposalId`. */
export const delegationSlotHold = (
  proposalId: string,
  maxConcurrent: number,
): FollowUpQueueHoldInput => ({
  reason: "paused",
  detail: `Waiting for a free slot: this request runs at most ${maxConcurrent} task${
    maxConcurrent === 1 ? "" : "s"
  } at once.`,
  causeKeys: [`${DELEGATION_SLOT_CAUSE_PREFIX}${proposalId}`],
});

/**
 * Whether only slot holds keep the queue: the node releases those itself, so a restart adds no
 * hold of its own (the request goes on after it).
 */
export const heldOnlyForDelegationSlot = (
  hold: Pick<FollowUpQueueHold, "causeKeys"> | null | undefined,
): boolean =>
  hold != null &&
  hold.causeKeys.length > 0 &&
  hold.causeKeys.every((key) => key.startsWith(DELEGATION_SLOT_CAUSE_PREFIX));

/** Whether the task's queue waits for a free slot of request `proposalId`. */
export const waitsForDelegationSlot = (
  hold: Pick<FollowUpQueueHold, "causeKeys"> | null | undefined,
  proposalId: string,
): boolean => hold?.causeKeys.includes(`${DELEGATION_SLOT_CAUSE_PREFIX}${proposalId}`) === true;

/**
 * The removal of a cancelled task's first message from its queue: one id per task, so the cancel
 * and the slot runtime's repair after a restart never remove twice.
 */
export const delegationSlotCancelCommandId = (proposalId: string, threadId: string) =>
  `delegation-slot-cancel:${proposalId}:${threadId}` as CommandId;

/** No user message reached the thread yet: a delegated task whose first message is unsent. */
export const noUserMessageSent = (thread: Pick<OrchestrationThread, "messages">): boolean =>
  !thread.messages.some((message) => message.role === "user");

/**
 * What cancelling an unsent task takes out of its queue: its first message and the agent's own
 * follow-ups. A person's own entries stay.
 */
export const cancelledTaskEntryIds = (
  entries: ReadonlyArray<Pick<QueuedFollowUp, "messageId" | "author">>,
  firstMessageId: string,
): ReadonlyArray<MessageId> =>
  entries
    .filter((entry) => entry.messageId === firstMessageId || entry.author === "agent")
    .map((entry) => entry.messageId);
