import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AGENT_CONTROL_WS_METHODS,
  type AgentControlProposalId,
  type EnvironmentId,
  type ThreadId,
} from "@ryco/contracts";
import {
  buildAgentControlProposalCardModel,
  selectActiveAgentControlProposals,
  selectRecentAgentControlProposals,
  startAgentControlProposalSync,
  useAgentControlStore,
} from "@ryco/client-runtime/state/agentControl";

import { readEnvironmentApi, readEnvironmentApiForConnection } from "../../environmentApi";
import {
  subscribeEnvironmentConnections,
  readEnvironmentConnection,
} from "../../environments/runtime";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { AgentControlProposalCard } from "./AgentControlProposalCard";

export interface AgentControlApprovalsProps {
  readonly environmentId: EnvironmentId;
  readonly activeThreadId: ThreadId | null;
}

/**
 * The Agent Control approval surface for one environment: every live
 * proposal as a decidable card — proposals raised from the active thread
 * first — plus a collapsed history of recent terminal decisions raised
 * from the active thread.
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
  const [historyOpen, setHistoryOpen] = useState(false);

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
  const active = useMemo(
    () => (queueState === null ? [] : selectActiveAgentControlProposals(queueState)),
    [queueState],
  );
  const recent = useMemo(
    () =>
      queueState === null || activeThreadId === null
        ? []
        : selectRecentAgentControlProposals(queueState).filter(
            (proposal) =>
              proposal.principal.kind === "provider-session" &&
              proposal.principal.threadId === activeThreadId,
          ),
    [queueState, activeThreadId],
  );
  const orderedActive = useMemo(() => {
    if (activeThreadId === null) return active;
    return active.toSorted((left, right) => {
      const leftLocal =
        left.principal.kind === "provider-session" && left.principal.threadId === activeThreadId;
      const rightLocal =
        right.principal.kind === "provider-session" && right.principal.threadId === activeThreadId;
      return Number(rightLocal) - Number(leftLocal);
    });
  }, [active, activeThreadId]);

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

  if (orderedActive.length === 0 && recent.length === 0) {
    return null;
  }

  return (
    <div data-testid="agent-control-approvals">
      {orderedActive.map((proposal) => (
        <AgentControlProposalCard
          key={proposal.proposalId}
          model={buildAgentControlProposalCardModel(proposal)}
          environmentId={environmentId}
          isSubmitting={submittingIds.includes(proposal.proposalId)}
          decisionError={decisionErrorsById[proposal.proposalId] ?? null}
          disabledReason={decisionCapability.allowed ? null : (decisionCapability.reason ?? null)}
          onAccept={() => void decide(proposal.proposalId, "accept")}
          onReject={() => void decide(proposal.proposalId, "reject")}
        />
      ))}
      {recent.length > 0 ? (
        <div className="mb-2">
          <Button
            size="xs"
            variant="ghost"
            className="text-muted-foreground"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen((current) => !current)}
          >
            Recent Agent Control decisions · {recent.length}
          </Button>
          {historyOpen ? (
            <ul data-testid="agent-control-recent" className="mt-1 flex flex-col gap-0.5">
              {recent.map((proposal) => {
                const model = buildAgentControlProposalCardModel(proposal);
                return (
                  <li
                    key={proposal.proposalId}
                    className="flex min-w-0 items-baseline gap-2 px-2 text-xs text-muted-foreground"
                  >
                    <span className="shrink-0 font-medium text-foreground/80">
                      {model.statusLabel}
                    </span>
                    <span className="min-w-0 truncate">
                      {model.actionLabel} · {model.targetLabel} · {model.originLabel}
                      {model.executionLabel !== null ? ` · ${model.executionLabel}` : null}
                    </span>
                    {model.affectedThreadIds.map((threadId) => (
                      <a
                        key={threadId}
                        className="shrink-0 text-primary underline-offset-2 hover:underline"
                        href={`/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`}
                      >
                        Open {threadId.length > 10 ? `${threadId.slice(0, 8)}…` : threadId}
                      </a>
                    ))}
                    <span className="ml-auto shrink-0">
                      {formatRelativeTimeLabel(proposal.updatedAt)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
