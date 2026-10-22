import type { AgentControlProposal, AgentControlProposalView } from "@ryco/contracts";

/**
 * Proposals arrive through the tolerant wire view: a plan kind this build does
 * not know decodes as `unsupported`. The queue keeps and shows those (as
 * "Update Ryco to review this request" cards that offer only Reject); surfaces
 * that read a plan's fields for their own purpose (schedules, history) take the
 * supported ones only.
 */
export function isSupportedAgentControlProposal(
  proposal: AgentControlProposalView,
): proposal is AgentControlProposal {
  return proposal.plan.kind !== "unsupported";
}

export function supportedAgentControlProposals(
  proposals: ReadonlyArray<AgentControlProposalView>,
): ReadonlyArray<AgentControlProposal> {
  return proposals.every(isSupportedAgentControlProposal)
    ? proposals
    : proposals.filter(isSupportedAgentControlProposal);
}
