import { CommandId } from "@ryco/contracts";

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

/**
 * A fresh id for a command a server service sends on its own: `server:<tag>:<uuid>`. The
 * `server:` prefix marks it as the node's (above) and attributes it to the server actor.
 */
export const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

/** Whether a command was derived from a provider runtime event (`provider:`). */
export const isProviderOriginatedCommandId = (commandId: CommandId | string | null): boolean =>
  commandId !== null && commandId.startsWith("provider:");
