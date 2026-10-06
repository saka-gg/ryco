import { useCallback, useMemo, useState } from "react";
import {
  AGENT_CONTROL_WS_METHODS,
  type AgentControlProposalId,
  type EnvironmentId,
  type ThreadId,
} from "@ryco/contracts";
import {
  EMPTY_AGENT_CONTROL_QUEUE_STATE,
  selectAgentControlExternalActivity,
  selectAgentControlThreadActivity,
  useAgentControlStore,
} from "@ryco/client-runtime/state/agentControl";

import { readEnvironmentApi } from "../../environmentApi";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useStore } from "../../store";
import { useAutomationProposalSync } from "../automations/data/useAutomationProposalSync";
import { AgentControlThreadActivity } from "./AgentControlThreadActivity";

export interface AgentControlApprovalsProps {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
}

/**
 * Thread-scoped approvals and compact activity. The environment-wide
 * subscription remains authoritative, but other provider threads' proposals
 * never render in this chat. External clients have no caller thread; their
 * live requests remain reachable in a separate environment-wide section.
 *
 * The queue itself comes from `useAutomationProposalSync`, which attempts the
 * subscription whenever a connection exists and leaves the Agent Control
 * policy to the TARGET environment's server.
 */
export function AgentControlApprovals({
  environmentId,
  activeThreadId,
}: AgentControlApprovalsProps) {
  const decisionCapability = useHostedRpcCapability(AGENT_CONTROL_WS_METHODS.acceptProposal);
  const [submittingIds, setSubmittingIds] = useState<ReadonlyArray<string>>([]);
  const [decisionErrorsById, setDecisionErrorsById] = useState<Readonly<Record<string, string>>>(
    {},
  );

  useAutomationProposalSync([environmentId]);

  const queueState = useAgentControlStore(
    (state) => state.queueByEnvironmentId[environmentId] ?? null,
  );
  // Server lineage names the creator; proposal history stays the fallback.
  const activeLineage = useStore((state) =>
    activeThreadId === null
      ? null
      : (state.environmentStateById[environmentId]?.threadShellById[activeThreadId]?.lineage ??
        null),
  );
  const selection = useMemo(
    () =>
      selectAgentControlThreadActivity(
        queueState ?? EMPTY_AGENT_CONTROL_QUEUE_STATE,
        activeThreadId,
        activeLineage,
      ),
    [queueState, activeThreadId, activeLineage],
  );
  const externalSelection = useMemo(
    () => selectAgentControlExternalActivity(queueState ?? EMPTY_AGENT_CONTROL_QUEUE_STATE),
    [queueState],
  );
  const threadShells = useStore(
    (state) => state.environmentStateById[environmentId]?.threadShellById,
  );
  const getThreadTitle = useCallback(
    (threadId: ThreadId) => threadShells?.[threadId]?.title,
    [threadShells],
  );

  const decide = useCallback(
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
        // Stale/conflicting decisions surface here; the queue subscription
        // delivers the authoritative state alongside this message.
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

  const activityProps = {
    environmentId,
    getThreadTitle,
    submittingIds,
    decisionErrorsById,
    disabledReason: decisionCapability.allowed ? null : (decisionCapability.reason ?? null),
    onDecide: (proposalId: AgentControlProposalId, decision: "accept" | "reject") =>
      void decide(proposalId, decision),
  };
  return (
    <>
      <AgentControlThreadActivity
        key={`thread:${environmentId}:${activeThreadId ?? ""}`}
        {...activityProps}
        selection={selection}
      />
      <AgentControlThreadActivity
        key={`external:${environmentId}`}
        {...activityProps}
        scope="external"
        selection={externalSelection}
      />
    </>
  );
}
