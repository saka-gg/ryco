/**
 * The app's one node update store, and the wiring that keeps it following
 * every connected node that can update itself. Connections stay the
 * environment runtime's: this only reads the ones it holds.
 */
import { subscribeEnvironmentServerConfigs } from "@ryco/client-runtime/rpc";
import { createNodeUpdateStore } from "@ryco/client-runtime/state/nodeUpdate";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";

import { readNodeServerConfig } from "../environments/nodeServerConfig";
import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { mayFollowNodeUpdate, subscribeNodeMethodPermissions } from "./nodeUpdatePermissions";
import { createNodeUpdateWiring } from "./nodeUpdateWiring";

export const nodeUpdateStore = createNodeUpdateStore();

/** Whether a node's config advertises `server.updateNode` and its update stream. */
export function supportsNodeSelfUpdate(config: ServerConfig | null): boolean {
  return config?.environment?.capabilities?.nodeSelfUpdate === true;
}

function canFollowNodeUpdate(environmentId: EnvironmentId): boolean {
  return (
    supportsNodeSelfUpdate(readNodeServerConfig(environmentId)) &&
    mayFollowNodeUpdate(environmentId)
  );
}

const nodeUpdateWiring = createNodeUpdateWiring(nodeUpdateStore, {
  listConnections: listEnvironmentConnections,
  canFollow: canFollowNodeUpdate,
  subscriptions: [
    subscribeEnvironmentConnections,
    subscribeEnvironmentServerConfigs,
    subscribeNodeMethodPermissions,
  ],
});

/**
 * Follows every connected node that advertises `nodeSelfUpdate` until the
 * returned stop runs. Safe to call more than once; each call needs its stop.
 */
export function startNodeUpdateWiring(): () => void {
  return nodeUpdateWiring.start();
}

/** Environments the store follows now. */
export function listNodeUpdateEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return nodeUpdateWiring.attachedEnvironmentIds();
}
