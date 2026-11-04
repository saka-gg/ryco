import type {
  AgentControlProposalId,
  AgentControlProposalReceiptView,
  EnvironmentApi,
} from "@ryco/contracts";

// Agent Control decision wrappers, following the sessionActions pattern:
// each dispatches through the `EnvironmentApi` seam with no forked runtime
// logic. The client only sends the explicit decision — every policy check,
// transition rule, and expiry decision stays server-side.

function requireAgentControlApi(api: EnvironmentApi): NonNullable<EnvironmentApi["agentControl"]> {
  const agentControl = api.agentControl;
  if (!agentControl) {
    throw new Error("Agent Control is not available on this environment.");
  }
  return agentControl;
}

export async function acceptAgentControlProposal(input: {
  readonly api: EnvironmentApi;
  readonly proposalId: AgentControlProposalId;
}): Promise<AgentControlProposalReceiptView> {
  return requireAgentControlApi(input.api).acceptProposal({ proposalId: input.proposalId });
}

export async function rejectAgentControlProposal(input: {
  readonly api: EnvironmentApi;
  readonly proposalId: AgentControlProposalId;
}): Promise<AgentControlProposalReceiptView> {
  return requireAgentControlApi(input.api).rejectProposal({ proposalId: input.proposalId });
}
