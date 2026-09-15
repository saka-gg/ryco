import { memo, useState } from "react";
import type { ApprovalRequestId, ProviderApprovalDecision } from "@ryco/contracts";
import { ExpandIcon } from "lucide-react";

import { type PendingApproval } from "../../session-logic";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { Button } from "../ui/button";
import {
  MobileSheet,
  MobileSheetDescription,
  MobileSheetFooter,
  MobileSheetHeader,
  MobileSheetPanel,
  MobileSheetTitle,
} from "../mobile/MobileSheet";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import {
  ComposerPendingApprovalPanel,
  pendingApprovalSummaryLabel,
} from "./ComposerPendingApprovalPanel";

interface ApprovalCardProps {
  approval: PendingApproval;
  pendingCount: number;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

/**
 * The dedicated approval card: scrollable, wrap-safe approval detail plus the
 * single action set, rendered above the composer input on every tier. On the
 * phone tier long detail expands into a bottom sheet pinned above the
 * keyboard inset; while the sheet is open the action set moves into the sheet
 * footer so exactly one set is ever rendered. Arrival is announced through an
 * assertive live region with the bounded summary only. Approval semantics,
 * stores, and capability gating are untouched — this component only composes
 * the existing panel and actions.
 */
export const ApprovalCard = memo(function ApprovalCard({
  approval,
  pendingCount,
  isResponding,
  onRespondToApproval,
}: ApprovalCardProps) {
  const tier = usePresentationTier();
  // Keyed by request id so the expanded sheet never persists across
  // approvals; leaving the phone tier discards it as well, so a tier round
  // trip does not silently reopen it.
  const [expandedRequestId, setExpandedRequestId] = useState<ApprovalRequestId | null>(null);
  const sheetOpen = tier === "phone" && expandedRequestId === approval.requestId;
  if (tier !== "phone" && expandedRequestId !== null) {
    setExpandedRequestId(null);
  }

  const actions = (
    <ComposerPendingApprovalActions
      requestId={approval.requestId}
      approvalIdentity={approval.approvalIdentity}
      isResponding={
        isResponding ||
        (approval.responseState !== undefined && approval.responseState !== "retryable")
      }
      onRespondToApproval={onRespondToApproval}
    />
  );

  return (
    <div data-testid="approval-card">
      {/* Assertive announcement of arrival; bounded summary only. */}
      <p role="alert" className="sr-only">
        {pendingApprovalSummaryLabel(approval)}
      </p>
      <ComposerPendingApprovalPanel approval={approval} pendingCount={pendingCount} />
      {tier === "phone" && approval.detail ? (
        <div className="px-4 pb-1 sm:px-5">
          <Button
            size="sm"
            variant="ghost"
            className="min-h-11 text-muted-foreground"
            onClick={() => setExpandedRequestId(approval.requestId)}
          >
            <ExpandIcon aria-hidden /> Show full detail
          </Button>
        </div>
      ) : null}
      {sheetOpen ? null : (
        <div
          data-testid="approval-card-actions"
          className="flex flex-wrap items-center justify-end gap-2 px-3 pb-3 sm:px-4"
        >
          {actions}
        </div>
      )}
      <MobileSheet
        open={sheetOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setExpandedRequestId(null);
        }}
        label="Approval detail"
      >
        <MobileSheetHeader>
          <MobileSheetTitle>{pendingApprovalSummaryLabel(approval)}</MobileSheetTitle>
          {pendingCount > 1 ? (
            <MobileSheetDescription>1/{pendingCount} pending approvals</MobileSheetDescription>
          ) : (
            <MobileSheetDescription className="sr-only">
              Full approval detail
            </MobileSheetDescription>
          )}
        </MobileSheetHeader>
        <MobileSheetPanel>
          <div className="whitespace-pre-wrap wrap-break-word text-sm text-muted-foreground select-text">
            {approval.detail}
          </div>
        </MobileSheetPanel>
        <MobileSheetFooter
          className="flex-row flex-wrap justify-end gap-2"
          data-testid="approval-card-actions"
        >
          {actions}
        </MobileSheetFooter>
      </MobileSheet>
    </div>
  );
});
