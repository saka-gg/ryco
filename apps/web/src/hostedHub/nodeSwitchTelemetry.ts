import {
  markNodeSwitchIntent,
  markNodeSwitchPhase,
  setNodeSwitchContext,
  type NodeSwitchOrigin,
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
 * switch through `nodeSwitchInstrumentation`. A switch is a move of the
 * selection cursor: a thread routed on another node, or a node chosen on a page
 * that names none (the node directory, Settings). It only reads: it never selects,
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

  // The node the selection cursor was last seen moving to: by a routed thread,
  // or by a choice on a page that names no node. A routed node other than it
  // is a switch; one on the same node is not.
  let cursorNodeId = getRoutedHostedNode().nodeId;
  // A routed node the directory does not list yet; its switch starts when the
  // directory lists it, measured from then.
  let pendingNodeId: string | null = null;
  const initial = hostedHubStore.getState();
  let lastSelectedNodeId = initial.selectedNode?.id ?? null;
  let lastTransportStatus = initial.transportStatus;
  let lastSessionEstablished = initial.sessionEstablished;

  const beginSwitch = (
    state: HostedHubState,
    environmentId: string,
    origin: NodeSwitchOrigin,
  ): void => {
    markNodeSwitchIntent(environmentId, origin);
    if (origin === "route") markNodeSwitchPhase("route", environmentId);
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
        beginSwitch(state, pendingEnvironmentId, "route");
      }
    }
    const selectedNode = state.selectedNode;
    const selectedNodeId = selectedNode?.id ?? null;
    if (selectedNodeId !== lastSelectedNodeId) {
      lastSelectedNodeId = selectedNodeId;
      // With no node routed, the cursor moved on a page that names none: a
      // choice there is a switch of its own, and a thread on the node it
      // left is a switch again.
      if (getRoutedHostedNode().nodeId === null && selectedNodeId !== cursorNodeId) {
        cursorNodeId = selectedNodeId;
        if (selectedNode) beginSwitch(state, selectedNode.environmentId, "press");
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
    if (nodeId === null) {
      // A page no node owns moves no cursor, so a thread on the same node
      // opened after it is no switch. A switch that never began is dropped.
      if (pendingNodeId !== null) cursorNodeId = null;
      pendingNodeId = null;
      return;
    }
    if (nodeId === cursorNodeId) return;
    cursorNodeId = nodeId;
    pendingNodeId = null;
    const state = hostedHubStore.getState();
    const environmentId = environmentIdForNode(state, nodeId);
    if (environmentId === null) {
      pendingNodeId = nodeId;
      return;
    }
    beginSwitch(state, environmentId, "route");
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
