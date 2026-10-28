import { useShallow } from "zustand/react/shallow";

import { getWsConnectionUiState } from "@ryco/client-runtime/rpc";
import type { SavedEnvironmentConnectionState } from "@ryco/client-runtime/connection";

import { useWsConnectionStatus } from "../rpc/wsConnectionState";
import { savedEnvironmentUiState } from "../features/connection/connectionRows";
import { useSavedEnvironmentSnapshots } from "../features/connection/useSavedEnvironmentSnapshots";
import {
  hostedState,
  selectShellCurrentByEnvironmentId,
} from "../features/home/homeEnvironmentModel";
import { useMobileHostedConnectionsStore } from "../hostedHub/state";
import {
  hostedWorkspacePhase,
  deriveWorkspaceShellSummary,
  mergeWorkspaceEnvironments,
  projectWorkspaceState,
  type EnvironmentConnectionPhase,
  type NetworkStatus,
  type WorkspaceEnvironment,
  type WorkspaceState,
} from "./workspaceModel";
import { useStore } from "./threadsRuntime";

// §3-1: synthesize the WorkspaceState upstream read from the atom `state/workspace`
// from runtime A's building blocks — the saved-environment catalog stores, the
// per-environment ws status slots, and the active-environment bootstrap flag.
// Saved environments multi-connect, so each environment's reconnecting overlay
// comes from its own slot; only the device-level online/offline signal is global.

function mapConnectionPhase(state: SavedEnvironmentConnectionState): EnvironmentConnectionPhase {
  switch (state) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting";
    case "error":
      return "error";
    case "disconnected":
      return "offline";
  }
}

export function useWorkspaceState(): WorkspaceState {
  const { records, runtimeById, statuses, hydrated: isReady } = useSavedEnvironmentSnapshots();
  const wsStatus = useWsConnectionStatus();
  // A flat per-environment flag compared shallowly: `environmentStateById`
  // gets a new identity on every streamed shell or orchestration event, and
  // subscribing to it re-rendered every consumer of the workspace state.
  const shellCurrentByEnvironmentId = useStore(useShallow(selectShellCurrentByEnvironmentId));
  const hostedConnections = useMobileHostedConnectionsStore(
    useShallow((state) => state.selectedNodes),
  );

  const wsUiState = getWsConnectionUiState(wsStatus);
  const networkStatus: NetworkStatus = wsUiState === "offline" ? "offline" : "online";

  const environments: WorkspaceEnvironment[] = Object.values(records).map((record) => {
    const runtime = runtimeById[record.environmentId];
    const basePhase: EnvironmentConnectionPhase = runtime
      ? mapConnectionPhase(runtime.connectionState)
      : "available";
    // Each environment's own socket drives its reconnecting overlay — one
    // flapping node must not mark every other node as reconnecting.
    const environmentUiState = savedEnvironmentUiState(statuses, record.environmentId);
    const phase: EnvironmentConnectionPhase =
      environmentUiState === "reconnecting" && basePhase !== "connected"
        ? "reconnecting"
        : basePhase;
    return {
      environmentId: record.environmentId,
      environmentLabel: record.label,
      connectionState: phase,
      connectionError: runtime?.lastError ?? null,
    };
  });

  // The hosted plane keeps its own stores and never writes to the catalog above,
  // so without this the workspace sees no environments at all on a Hub-relay-only
  // setup and reports "Not connected" over a live relay.
  const hostedEnvironments: WorkspaceEnvironment[] = hostedConnections.map((hosted) => ({
    environmentId: hosted.environmentId,
    environmentLabel: hosted.label,
    connectionState: hostedWorkspacePhase(
      hostedState({
        environmentId: hosted.environmentId,
        label: hosted.label,
        transportStatus: hosted.transportStatus,
        sessionStatus: hosted.sessionStatus,
        role: hosted.effectiveRole,
      }),
    ),
    connectionError: null,
  }));
  const allEnvironments = mergeWorkspaceEnvironments(environments, hostedEnvironments);
  const shellSummary = deriveWorkspaceShellSummary(
    allEnvironments,
    (environmentId) => shellCurrentByEnvironmentId[environmentId] ?? false,
  );

  return projectWorkspaceState({
    isReady,
    networkStatus,
    environments: allEnvironments,
    shellSummary,
  });
}
