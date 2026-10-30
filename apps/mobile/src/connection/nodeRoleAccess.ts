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
