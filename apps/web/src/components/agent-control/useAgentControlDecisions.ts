import { useCallback, useState } from "react";
import {
  AGENT_CONTROL_WS_METHODS,
  type AgentControlProposalId,
  type EnvironmentId,
} from "@ryco/contracts";

import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";

export interface AgentControlDecisions {
  readonly submittingIds: ReadonlyArray<string>;
  readonly decisionErrorsById: Readonly<Record<string, string>>;
  /** Non-null when this client may not decide (e.g. a hosted role too low). */
  readonly disabledReason: string | null;
  readonly decide: (proposalId: AgentControlProposalId, decision: "accept" | "reject") => void;
}

/**
 * Accept/reject for one environment's Agent Control proposals. The server
 * decides; a stale or conflicting decision comes back as an error message and
 * the queue subscription delivers the authoritative state alongside it.
 */
export function useAgentControlDecisions(environmentId: EnvironmentId): AgentControlDecisions {
  const decisionCapability = useHostedRpcCapability(AGENT_CONTROL_WS_METHODS.acceptProposal);
  const [submittingIds, setSubmittingIds] = useState<ReadonlyArray<string>>([]);
  const [decisionErrorsById, setDecisionErrorsById] = useState<Readonly<Record<string, string>>>(
    {},
  );

  const submit = useCallback(
    async (proposalId: AgentControlProposalId, decision: "accept" | "reject") => {
      const api = readEnvironmentApi(environmentId)?.agentControl;
      if (!api) return;
      setSubmittingIds((current) =>
        current.includes(proposalId) ? current : [...current, proposalId],
      );
      setDecisionErrorsById(({ [proposalId]: _cleared, ...rest }) => rest);
      try {
        if (decision === "accept") {
          await api.acceptProposal({ proposalId });
        } else {
          await api.rejectProposal({ proposalId });
        }
      } catch (error) {
        setDecisionErrorsById((current) => ({
          ...current,
          [proposalId]:
            error instanceof Error && error.message.length > 0
              ? error.message
              : "Failed to submit the decision.",
        }));
      } finally {
        setSubmittingIds((current) => current.filter((id) => id !== proposalId));
      }
    },
    [environmentId],
  );
  const decide = useCallback(
    (proposalId: AgentControlProposalId, decision: "accept" | "reject") =>
      void submit(proposalId, decision),
    [submit],
  );

  return {
    submittingIds,
    decisionErrorsById,
    disabledReason: decisionCapability.allowed ? null : (decisionCapability.reason ?? null),
    decide,
  };
}
