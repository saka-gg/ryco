import {
  markNodeSwitchIntent,
  markNodeSwitchPhase,
  setNodeSwitchContext,
  type NodeSwitchPhase,
} from "../perf/nodeSwitchInstrumentation";
import { isWebHubServerAuthenticatedRelayAvailable } from "./hubSession";
import { getRoutedHostedNode, subscribeRoutedHostedNode } from "./nodeRoutes";
import { hostedHubStore, type HostedHubState } from "./state";
import type { HostedRelayTransportStatus } from "./types";

/**
 * Node-switch telemetry for the hosted workspace.
 *
 * Observes the routed node and the hosted store and records the phases of each
 * switch through `nodeSwitchInstrumentation`. It only reads: it never selects,
 * retries or releases a node, so the hosted controller stays the single
 * lifecycle owner. The per-patch path compares a few primitives and allocates
 * nothing.
 */

export { markNodeSwitchIntent };

function transportPhase(status: HostedRelayTransportStatus): NodeSwitchPhase | null {
  switch (status) {
    case "requesting-ticket":
    case "connecting":
    case "authenticating":
    case "opening-channel":
    case "online":
      return status;
    default:
      return null;
  }
}

function environmentIdForNode(state: HostedHubState, nodeId: string): string | null {
  for (const node of state.nodes) {
    if (node.id === nodeId) return node.environmentId;
  }
  return null;
}

let installed: (() => void) | null = null;

/**
 * Starts observing. Idempotent: a second call returns the first call's
 * disposer and adds no subscription.
 */
export function installNodeSwitchTelemetry(): () => void {
  if (installed !== null) return installed;

  let routedNodeId = getRoutedHostedNode().nodeId;
  // A routed node the directory does not list yet; its switch starts when the
  // directory lists it, measured from then.
  let pendingNodeId: string | null = null;
  const initial = hostedHubStore.getState();
  let lastTransportStatus = initial.transportStatus;
  let lastSessionEstablished = initial.sessionEstablished;

  const beginSwitch = (state: HostedHubState, environmentId: string): void => {
    markNodeSwitchIntent(environmentId, "route");
    markNodeSwitchPhase("route", environmentId);
    setNodeSwitchContext({
      hubSessionVersion: isWebHubServerAuthenticatedRelayAvailable() ? 2 : 1,
      warm:
        state.selectedNode?.environmentId === environmentId &&
        state.transportStatus === "online" &&
        state.sessionEstablished,
    });
    // The node may already be selected and ready, in which case no store
    // patch follows.
    observeStore(state);
  };

  const observeStore = (state: HostedHubState): void => {
    if (pendingNodeId !== null) {
      const pendingEnvironmentId = environmentIdForNode(state, pendingNodeId);
      if (pendingEnvironmentId !== null) {
        pendingNodeId = null;
        beginSwitch(state, pendingEnvironmentId);
      }
    }
    const transportStatus = state.transportStatus;
    const sessionEstablished = state.sessionEstablished;
    const environmentId = state.selectedNode?.environmentId;
    if (environmentId !== undefined) {
      if (transportStatus !== lastTransportStatus) {
        const phase = transportPhase(transportStatus);
        if (phase !== null) markNodeSwitchPhase(phase, environmentId);
      }
      if (sessionEstablished && !lastSessionEstablished) {
        markNodeSwitchPhase("shell-accepted", environmentId);
      }
      // Level-triggered so a selection that lands on an already-ready state
      // (a warm switch) is still seen; the first mark per switch wins.
      if (
        transportStatus === "online" &&
        state.sessionStatus === "ready" &&
        state.browserStatus === "current"
      ) {
        markNodeSwitchPhase("mutation-ready", environmentId);
      }
    }
    lastTransportStatus = transportStatus;
    lastSessionEstablished = sessionEstablished;
  };

  const onRoute = (): void => {
    const nodeId = getRoutedHostedNode().nodeId;
    if (nodeId === routedNodeId) return;
    routedNodeId = nodeId;
    pendingNodeId = null;
    if (nodeId === null) return;
    const state = hostedHubStore.getState();
    const environmentId = environmentIdForNode(state, nodeId);
    if (environmentId === null) {
      pendingNodeId = nodeId;
      return;
    }
    beginSwitch(state, environmentId);
  };

  const unsubscribeRoute = subscribeRoutedHostedNode(onRoute);
  const unsubscribeStore = hostedHubStore.subscribe(() => observeStore(hostedHubStore.getState()));

  const dispose = (): void => {
    if (installed !== dispose) return;
    installed = null;
    unsubscribeRoute();
    unsubscribeStore();
  };
  installed = dispose;
  return dispose;
}
