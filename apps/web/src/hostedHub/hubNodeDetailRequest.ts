import { navigateHub } from "./hubRoutes";

/**
 * A node whose details the Hub's node list opens next (a device's Access tab in settings links
 * to its Hub page). Kept in memory, never in the address: hosted addresses name no node.
 */
let pendingNodeId: string | null = null;

/** Opens the Hub's node list with this node's details shown. */
export function openHubNodeDetail(nodeId: string): void {
  pendingNodeId = nodeId;
  navigateHub({ kind: "nodes" });
}

/** The node the list should open, read without taking it (render may run twice). */
export function peekHubNodeDetailRequest(): string | null {
  return pendingNodeId;
}

export function clearHubNodeDetailRequest(): void {
  pendingNodeId = null;
}
