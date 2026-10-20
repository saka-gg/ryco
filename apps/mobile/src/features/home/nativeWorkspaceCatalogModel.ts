import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import {
  hostedNodeCatalogInput,
  reconcileWorkspaceMachineCatalog,
  type WorkspaceMachineCatalogEntry,
  type WorkspaceNativeTrustState,
} from "@ryco/client-runtime/state/workspace";
import type { EnvironmentId } from "@ryco/contracts";

import type { CachedHubNodeRecord } from "../../hostedHub/nodeRoster";
import type { MobileHostedConnectionState } from "../../connection/hostedConnectionCoordinator";

/**
 * A cached roster record as the directory node the shared catalog input reads.
 * The roster persists what a machine row shows, not what the machine reports
 * about itself, so those fields stay neutral and capabilities stay absent.
 */
function rosterDirectoryNode(node: CachedHubNodeRecord): HostedHubNode {
  return {
    id: node.nodeId,
    environmentId: node.environmentId,
    label: node.label,
    platformOs: "unknown",
    platformArch: "other",
    clientVersion: "",
    createdAt: node.observedAt,
    updatedAt: node.observedAt,
    lastAuthenticatedAt: node.lastAuthenticatedAt,
    revokedAt: node.revokedAt,
    revocationReasonCode: null,
    grant: { id: node.nodeId, role: node.effectiveRole },
    effectiveRole: node.effectiveRole,
    presence: { online: node.presenceOnline, lastHeartbeatAt: node.lastHeartbeatAt },
  };
}

/** Mobile adapter into the shared machine-catalog policy. */
export function buildMobileNativeWorkspaceCatalog(input: {
  readonly nodes: ReadonlyArray<CachedHubNodeRecord>;
  readonly connections: ReadonlyArray<MobileHostedConnectionState>;
  readonly trustByEnvironmentId: ReadonlyMap<string, WorkspaceNativeTrustState>;
  readonly deliveryUnknownEnvironmentIds?: ReadonlyArray<EnvironmentId>;
}): ReadonlyArray<WorkspaceMachineCatalogEntry> {
  const connections = new Map(
    input.connections.map((connection) => [connection.environmentId, connection] as const),
  );
  const deliveryUnknown = new Set(input.deliveryUnknownEnvironmentIds ?? []);
  return reconcileWorkspaceMachineCatalog(
    input.nodes.map((node) => {
      const connection = connections.get(node.environmentId);
      return {
        ...hostedNodeCatalogInput(rosterDirectoryNode(node), {
          clientTier: "native",
          nativeTrust: input.trustByEnvironmentId.get(node.environmentId) ?? "unknown",
          requiresNativeVerification: true,
          session: connection ?? null,
          deliveryUnknown:
            connection?.sessionStatus === "delivery-unknown" ||
            deliveryUnknown.has(node.environmentId),
          observedAt: node.observedAt,
        }),
        // The roster does not record the machine's server version.
        serverVersion: null,
      };
    }),
  );
}
