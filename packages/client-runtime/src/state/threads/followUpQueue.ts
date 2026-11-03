import type { OrchestrationEvent, QueuedFollowUp, ThreadFollowUpQueue } from "@ryco/contracts";

/**
 * A thread's server-owned follow-up queue as this client follows it: the thread detail's
 * `followUpQueue`, then its `thread.queue-*` events. The rules mirror the node's projection
 * (`projectFollowUpQueueEvent`), so a replayed event leaves the queue as it was. Kept small:
 * the threads store, which boot loads, applies it.
 */
export type FollowUpQueueEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.queue-entry-added"
      | "thread.queue-entry-edited"
      | "thread.queue-reordered"
      | "thread.queue-entries-removed"
      | "thread.queue-entry-failed"
      | "thread.queue-held"
      | "thread.queue-released";
  }
>;

export function isFollowUpQueueEvent(event: OrchestrationEvent): event is FollowUpQueueEvent {
  return event.type.startsWith("thread.queue-");
}

const indexOf = (entries: ReadonlyArray<QueuedFollowUp>, messageId: string | null) =>
  entries.findIndex((entry) => entry.messageId === messageId);

/** The queue after one of its events; undefined once it is empty and unheld. */
export function applyFollowUpQueueEvent(
  queue: ThreadFollowUpQueue | undefined,
  event: FollowUpQueueEvent,
): ThreadFollowUpQueue | undefined {
  let entries = queue?.entries ?? [];
  let hold = queue?.hold ?? null;
  switch (event.type) {
    case "thread.queue-entry-added":
    case "thread.queue-entry-edited": {
      const { entry } = event.payload;
      const index = indexOf(entries, entry.messageId);
      if (index >= 0) {
        // An edit, or a replayed add, which keeps the entry where it is.
        entries = entries.map((candidate, at) => (at === index ? entry : candidate));
      } else if (event.type === "thread.queue-entry-added") {
        // Plain array methods only: the store also runs on Hermes.
        const before = indexOf(entries, event.payload.beforeMessageId);
        entries =
          before < 0
            ? [...entries, entry]
            : [...entries.slice(0, before), entry, ...entries.slice(before)];
      }
      break;
    }
    case "thread.queue-reordered": {
      // `order` first; an entry it does not name keeps its place after them.
      const rank = new Map<string, number>(event.payload.order.map((id, index) => [id, index]));
      entries = entries.toSorted(
        (left, right) =>
          (rank.get(left.messageId) ?? rank.size) - (rank.get(right.messageId) ?? rank.size),
      );
      break;
    }
    case "thread.queue-entries-removed": {
      const removed = new Set<string>(event.payload.messageIds);
      entries = entries.filter((entry) => !removed.has(entry.messageId));
      break;
    }
    case "thread.queue-entry-failed": {
      const { messageId, revision, failure, updatedAt } = event.payload;
      entries = entries.map((entry) =>
        entry.messageId === messageId
          ? { ...entry, status: "failed" as const, failure, revision, updatedAt }
          : entry,
      );
      break;
    }
    case "thread.queue-held":
      hold = event.payload.hold;
      break;
    case "thread.queue-released":
      hold = null;
  }
  return entries.length === 0 && hold === null ? undefined : { entries, hold };
}
