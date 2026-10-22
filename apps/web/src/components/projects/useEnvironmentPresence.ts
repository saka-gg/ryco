import type { EnvironmentId } from "@ryco/contracts";
import { useSyncExternalStore } from "react";

import { useDeviceName } from "../../deviceName";
import { isHostedHubMode } from "../../env";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useHostedWorkspaceState } from "../../hostedHub/hostedConnectionCoordinator";
import { getRoutedHostedNode, subscribeRoutedHostedNode } from "../../hostedHub/nodeRoutes";
import { useHostedHubStore } from "../../hostedHub/state";
import { useHostedSwitchTarget } from "../../hostedHub/switchTarget";
import { useDesktopWorkspaceState } from "../../platform/desktopWorkspace";
import {
  selectBootstrapCompleteForEnvironment,
  selectEnvironmentState,
  useStore,
} from "../../store";
import {
  classifyEnvironmentPresence,
  classifyHostedNodePresence,
  isThisDevice,
  type EnvironmentPresenceStatus,
} from "./projectsModel.logic";

export type { EnvironmentPresenceStatus };

export interface EnvironmentPresence {
  readonly environmentId: EnvironmentId;
  readonly isPrimary: boolean;
  /** "This device" for the primary environment, else its device name. */
  readonly label: string;
  readonly status: EnvironmentPresenceStatus;
}

const readNoRoutedNodeId = () => null;

/**
 * Whether this browser is, or is about to be, connected to the hosted node:
 * it is the selection, or the node the route is opening. Any other node is
 * only reachable, not being connected.
 */
function useHostedConnectionTarget(environmentId: EnvironmentId): boolean {
  const routedNodeId = useSyncExternalStore(
    subscribeRoutedHostedNode,
    () => getRoutedHostedNode().nodeId,
    readNoRoutedNodeId,
  );
  return useHostedHubStore(
    (state) =>
      state.selectedNode?.environmentId === environmentId ||
      (routedNodeId !== null &&
        state.nodes.some(
          (node) => node.id === routedNodeId && node.environmentId === environmentId,
        )),
  );
}

/** Live reachability and label for one environment (one device). */
export function useEnvironmentPresence(environmentId: EnvironmentId): EnvironmentPresence {
  const hosted = isHostedHubMode();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimary = isThisDevice({ hosted, environmentId, primaryEnvironmentId });
  const bootstrapComplete = useStore((state) =>
    selectBootstrapCompleteForEnvironment(state, environmentId),
  );
  const hydratedFromCache = useStore(
    (state) => selectEnvironmentState(state, environmentId).hydratedFromCacheAt !== undefined,
  );
  const savedRecord = useSavedEnvironmentRegistryStore(
    (state) => state.byId?.[environmentId] ?? null,
  );
  const savedRuntime = useSavedEnvironmentRuntimeStore(
    (state) => state.byId?.[environmentId] ?? null,
  );
  // Desktop Hub machines connect outside the saved-environment registry.
  const desktopMachine = useDesktopWorkspaceState().machines.find(
    (machine) => machine.environmentId === environmentId,
  );
  const hostedMachine = useHostedWorkspaceState().machines.find(
    (machine) => machine.environmentId === environmentId,
  );
  const hostedConnectionTarget = useHostedConnectionTarget(environmentId);
  const hostedPhase = useHostedSwitchTarget(environmentId).kind;
  const deviceName = useDeviceName(
    environmentId,
    savedRuntime?.descriptor?.label ??
      savedRecord?.label ??
      desktopMachine?.label ??
      hostedMachine?.label ??
      null,
  );
  return {
    environmentId,
    isPrimary,
    label: isPrimary ? "This device" : deviceName,
    status:
      hosted && hostedMachine
        ? classifyHostedNodePresence({
            online: hostedMachine.presence.online,
            connected: hostedMachine.connectionState === "connected",
            establishing: hostedConnectionTarget && hostedPhase === "establishing",
            hasShell: bootstrapComplete || hydratedFromCache,
          })
        : classifyEnvironmentPresence({
            isPrimary,
            bootstrapComplete,
            hydratedFromCache,
            connectionState:
              savedRuntime?.connectionState ?? desktopMachine?.connectionState ?? null,
            disconnectedAt:
              savedRuntime?.disconnectedAt ??
              (desktopMachine && !desktopMachine.online ? "offline" : null),
          }),
  };
}
