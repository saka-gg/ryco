import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";

/** The session's role on a node, as the environment rows carry it. */
export type NodeSessionRole = "viewer" | "operator" | "owner" | "client";

/**
 * Whether the session's role may call `method`, by the node's own access rule.
 * A direct pairing that is not the node's owner is a viewer to it.
 */
export function nodeRoleAllows(role: NodeSessionRole, method: string): boolean {
  return hostedRoleAllows(role === "client" ? "viewer" : role, method);
}

/**
 * Why this device cannot call `method` on a node now, or null when it can: the node's own access
 * rule for the session's role, and a connection whose writes are synchronized (`mutationReady`).
 * An unknown role is left to the node, which checks it again. `action` completes "can't …".
 */
export function nodeMethodBlockReason(
  node: {
    readonly role?: NodeSessionRole | undefined;
    readonly connectionState: string;
    readonly mutationReady?: boolean | undefined;
  },
  method: string,
  action: string,
): string | null {
  if (node.role !== undefined && !nodeRoleAllows(node.role, method)) {
    return `Your access to this machine can't ${action}.`;
  }
  if (node.connectionState !== "connected" || node.mutationReady !== true) {
    return `Reconnect the machine to ${action}.`;
  }
  return null;
}
