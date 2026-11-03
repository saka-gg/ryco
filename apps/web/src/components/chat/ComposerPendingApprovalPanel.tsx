import type { ApprovalRequestId } from "@ryco/contracts";
import { APPROVAL_REASON_LABEL, pendingApprovalReason } from "@ryco/client-runtime/state/session";
import { memo, useState } from "react";
import { type PendingApproval } from "../../session-logic";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { DisclosureRegion } from "../ui/DisclosureRegion";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
  /** Offer the provider's reason for asking as a disclosure (off on the frozen phone tier). */
  showReason?: boolean;
}

/** Bounded approval summary, shared with the approval card's live region. */
export function pendingApprovalSummaryLabel(approval: PendingApproval): string {
  return approval.requestKind === "command"
    ? "Command approval requested"
    : approval.requestKind === "file-read"
      ? "File-read approval requested"
      : "File-change approval requested";
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
  showReason = false,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary = pendingApprovalSummaryLabel(approval);
  const reason = showReason ? pendingApprovalReason(approval) : null;
  // Keyed by request so the next approval starts collapsed.
  const [reasonOpenFor, setReasonOpenFor] = useState<ApprovalRequestId | null>(null);
  const reasonOpen = reasonOpenFor === approval.requestId;

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.responseState === "submitting" || approval.responseState === "uncertain" ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          {approval.responseState === "uncertain"
            ? "Delivery outcome is unknown. Waiting for provider settlement; do not resend."
            : "Decision submitted. Waiting for provider settlement."}
        </p>
      ) : null}
      {approval.detail ? (
        <div
          data-testid="pending-approval-detail"
          className="mt-2 max-h-[min(10rem,20dvh)] min-h-0 overflow-y-auto overscroll-contain whitespace-pre-wrap wrap-break-word text-sm text-muted-foreground select-text"
        >
          {approval.detail}
        </div>
      ) : null}
      {reason ? (
        <div className="mt-2">
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={reasonOpen}
            onClick={() => setReasonOpenFor(reasonOpen ? null : approval.requestId)}
          >
            <DisclosureChevron open={reasonOpen} className="size-3.5" />
            {APPROVAL_REASON_LABEL}
          </button>
          <DisclosureRegion open={reasonOpen}>
            <p className="pt-1 pl-4.5 whitespace-pre-wrap wrap-break-word text-sm text-muted-foreground select-text">
              {reason}
            </p>
          </DisclosureRegion>
        </div>
      ) : null}
    </div>
  );
});
