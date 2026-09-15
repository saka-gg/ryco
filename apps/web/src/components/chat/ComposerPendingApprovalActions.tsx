import type { ApprovalResponseIdentity } from "@ryco/contracts";
import {
  ORCHESTRATION_WS_METHODS,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
} from "@ryco/contracts";
import { memo } from "react";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  approvalIdentity?: ApprovalResponseIdentity | undefined;
  isResponding: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
    approvalIdentity?: ApprovalResponseIdentity,
  ) => Promise<void>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  approvalIdentity,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const capability = useHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand);
  const disabled = isResponding || !capability.allowed;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        title={capability.reason ?? undefined}
        onClick={() => void onRespondToApproval(requestId, "cancel", approvalIdentity)}
      >
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={disabled}
        title={capability.reason ?? undefined}
        onClick={() => void onRespondToApproval(requestId, "decline", approvalIdentity)}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        title={capability.reason ?? undefined}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession", approvalIdentity)}
      >
        Always allow this session
      </Button>
      <Button
        size="sm"
        variant="default"
        disabled={disabled}
        title={capability.reason ?? undefined}
        onClick={() => void onRespondToApproval(requestId, "accept", approvalIdentity)}
      >
        Approve once
      </Button>
    </>
  );
});
