import { memo, useState } from "react";
import type { EnvironmentId } from "@ryco/contracts";

import { formatExpiresInLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type {
  AgentControlProposalCardModel,
  AgentControlStatusTone,
} from "@ryco/client-runtime/state/agentControl";

const TONE_BADGE_VARIANT: Record<
  AgentControlStatusTone,
  "warning" | "info" | "success" | "error" | "secondary"
> = {
  pending: "warning",
  info: "info",
  success: "success",
  danger: "error",
  muted: "secondary",
};

export interface AgentControlProposalCardProps {
  readonly model: AgentControlProposalCardModel;
  readonly environmentId: EnvironmentId;
  readonly isSubmitting: boolean;
  readonly decisionError: string | null;
  /** Non-null when decisions are unavailable (e.g. hosted role too low). */
  readonly disabledReason: string | null;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}

/**
 * One Agent Control proposal: origin, exact action and target, risk,
 * runtime conditions, expiry, and terminal outcome. Shows the audit-safe
 * summary by default; the full plan (including prompt text) renders only
 * after deliberate expansion. Decisions are explicit buttons that disable
 * while a decision is in flight.
 */
export const AgentControlProposalCard = memo(function AgentControlProposalCard({
  model,
  environmentId,
  isSubmitting,
  decisionError,
  disabledReason,
  onAccept,
  onReject,
}: AgentControlProposalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const decisionsDisabled = isSubmitting || disabledReason !== null;

  return (
    <div
      data-testid="agent-control-proposal-card"
      className={`mb-2 rounded-lg border bg-muted/20 ${
        model.isDestructive || model.warningLabel !== null
          ? "border-destructive/70"
          : "border-border/60"
      }`}
    >
      <div className="px-3 pt-2.5 sm:px-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
            Agent Control
          </span>
          <Badge size="sm" variant={TONE_BADGE_VARIANT[model.statusTone]}>
            {model.statusLabel}
          </Badge>
          {model.isPending ? (
            <span className="text-xs text-muted-foreground">
              {formatExpiresInLabel(model.expiresAt)}
            </span>
          ) : null}
          {model.isDestructive ? (
            <Badge size="sm" variant="error">
              Destructive · Ryco records only
            </Badge>
          ) : null}
          {model.warningLabel !== null ? (
            <Badge size="sm" variant="error">
              {model.warningLabel}
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-sm font-medium text-foreground">
          {model.actionLabel} · {model.targetLabel}
        </p>
        <p className="text-xs text-muted-foreground">
          {model.originLabel}
          {model.runtimeLabel !== null ? ` · ${model.runtimeLabel}` : null}
        </p>
        {model.summary !== null ? (
          <p className="mt-1 text-sm text-muted-foreground">{model.summary}</p>
        ) : null}
        {model.riskLabels.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {model.riskLabels.map((risk) => (
              <Badge key={risk} size="sm" variant="outline">
                {risk}
              </Badge>
            ))}
          </div>
        ) : null}
        {model.outcomeLabel !== null ? (
          <p className="mt-1 text-xs text-muted-foreground">{model.outcomeLabel}</p>
        ) : null}
        {model.executionLabel !== null ? (
          <p className="mt-1 text-xs text-muted-foreground">{model.executionLabel}</p>
        ) : null}
        {model.completionReturns?.map((result) => (
          <div
            key={result.childThreadId}
            className="mt-2 border-l-2 border-border pl-2 text-xs"
            data-testid="completion-return-status"
          >
            <p className="font-medium">Completion return · {result.status}</p>
            <p className="text-muted-foreground">{result.detail}</p>
            <a
              className="underline"
              href={`/${encodeURIComponent(environmentId)}/${encodeURIComponent(result.childThreadId)}`}
            >
              Open child task
            </a>
            {" · "}
            <a
              className="underline"
              href={`/${encodeURIComponent(environmentId)}/${encodeURIComponent(result.parentThreadId)}`}
            >
              Open originating chat
            </a>
          </div>
        ))}
        {model.affectedThreadIds.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs">
            {model.affectedThreadIds.map((threadId) => (
              <a
                key={threadId}
                className="text-primary underline-offset-2 hover:underline"
                href={`/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`}
              >
                Open thread {threadId.length > 10 ? `${threadId.slice(0, 8)}…` : threadId}
              </a>
            ))}
          </div>
        ) : null}
        {model.affectedProjectIds.length > 0 ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Project{model.affectedProjectIds.length === 1 ? "" : "s"}:{" "}
            {model.affectedProjectIds.join(", ")}
          </p>
        ) : null}
        {decisionError !== null ? (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {decisionError}
          </p>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          className="mt-1 -ml-2 text-muted-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Hide plan details" : "Show plan details"}
        </Button>
        {expanded ? (
          <div
            data-testid="agent-control-proposal-detail"
            className="mt-1 max-h-[min(14rem,30dvh)] overflow-y-auto overscroll-contain rounded-md border border-border/50 bg-background/60 px-3 py-2"
          >
            {model.detailSections.map((section) => (
              <div key={section.heading} className="mb-2 last:mb-0">
                <p className="text-xs font-medium text-foreground">{section.heading}</p>
                {section.lines.map((line, index) => (
                  <p
                    // Lines are positional fragments of one immutable plan.
                    // eslint-disable-next-line react/no-array-index-key
                    key={index}
                    className="whitespace-pre-wrap wrap-break-word text-xs text-muted-foreground select-text"
                  >
                    {line}
                  </p>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {model.isPending ? (
        <div
          data-testid="agent-control-proposal-actions"
          className="flex flex-wrap items-center justify-end gap-2 px-3 pt-2 pb-3 sm:px-4"
        >
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={decisionsDisabled}
            title={disabledReason ?? undefined}
            onClick={onReject}
          >
            Reject
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={decisionsDisabled}
            title={disabledReason ?? undefined}
            onClick={onAccept}
          >
            Approve
          </Button>
        </div>
      ) : (
        <div aria-hidden className="pb-2.5" />
      )}
    </div>
  );
});
