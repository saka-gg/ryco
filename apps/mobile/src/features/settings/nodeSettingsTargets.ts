import type { NodeSettingsTarget } from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";

import type { InboxEnvironment } from "../inbox/inboxModel";

/**
 * Whether this device may change a node's settings now: it is the node's owner, and the node is
 * connected with its writes synchronized. Every per-node settings panel gates its controls on
 * this one reading.
 */
export function canChangeNodeSettings(
  node: Pick<InboxEnvironment, "role" | "mutationReady" | "connectionState">,
): boolean {
  return (
    node.mutationReady === true && node.role === "owner" && node.connectionState === "connected"
  );
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
