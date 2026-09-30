import { useState } from "react";
import type { AgentControlProposalId, EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  buildAgentControlProposalCardModel,
  type AgentControlThreadActivity as ThreadActivity,
} from "@ryco/client-runtime/state/agentControl";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { AgentControlProposalCard } from "./AgentControlProposalCard";

export interface AgentControlThreadActivityProps {
  readonly environmentId: EnvironmentId;
  readonly selection: ThreadActivity;
  readonly getThreadTitle: (threadId: ThreadId) => string | undefined;
  readonly submittingIds: ReadonlyArray<string>;
  readonly decisionErrorsById: Readonly<Record<string, string>>;
  readonly disabledReason: string | null;
  readonly onDecide: (proposalId: AgentControlProposalId, decision: "accept" | "reject") => void;
}

export function AgentControlThreadActivity({
  environmentId,
  selection: { pending, activity, managerThreadId },
  getThreadTitle,
  submittingIds,
  decisionErrorsById,
  disabledReason,
  onDecide,
}: AgentControlThreadActivityProps) {
  const [activityOpen, setActivityOpen] = useState(false);
  const latest = activity[0];
  const latestModel = latest ? buildAgentControlProposalCardModel(latest, getThreadTitle) : null;
  const pendingResultCount = activity.reduce(
    (count, proposal) =>
      count +
      (proposal.completionReturns?.filter((result) =>
        ["waiting", "ready", "dispatching"].includes(result.status),
      ).length ?? 0),
    0,
  );
  const attentionCount = activity.filter(
    (proposal) =>
      proposal.status === "failed" ||
      proposal.completionReturns?.some((result) =>
        ["blocked", "failed", "uncertain"].includes(result.status),
      ),
  ).length;
  if (pending.length === 0 && !latest && managerThreadId === null) return null;

  return (
    <div className="mx-auto mb-2 w-full min-w-0 max-w-208" data-testid="agent-control-approvals">
      {managerThreadId !== null ? (
        <p className="flex min-w-0 items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
          <span className="shrink-0">Managed by</span>
          <a
            className="truncate text-primary underline-offset-2 hover:underline"
            href={`/${encodeURIComponent(environmentId)}/${encodeURIComponent(managerThreadId)}`}
          >
            {getThreadTitle(managerThreadId) || `thread ${managerThreadId.slice(0, 8)}…`}
          </a>
        </p>
      ) : null}
      {pending.length > 0 ? (
        <section aria-label="Agent Control approval requests">
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
            Agent Control · {pending.length} awaiting approval
          </p>
          <div className="max-h-[min(18rem,35dvh)] overflow-y-auto overscroll-contain">
            {pending.map((proposal) => (
              <AgentControlProposalCard
                key={proposal.proposalId}
                model={buildAgentControlProposalCardModel(proposal, getThreadTitle)}
                environmentId={environmentId}
                getThreadTitle={getThreadTitle}
                isSubmitting={submittingIds.includes(proposal.proposalId)}
                decisionError={decisionErrorsById[proposal.proposalId] ?? null}
                disabledReason={disabledReason}
                onAccept={() => onDecide(proposal.proposalId, "accept")}
                onReject={() => onDecide(proposal.proposalId, "reject")}
              />
            ))}
          </div>
        </section>
      ) : null}
      {latest && latestModel ? (
        <>
          <Button
            size="xs"
            variant="ghost"
            className="h-auto w-full min-w-0 justify-start gap-2 py-1.5 text-xs text-muted-foreground"
            aria-label={`Agent Control activity · ${activity.length} actions`}
            aria-expanded={activityOpen}
            onClick={() => setActivityOpen((current) => !current)}
          >
            {activityOpen ? (
              <ChevronDownIcon className="size-3 shrink-0" />
            ) : (
              <ChevronRightIcon className="size-3 shrink-0" />
            )}
            <span className="shrink-0">Agent Control · {activity.length}</span>
            <span className="min-w-0 truncate text-left">
              {latestModel.statusLabel} · {latestModel.actionLabel} · {latestModel.targetLabel}
              {pendingResultCount > 0
                ? ` · ${pendingResultCount} child result${pendingResultCount === 1 ? "" : "s"} pending`
                : null}
            </span>
            {attentionCount > 0 ? (
              <span className="shrink-0 text-destructive">
                {attentionCount} {attentionCount === 1 ? "needs" : "need"} attention
              </span>
            ) : null}
            <span className="ml-auto shrink-0">{formatRelativeTimeLabel(latest.updatedAt)}</span>
          </Button>
          {activityOpen ? (
            <div
              data-testid="agent-control-activity-details"
              className="mt-1 max-h-[min(18rem,35dvh)] overflow-y-auto overscroll-contain"
            >
              {activity.map((proposal) => (
                <AgentControlProposalCard
                  key={proposal.proposalId}
                  model={buildAgentControlProposalCardModel(proposal, getThreadTitle)}
                  environmentId={environmentId}
                  getThreadTitle={getThreadTitle}
                  isSubmitting={false}
                  decisionError={null}
                  disabledReason={null}
                  onAccept={() => {}}
                  onReject={() => {}}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
