import type { EnvironmentId } from "@ryco/contracts";

import { nodeIdForHostedEnvironment } from "./hostedConnectionCoordinator";
import { adoptRoutedHostedNode } from "./nodeRoutes";

/**
 * Before routing to something a node created (a thread, a draft, a fork), upgrades the current
 * hosted entry to that node's scoped route so the destination resolves under it. A no-op for
 * environments that are not hosted nodes; never creates a history entry.
 */
export function adoptHostedEnvironmentRoute(environmentId: EnvironmentId): void {
  const nodeId = nodeIdForHostedEnvironment(environmentId);
  if (nodeId) adoptRoutedHostedNode(nodeId);
}
