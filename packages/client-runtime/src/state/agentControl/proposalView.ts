import type {
  AgentControlProposal,
  AgentControlProposalStreamEvent,
  AgentControlProposalStreamEventView,
  AgentControlProposalView,
} from "@ryco/contracts";

/**
 * Proposals arrive through the tolerant wire view: a plan kind this build does
 * not know decodes as `unsupported`. Until the queue renders those as their own
 * "update Ryco" cards, they stay out of the shared store, so this client never
 * shows or decides a request it cannot present.
 */
export function isSupportedAgentControlProposal(
  proposal: AgentControlProposalView,
): proposal is AgentControlProposal {
  return proposal.plan.kind !== "unsupported";
}

export function supportedAgentControlProposals(
  proposals: ReadonlyArray<AgentControlProposalView>,
): ReadonlyArray<AgentControlProposal> {
  return proposals.filter(isSupportedAgentControlProposal);
}

/** The event with unsupported proposals left out; null when nothing of it remains. */
export function supportedAgentControlStreamEvent(
  event: AgentControlProposalStreamEventView,
): AgentControlProposalStreamEvent | null {
  if (event.type === "proposal") {
    return isSupportedAgentControlProposal(event.proposal)
      ? { ...event, proposal: event.proposal }
      : null;
  }
  return {
    ...event,
    queue: {
      ...event.queue,
      active: supportedAgentControlProposals(event.queue.active),
      recent: supportedAgentControlProposals(event.queue.recent),
    },
  };
}
