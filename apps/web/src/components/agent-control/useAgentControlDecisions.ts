import { useCallback, useState } from "react";
import {
  AGENT_CONTROL_WS_METHODS,
  type AgentControlProposalView,
  type EnvironmentId,
} from "@ryco/contracts";
import {
  agentControlCardDecisions,
  buildAgentControlProposalCardModel,
} from "@ryco/client-runtime/state/agentControl";

import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedHubStore } from "../../hostedHub/state";
import { hostedCapabilityCopy, hostedSwitchTargetLabel } from "../../hostedHub/switchTarget";
import { useAgentControlClientExecutor } from "./agentControlClientExecutor";

export interface AgentControlDecisions {
  readonly submittingIds: ReadonlyArray<string>;
  readonly decisionErrorsById: Readonly<Record<string, string>>;
  /** Non-null when this client may not decide (e.g. a hosted role too low). */
  readonly disabledReason: string | null;
  readonly decide: (proposal: AgentControlProposalView, decision: "accept" | "reject") => void;
}

/**
 * Accept/reject for one environment's Agent Control proposals. The server
 * decides; a stale or conflicting decision comes back as an error message and
 * the queue subscription delivers the authoritative state alongside it.
 *
 * Accepting goes through `agentControlCardDecisions` first, the rule the cards
 * render by: a plan this build cannot read is never accepted, and a
 * client-executed plan is handed to the client executor instead of a plain accept.
 */
export function useAgentControlDecisions(environmentId: EnvironmentId): AgentControlDecisions {
  const decisionCapability = useHostedRpcCapability(
    AGENT_CONTROL_WS_METHODS.acceptProposal,
    environmentId,
  );
  const nodeLabel = useHostedHubStore((state) => hostedSwitchTargetLabel(state, environmentId));
  const executor = useAgentControlClientExecutor();
  const [submittingIds, setSubmittingIds] = useState<ReadonlyArray<string>>([]);
  const [decisionErrorsById, setDecisionErrorsById] = useState<Readonly<Record<string, string>>>(
    {},
  );

  const submit = useCallback(
    async (proposal: AgentControlProposalView, decision: "accept" | "reject") => {
      const { proposalId } = proposal;
      const api = readEnvironmentApi(environmentId)?.agentControl;
      if (!api) return;
      setSubmittingIds((current) =>
        current.includes(proposalId) ? current : [...current, proposalId],
      );
      setDecisionErrorsById(({ [proposalId]: _cleared, ...rest }) => rest);
      try {
        if (decision === "reject") {
          await api.rejectProposal({ proposalId });
        } else {
          const model = buildAgentControlProposalCardModel(proposal);
          const allowed = agentControlCardDecisions(model, executor?.canExecute ?? null);
          if (!allowed.canApprove) {
            throw new Error(
              allowed.approveUnavailableLabel ?? "This request cannot be approved here.",
            );
          }
          if (model.requiresClientExecutor && executor) {
            await executor.approve({ environmentId, proposal });
          } else {
            await api.acceptProposal({ proposalId });
          }
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
    [environmentId, executor],
  );
  const decide = useCallback(
    (proposal: AgentControlProposalView, decision: "accept" | "reject") =>
      void submit(proposal, decision),
    [submit],
  );

  return {
    submittingIds,
    decisionErrorsById,
    disabledReason: decisionCapability.allowed
      ? null
      : hostedCapabilityCopy(decisionCapability, nodeLabel),
    decide,
  };
}
