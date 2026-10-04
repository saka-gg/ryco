import { useId, useState } from "react";
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
  readonly scope?: "thread" | "external";
  readonly environmentId: EnvironmentId;
  readonly selection: ThreadActivity;
  readonly getThreadTitle: (threadId: ThreadId) => string | undefined;
  readonly submittingIds: ReadonlyArray<string>;
  readonly decisionErrorsById: Readonly<Record<string, string>>;
  readonly disabledReason: string | null;
  readonly onDecide: (proposalId: AgentControlProposalId, decision: "accept" | "reject") => void;
}

function ThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly getThreadTitle: (threadId: ThreadId) => string | undefined;
}) {
  return (
    <a
      className="truncate text-primary underline-offset-2 hover:underline"
      href={`/${encodeURIComponent(props.environmentId)}/${encodeURIComponent(props.threadId)}`}
    >
      {props.getThreadTitle(props.threadId) || `thread ${props.threadId.slice(0, 8)}…`}
    </a>
  );
}

export function AgentControlThreadActivity({
  scope = "thread",
  environmentId,
  selection: { pending, activity, managerThreadId, delegatedFromThreadId },
  getThreadTitle,
  submittingIds,
  decisionErrorsById,
  disabledReason,
  onDecide,
}: AgentControlThreadActivityProps) {
  const [activityOpen, setActivityOpen] = useState(false);
  const statusSummaryId = useId();
  const label = scope === "external" ? "External Agent Control" : "Agent Control";
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
  if (
    pending.length === 0 &&
    !latest &&
    managerThreadId === null &&
    delegatedFromThreadId === null
  ) {
    return null;
  }

  return (
    <div
      className="mx-auto mb-2 w-full min-w-0 max-w-208"
      data-testid={
        scope === "external" ? "agent-control-external-approvals" : "agent-control-approvals"
      }
    >
      {delegatedFromThreadId !== null || managerThreadId !== null ? (
        <p className="flex min-w-0 items-center gap-1 px-2 py-1 text-xs text-muted-foreground">
          {delegatedFromThreadId !== null ? (
            <>
              <span className="shrink-0">Delegated from</span>
              <ThreadLink
                environmentId={environmentId}
                getThreadTitle={getThreadTitle}
                threadId={delegatedFromThreadId}
              />
            </>
          ) : null}
          {delegatedFromThreadId !== null && managerThreadId !== null ? (
            <span aria-hidden className="shrink-0">
              ·
            </span>
          ) : null}
          {managerThreadId !== null ? (
            <>
              <span className="shrink-0">Managed by</span>
              <ThreadLink
                environmentId={environmentId}
                getThreadTitle={getThreadTitle}
                threadId={managerThreadId}
              />
            </>
          ) : null}
        </p>
      ) : null}
      {pending.length > 0 ? (
        <section aria-label={`${label} approval requests`}>
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
            {label} · {pending.length} awaiting approval
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
            className="h-auto w-full min-w-0 flex-wrap justify-start gap-x-2 gap-y-0.5 py-1.5 text-xs text-muted-foreground"
            aria-label={`${label} activity · ${activity.length} actions`}
            aria-describedby={
              pendingResultCount > 0 || attentionCount > 0 ? statusSummaryId : undefined
            }
            aria-expanded={activityOpen}
            onClick={() => setActivityOpen((current) => !current)}
          >
            <span className="flex w-full min-w-0 items-center gap-2">
              {activityOpen ? (
                <ChevronDownIcon className="size-3 shrink-0" />
              ) : (
                <ChevronRightIcon className="size-3 shrink-0" />
              )}
              <span className="shrink-0">
                {label} · {activity.length}
              </span>
              <span className="min-w-0 truncate text-left">
                {latestModel.statusLabel} · {latestModel.actionLabel} · {latestModel.targetLabel}
              </span>
              <span className="ml-auto shrink-0">{formatRelativeTimeLabel(latest.updatedAt)}</span>
            </span>
            {pendingResultCount > 0 || attentionCount > 0 ? (
              <span
                id={statusSummaryId}
                className="flex w-full flex-wrap gap-x-2 pl-5 text-left whitespace-normal"
              >
                {pendingResultCount > 0 ? (
                  <span>
                    {pendingResultCount} child result{pendingResultCount === 1 ? "" : "s"} pending
                  </span>
                ) : null}
                {attentionCount > 0 ? (
                  <span className="text-destructive">
                    {attentionCount} {attentionCount === 1 ? "needs" : "need"} attention
                  </span>
                ) : null}
              </span>
            ) : null}
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
