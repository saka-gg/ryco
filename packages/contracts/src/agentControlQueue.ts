import * as Schema from "effect/Schema";
import {
  MessageId,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  rejectExcessProperties,
} from "./baseSchemas.ts";
import {
  MAX_FOLLOW_UP_QUEUE_ENTRIES,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "./orchestration.ts";

/**
 * Private-session tools for a thread's follow-up queue: an agent lists it, and edits or removes
 * the entries it queued itself (`ryco_send_message` with `delivery: "queue"`). A person's entries,
 * another chat's agent's and a schedule's stay out of reach. Like the delegation tools, they are
 * not part of `AGENT_CONTROL_MCP_TOOLS` and never reach the external endpoint.
 */
export const AGENT_CONTROL_QUEUE_MCP_TOOLS = {
  queueList: "ryco_queue_list",
  queueEdit: "ryco_queue_edit",
  queueRemove: "ryco_queue_remove",
} as const;

export const AgentControlQueueListInput = Schema.Struct({
  threadId: ThreadId,
}).pipe(rejectExcessProperties);
export type AgentControlQueueListInput = typeof AgentControlQueueListInput.Type;

/** Replaces the text of one entry the caller queued, at the revision it read. */
export const AgentControlQueueEditInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  expectedRevision: PositiveInt,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
}).pipe(rejectExcessProperties);
export type AgentControlQueueEditInput = typeof AgentControlQueueEditInput.Type;

/** Takes entries the caller queued out of the queue. */
export const AgentControlQueueRemoveInput = Schema.Struct({
  threadId: ThreadId,
  messageIds: Schema.Array(MessageId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_FOLLOW_UP_QUEUE_ENTRIES),
  ),
}).pipe(rejectExcessProperties);
export type AgentControlQueueRemoveInput = typeof AgentControlQueueRemoveInput.Type;
