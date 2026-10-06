import { useAtomValue } from "@effect/atom-react";
import { serverConfigAtom } from "@ryco/client-runtime/rpc";
import {
  WS_METHODS,
  type DesktopWorkspaceMachineProjection,
  type EnvironmentId,
} from "@ryco/contracts";

import {
  hostedSettingsRoleFresh,
  hostedSettingsRoleSnapshot,
  type HostedSettingsRole,
} from "../components/settings/settingsSections.logic";
import { useDeviceName } from "../deviceName";
import { isHostedHubMode } from "../env";
import { usePrimaryEnvironmentDescriptor } from "../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import { useHostedHubStore } from "../hostedHub/state";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";
import type { SettingsTarget } from "../settingsTarget";

export interface EnvironmentSettingsTargetState {
  /**
   * The node whose settings an editor reads and writes, with `canManage`
   * already folded with the hosted role and capability. Null when no
   * environment is named.
   */
  readonly target: SettingsTarget | null;
  readonly isPrimary: boolean;
  /** The role this client holds on the node (null while unknown or untrusted). */
  readonly nodeRole: HostedSettingsRole;
  /** Hosted only: the role snapshot is current. Always true outside hosted mode. */
  readonly roleFresh: boolean;
  /** The Hub machine record behind the node, on desktop with a Hub sign-in. */
  readonly desktopWorkspaceMachine: DesktopWorkspaceMachineProjection | null;
}

/**
 * Builds the `SettingsTarget` for one environment: its config, label, and
 * whether this client may change its node-owned settings. The settings page
 * and the projects page share it, so node-settings authorization has exactly
 * one definition (hosted role freshness, desktop Hub machine access, saved
 * environment roles).
 *
 * Reads the primary config straight from its atom, so the result does not
 * depend on whether the caller is inside another `SettingsTargetProvider`.
 */
export function useEnvironmentSettingsTarget(
  environmentId: EnvironmentId | null,
): EnvironmentSettingsTargetState {
  const hosted = isHostedHubMode();
  const primaryEnvironment = usePrimaryEnvironmentDescriptor();
  const primaryServerConfig = useAtomValue(serverConfigAtom);
  const desktopWorkspace = useDesktopWorkspaceState();
  const nodeWriteCapability = useHostedRpcCapability(WS_METHODS.serverUpdateSettings);
  const savedEnvironment = useSavedEnvironmentRegistryStore((state) =>
    environmentId ? (state.byId[environmentId] ?? null) : null,
  );
  const savedEnvironmentRuntime = useSavedEnvironmentRuntimeStore((state) =>
    environmentId ? (state.byId[environmentId] ?? null) : null,
  );
  const isPrimary = environmentId !== null && environmentId === primaryEnvironment?.environmentId;
  const desktopWorkspaceMachine = environmentId
    ? (desktopWorkspace.machines.find((machine) => machine.environmentId === environmentId) ?? null)
    : null;
  const serverConfig = isPrimary
    ? primaryServerConfig
    : (savedEnvironmentRuntime?.serverConfig ?? null);
  const nodeLabel = useDeviceName(
    environmentId,
    isPrimary
      ? (primaryEnvironment?.label ?? serverConfig?.environment.label)
      : (savedEnvironmentRuntime?.descriptor?.label ??
          serverConfig?.environment.label ??
          savedEnvironment?.label),
  );
  const remoteRole: HostedSettingsRole = desktopWorkspaceMachine
    ? desktopWorkspaceMachine.canConnect
      ? desktopWorkspaceMachine.effectiveRole
      : null
    : savedEnvironmentRuntime?.role === "owner"
      ? "owner"
      : savedEnvironmentRuntime?.role
        ? "viewer"
        : null;
  const hostedRole = useHostedHubStore((state) => state.effectiveRole);
  const hostedDirectoryStatus = useHostedHubStore((state) => state.directoryStatus);
  const hostedTransportStatus = useHostedHubStore((state) => state.transportStatus);
  const roleFresh = hosted
    ? hostedSettingsRoleFresh(hostedDirectoryStatus, hostedTransportStatus)
    : true;
  const role = hostedSettingsRoleSnapshot(hostedRole, hostedDirectoryStatus, hostedTransportStatus);
  const nodeRole: HostedSettingsRole = hosted ? role : isPrimary ? "owner" : remoteRole;

  if (!environmentId) {
    return { target: null, isPrimary, nodeRole, roleFresh, desktopWorkspaceMachine };
  }
  const connected =
    serverConfig !== null &&
    (isPrimary ||
      savedEnvironmentRuntime?.connectionState === "connected" ||
      desktopWorkspaceMachine?.connectionState === "connected");
  const canManageUnauthorized = isPrimary ? !hosted : remoteRole === "owner";
  const target: SettingsTarget = {
    environmentId,
    nodeLabel,
    serverConfig,
    primary: isPrimary,
    canManage:
      connected &&
      (hosted
        ? role === "owner" && roleFresh && nodeWriteCapability.allowed
        : canManageUnauthorized),
    canMutate:
      isPrimary ||
      (desktopWorkspaceMachine
        ? desktopWorkspaceMachine.canMutate
        : savedEnvironmentRuntime?.role === "owner" || savedEnvironmentRuntime?.role === "client"),
    connected,
  };
  return { target, isPrimary, nodeRole, roleFresh, desktopWorkspaceMachine };
}
