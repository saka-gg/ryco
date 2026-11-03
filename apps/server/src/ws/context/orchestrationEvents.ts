import type { OrchestrationEvent } from "@ryco/contracts";

/**
 * The thread events a thread subscription forwards: its detail, and its follow-up queue (whose
 * entries ride on thread detail). Clients that predate the queue decode the queue events as
 * unknown and skip them.
 */
export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set"
      | "thread.queue-entry-added"
      | "thread.queue-entry-edited"
      | "thread.queue-reordered"
      | "thread.queue-entries-removed"
      | "thread.queue-entry-failed"
      | "thread.queue-held"
      | "thread.queue-released";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set" ||
    event.type.startsWith("thread.queue-")
  );
}
