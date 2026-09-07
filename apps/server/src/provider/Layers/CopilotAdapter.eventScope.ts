import type { SessionEvent } from "@github/copilot-sdk";

/** Wildcard SDK subscriptions include child events, including their turn and abort events. */
export function isCopilotChildEvent(event: SessionEvent): boolean {
  return Boolean(
    event.agentId || ("parentToolCallId" in event.data && event.data.parentToolCallId),
  );
}
