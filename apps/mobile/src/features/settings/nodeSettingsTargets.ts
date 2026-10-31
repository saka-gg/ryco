import type { NodeSettingsTarget } from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts/rpc";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";

import { nodeRoleAllows } from "../../connection/nodeRoleAccess";
import type { InboxEnvironment } from "../inbox/inboxModel";

type NodeAccessRow = Pick<InboxEnvironment, "role" | "mutationReady" | "connectionState">;

/** Shown where a device whose role may not change the node's settings sees them. */
export const NODE_SETTINGS_OWNER_ONLY = "Connect as the node owner to change this.";
/** Shown where the node's owner sees them while the node is not connected and synchronized. */
export const NODE_SETTINGS_RECONNECT = "Reconnect to change this.";

/**
 * Whether the session's role may change the node's settings, by the node's own access rule for
 * `server.updateSettings` (owner only). An unknown role is not assumed to be enough.
 */
export function nodeSettingsRoleAllows(role: InboxEnvironment["role"]): boolean {
  return role !== undefined && nodeRoleAllows(role, WS_METHODS.serverUpdateSettings);
}

/** The node answers this device now: connected, with full access or as a viewer ("read-only"). */
export function nodeConnected(node: Pick<InboxEnvironment, "connectionState">): boolean {
  return node.connectionState === "connected" || node.connectionState === "read-only";
}

/**
 * Whether this device may change a node now: its role may (the node's owner), and the node is
 * connected with its writes synchronized. Every owner-only node surface on the phone gates its
 * controls on this one reading: settings, storage, updates and reset credits, whose methods all
 * need the role `server.updateSettings` needs.
 */
export function canChangeNodeSettings(node: NodeAccessRow): boolean {
  return (
    node.mutationReady === true &&
    node.connectionState === "connected" &&
    nodeSettingsRoleAllows(node.role)
  );
}

/** Why this device may not change a node's settings now, or null when it may. */
export function nodeSettingsReadOnlyReason(node: NodeAccessRow): string | null {
  if (canChangeNodeSettings(node)) return null;
  return nodeSettingsRoleAllows(node.role) ? NODE_SETTINGS_RECONNECT : NODE_SETTINGS_OWNER_ONLY;
}

/**
 * Every node "Apply to all connected nodes" tries, each with its own last
 * known config, whether it is connected and whether this device may change
 * it, and a write through its own connection. Listed once each.
 */
export function buildNodeSettingsTargets(input: {
  readonly environmentIds: Iterable<EnvironmentId>;
  readonly configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly isOwner: (environmentId: EnvironmentId) => boolean;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly write: (environmentId: EnvironmentId, patch: ServerSettingsPatch) => Promise<unknown>;
}): ReadonlyArray<NodeSettingsTarget> {
  return [...new Set(input.environmentIds)].map((environmentId) => ({
    environmentId,
    label: input.labelOf(environmentId),
    config: input.configs.get(environmentId) ?? null,
    connected: input.isConnected(environmentId),
    canWrite: input.isOwner(environmentId),
    write: (patch) => input.write(environmentId, patch),
  }));
}

/**
 * The targets of the phone's node rows: a viewer's node counts as connected, so a write to it
 * reports "only its owner can change it" rather than "not connected", and its value counts
 * when the nodes are compared.
 */
export function homeNodeSettingsTargets(input: {
  readonly nodes: ReadonlyArray<NodeAccessRow & Pick<InboxEnvironment, "environmentId" | "label">>;
  readonly configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly write: (environmentId: EnvironmentId, patch: ServerSettingsPatch) => Promise<unknown>;
}): ReadonlyArray<NodeSettingsTarget> {
  const nodes = new Map(input.nodes.map((node) => [node.environmentId, node]));
  const reading = (environmentId: EnvironmentId, read: (node: NodeAccessRow) => boolean) => {
    const node = nodes.get(environmentId);
    return node !== undefined && read(node);
  };
  return buildNodeSettingsTargets({
    environmentIds: nodes.keys(),
    configs: input.configs,
    labelOf: (environmentId) => nodes.get(environmentId)?.label ?? environmentId,
    isOwner: (environmentId) => reading(environmentId, canChangeNodeSettings),
    isConnected: (environmentId) => reading(environmentId, nodeConnected),
    write: input.write,
  });
}
