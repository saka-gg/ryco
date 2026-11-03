import type { CommandId } from "@ryco/contracts";

/**
 * Command id prefixes of commands the node sends on its own: provider runtime ingestion
 * (`provider:`), server services (`server:`) and Agent Control executions (`agent-control:`).
 * The event store attributes the first two to their actor (`OrchestrationEventStore`), and
 * completion returns never count an Agent Control interrupt as the user's Stop.
 */
const NODE_COMMAND_ID_PREFIXES = ["provider:", "server:", "agent-control:"] as const;

/**
 * Whether a command was dispatched by a person through a client, not by the node itself. Only
 * meaningful for commands clients may send: internal commands never come from a client.
 */
export function isUserOriginatedCommandId(commandId: CommandId | string): boolean {
  return !NODE_COMMAND_ID_PREFIXES.some((prefix) => commandId.startsWith(prefix));
}
