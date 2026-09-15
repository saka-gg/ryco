import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
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
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary = pendingApprovalSummaryLabel(approval);

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
    </div>
  );
});
