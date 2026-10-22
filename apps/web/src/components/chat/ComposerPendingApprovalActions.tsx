import type { ApprovalResponseIdentity, EnvironmentId } from "@ryco/contracts";
import {
  ORCHESTRATION_WS_METHODS,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
} from "@ryco/contracts";
import { memo } from "react";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedHubStore } from "../../hostedHub/state";
import { hostedCapabilityCopy, hostedSwitchTargetLabel } from "../../hostedHub/switchTarget";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  /** The environment the approval belongs to; `null` for the routed node. */
  environmentId: EnvironmentId | null;
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
  environmentId,
  requestId,
  approvalIdentity,
  isResponding,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  // An approval decision reaches the node at once or not at all: it is never
  // queued, so it waits disabled while the connection is not ready.
  const capability = useHostedRpcCapability(
    ORCHESTRATION_WS_METHODS.dispatchCommand,
    environmentId,
  );
  const label = useHostedHubStore((state) => hostedSwitchTargetLabel(state, environmentId));
  const unavailableReason = capability.allowed ? null : hostedCapabilityCopy(capability, label);
  const disabled = isResponding || !capability.allowed;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        title={unavailableReason ?? undefined}
        onClick={() => void onRespondToApproval(requestId, "cancel", approvalIdentity)}
      >
        Cancel turn
      </Button>
      <Button
        size="sm"
        variant="destructive-outline"
        disabled={disabled}
        title={unavailableReason ?? undefined}
        onClick={() => void onRespondToApproval(requestId, "decline", approvalIdentity)}
      >
        Decline
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        title={unavailableReason ?? undefined}
        onClick={() => void onRespondToApproval(requestId, "acceptForSession", approvalIdentity)}
      >
        Always allow this session
      </Button>
      <Button
        size="sm"
        variant="default"
        disabled={disabled}
        title={unavailableReason ?? undefined}
        onClick={() => void onRespondToApproval(requestId, "accept", approvalIdentity)}
      >
        Approve once
      </Button>
    </>
  );
});
