import { useMemo } from "react";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  EMPTY_AGENT_CONTROL_QUEUE_STATE,
  selectAgentControlExternalActivity,
  useAgentControlStore,
} from "@ryco/client-runtime/state/agentControl";

import { useStore } from "../../store";
import { useAutomationProposalSync } from "../automations/data/useAutomationProposalSync";
import { useAgentControlSyncEnvironmentIds } from "./agentControlSyncGate";
import { AgentControlThreadActivity } from "./AgentControlThreadActivity";
import { useAgentControlDecisions } from "./useAgentControlDecisions";

export interface AgentControlApprovalsProps {
  readonly environmentId: EnvironmentId;
}

/**
 * External integrations' live Agent Control requests. They have no caller
 * thread, so they show in every chat of their environment; a thread's own
 * requests and activity live in the composer's delegation dock.
 *
 * The queue itself comes from `useAutomationProposalSync`, which attempts the
 * subscription whenever a connection exists and leaves the Agent Control
 * policy to the TARGET environment's server; it is skipped only when that
 * environment's own config already reports the feature disabled.
 */
export function AgentControlApprovals({ environmentId }: AgentControlApprovalsProps) {
  const syncEnvironmentIds = useMemo(() => [environmentId], [environmentId]);
  // Skipped while this node's own config says Agent Control is off.
  useAutomationProposalSync(useAgentControlSyncEnvironmentIds(syncEnvironmentIds));

  const queueState = useAgentControlStore(
    (state) => state.queueByEnvironmentId[environmentId] ?? null,
  );
  const selection = useMemo(
    () => selectAgentControlExternalActivity(queueState ?? EMPTY_AGENT_CONTROL_QUEUE_STATE),
    [queueState],
  );
  const threadShells = useStore(
    (state) => state.environmentStateById[environmentId]?.threadShellById,
  );
  const getThreadTitle = useMemo(
    () => (threadId: ThreadId) => threadShells?.[threadId]?.title,
    [threadShells],
  );
  const decisions = useAgentControlDecisions(environmentId);

  return (
    <AgentControlThreadActivity
      key={`external:${environmentId}`}
      environmentId={environmentId}
      getThreadTitle={getThreadTitle}
      submittingIds={decisions.submittingIds}
      decisionErrorsById={decisions.decisionErrorsById}
      disabledReason={decisions.disabledReason}
      onDecide={decisions.decide}
      selection={selection}
    />
  );
}
