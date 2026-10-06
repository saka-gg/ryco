import { ORCHESTRATION_WS_METHODS, type EnvironmentId } from "@ryco/contracts";

import { useEnvironmentSettingsTarget } from "../../../hooks/useEnvironmentSettingsTarget";
import { useHostedRpcCapability } from "../../../hostedHub/capabilities";
import { useEnvironmentPresence } from "../useEnvironmentPresence";

export interface ProjectEditAccess {
  /** Project writes (`project.*` commands, scripts, threads, worktrees) can run. */
  readonly canEdit: boolean;
  /** Why not, stated once by the page. */
  readonly reason: string | null;
  /**
   * The device's own settings for this project (new-thread defaults, worktree
   * root and submodules, Atlassian link) can change: they need the owner.
   */
  readonly canManageNode: boolean;
  /** Why only the node settings are out of reach, when project writes are fine. */
  readonly nodeReason: string | null;
}

/**
 * Whether this client can change a checkout right now, and why not. One
 * answer per checkout, so the page states the reason once instead of
 * on every disabled control: the hosted capability, this client's role on the
 * device (a Hub viewer can look, not change), then whether the device is live.
 */
export function useProjectEditAccess(environmentId: EnvironmentId): ProjectEditAccess {
  const dispatchCapability = useHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand);
  const presence = useEnvironmentPresence(environmentId);
  const { target } = useEnvironmentSettingsTarget(environmentId);
  const where = presence.isPrimary ? "this device" : presence.label;
  const readOnly = (reason: string): ProjectEditAccess => ({
    canEdit: false,
    reason,
    canManageNode: false,
    nodeReason: null,
  });
  if (!dispatchCapability.allowed) {
    return readOnly(dispatchCapability.reason ?? "Your access to this device is read-only.");
  }
  if (target && target.canMutate === false) {
    return readOnly(`Your access to ${where} is view-only.`);
  }
  switch (presence.status) {
    case "connecting":
      return readOnly(`Connecting to ${presence.label}…`);
    case "cached":
      return readOnly(
        `${presence.isPrimary ? "This device" : presence.label} is offline. This is a cached copy; changes need a live connection.`,
      );
    case "offline":
      return readOnly(
        `${presence.isPrimary ? "This device" : presence.label} is offline. Reconnect it to make changes.`,
      );
    case "online":
      break;
  }
  const canManageNode = target?.canManage === true;
  return {
    canEdit: true,
    reason: null,
    canManageNode,
    nodeReason: canManageNode
      ? null
      : `Only the owner of ${where} can change new-thread defaults, worktree settings and the Atlassian link.`,
  };
}
