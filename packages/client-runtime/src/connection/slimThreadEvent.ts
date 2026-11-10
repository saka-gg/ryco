import type {
  OrchestrationSlimThreadEvent,
  OrchestrationWireEvent,
  ThreadId,
} from "@ryco/contracts";
import { EventId, isUnknownUnionMember } from "@ryco/contracts/base-schemas";

/**
 * Restores the fields a slim thread event (`OrchestrationSlimThreadEvent`)
 * leaves out, so the store applies it like a full event. The client reads none
 * of them: the aggregate is the subscription's thread, and the ids and
 * metadata stand in as empty values. An event type this build does not know
 * stays an unknown member, which the caller skips (and resumes after).
 */
export function expandSlimThreadEvent(
  event: OrchestrationSlimThreadEvent,
  threadId: ThreadId,
): OrchestrationWireEvent {
  if (isUnknownUnionMember(event)) {
    return Object.assign(event, {
      aggregateKind: "thread",
      aggregateId: threadId,
    }) as OrchestrationWireEvent;
  }
  return {
    ...event,
    eventId: EventId.make(`slim:${event.sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
  } as OrchestrationWireEvent;
}
