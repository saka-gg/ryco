import type { ApprovalResponseIdentity, EnvironmentId } from "@ryco/contracts";
import {
  ORCHESTRATION_WS_METHODS,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
} from "@ryco/contracts";
import { EllipsisIcon } from "lucide-react";
import { memo } from "react";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { useHostedHubStore } from "../../hostedHub/state";
import { hostedCapabilityCopy, hostedSwitchTargetLabel } from "../../hostedHub/switchTarget";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";

interface ComposerPendingApprovalActionsProps {
  /** The environment the approval belongs to; `null` for the routed node. */
  environmentId: EnvironmentId | null;
  requestId: ApprovalRequestId;
  approvalIdentity?: ApprovalResponseIdentity | undefined;
  isResponding: boolean;
  /**
   * `compact`: Decline and Approve once, with the session-wide grant and Cancel turn in a menu.
   * `inline`: all four as buttons (the frozen phone tier).
   */
  layout: "compact" | "inline";
  /**
   * The provider allows "Always allow this session" for this request. The frozen inline layout
   * keeps its four buttons; the node answers a refused session grant as one approval.
   */
  acceptForSessionOffered: boolean;
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
  layout,
  acceptForSessionOffered,
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
  const respond = (decision: ProviderApprovalDecision) =>
    void onRespondToApproval(requestId, decision, approvalIdentity);
  const decline = (
    <Button
      size="sm"
      variant="destructive-outline"
      disabled={disabled}
      title={unavailableReason ?? undefined}
      onClick={() => respond("decline")}
    >
      Decline
    </Button>
  );
  const approve = (
    <Button
      size="sm"
      variant="default"
      disabled={disabled}
      title={unavailableReason ?? undefined}
      onClick={() => respond("accept")}
    >
      Approve once
    </Button>
  );

  if (layout === "compact") {
    return (
      <>
        {decline}
        {approve}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="More approval actions"
                disabled={disabled}
                title={unavailableReason ?? undefined}
              />
            }
          >
            <EllipsisIcon aria-hidden="true" className="size-4" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            {acceptForSessionOffered ? (
              <MenuItem disabled={disabled} onClick={() => respond("acceptForSession")}>
                Always allow this session
              </MenuItem>
            ) : null}
            <MenuItem variant="destructive" disabled={disabled} onClick={() => respond("cancel")}>
              Cancel turn
            </MenuItem>
          </MenuPopup>
        </Menu>
      </>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        title={unavailableReason ?? undefined}
        onClick={() => respond("cancel")}
      >
        Cancel turn
      </Button>
      {decline}
      <Button
        size="sm"
        variant="outline"
        disabled={disabled}
        title={unavailableReason ?? undefined}
        onClick={() => respond("acceptForSession")}
      >
        Always allow this session
      </Button>
      {approve}
    </>
  );
});
