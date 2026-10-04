import { useCallback, useEffect, useMemo, useState } from "react";
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
  startAgentControlProposalSync,
  useAgentControlStore,
} from "@ryco/client-runtime/state/agentControl";

import { readEnvironmentApi, readEnvironmentApiForConnection } from "../../environmentApi";
import {
  subscribeEnvironmentConnections,
  readEnvironmentConnection,
} from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useStore } from "../../store";
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
 * The Agent Control setting is enforced by the TARGET environment's server
 * (which may not be the primary node whose settings the web client
 * mirrors): the subscription is simply attempted whenever a connection
 * exists, and a server with the feature disabled refuses it — so nothing
 * renders and no policy is decided client-side. The sync re-binds whenever
 * the environment's connection is (re)registered, following the
 * gitStatusState pattern, so late-connecting saved environments and
 * reconnects keep the queue live.
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

  useEffect(() => {
    let currentClient: unknown = null;
    let stopSync: (() => void) | null = null;

    const syncSubscription = () => {
      const client = readEnvironmentConnection(environmentId)?.client ?? null;
      if (client === currentClient) return;
      stopSync?.();
      stopSync = null;
      currentClient = client;
      const source = client
        ? readEnvironmentApiForConnection(environmentId, client)?.agentControl
        : undefined;
      if (!source) return;
      const store = useAgentControlStore.getState();
      stopSync = startAgentControlProposalSync({
        environmentId,
        source,
        sink: {
          applyStreamEvent: store.applyStreamEvent,
          clearEnvironment: store.clearEnvironment,
        },
      });
    };

    const unsubscribeRegistry = subscribeEnvironmentConnections(syncSubscription);
    syncSubscription();
    return () => {
      unsubscribeRegistry();
      stopSync?.();
    };
  }, [environmentId]);

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
