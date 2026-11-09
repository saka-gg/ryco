import {
  acquireNodeConnection,
  awaitBootstrappedNodeConnection,
  type NodeConnectionRegistry,
  NODE_ACQUIRE_TIMEOUT_MESSAGE,
  projectCopyNodeRefusal,
  type AcquiredNode,
  type NodeAcquireConnection,
  type NodeAcquirePorts,
} from "@ryco/client-runtime/state/nodes";
import {
  isSavedEnvironmentSwitchedOff,
  SavedEnvironmentSwitchedOffError,
} from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";

import { isElectron, isHostedHubMode } from "../env";
import { readEnvironmentApiForConnection } from "../environmentApi";
import { hostedNodeAcquisition } from "../hostedHub/hostedConnectionCoordinator";
import { randomUUID } from "../lib/utils";
import {
  readDesktopWorkspaceState,
  retainDesktopWorkspaceInteractiveScope,
  retainDesktopWorkspaceProjectCopyScope,
} from "../platform/desktopWorkspace";
import { readNodeCatalogSnapshot } from "./nodeCatalog";
import { readPrimaryEnvironmentDescriptor } from "./primary";
import {
  connectPrimaryEnvironment,
  getSavedEnvironmentRecord,
  readEnvironmentConnection,
  reconnectSavedEnvironment,
  subscribeEnvironmentConnections,
} from "./runtime";

export type { AcquiredNode } from "@ryco/client-runtime/state/nodes";

/**
 * Why a copy holds a node. `copy` retains the non-preemptible `project-copy`
 * scope and, through the Hub, waits for the mutation lease. `follow` watches
 * an import that runs on the node by itself: a view's (preemptible) scope,
 * and the lease only where this client is the node's owner (cancelling the
 * import is a write).
 */
export type AcquireNodePurpose = "copy" | "follow";

/**
 * Acquiring a node for a cross-node project copy, on this client: the shared
 * policy (`acquireNodeConnection`: a non-preemptible `project-copy` scope,
 * renewal, the 30 s budget, generation and lease checks) over the connection
 * paths this client has. Hosted mode retains the scope in the hosted
 * coordinator and waits for the node's mutation lease; Desktop retains it in
 * main for a Hub machine; a saved environment is reconnected when it has no
 * connection; the primary is connected directly. Loaded on demand by the copy
 * flows, never by the app shell.
 */

const NO_HOLD = { release: () => undefined } as const;

const WEB_CONNECTIONS: NodeConnectionRegistry<
  NonNullable<ReturnType<typeof readEnvironmentConnection>>
> = {
  read: readEnvironmentConnection,
  subscribe: subscribeEnvironmentConnections,
  apiOf: (environmentId, connection) =>
    readEnvironmentApiForConnection(environmentId, connection.client),
};

/** The node's registered connection once it is bootstrapped (see `awaitBootstrappedNodeConnection`). */
function awaitBootstrappedConnection(
  environmentId: EnvironmentId,
  signal: AbortSignal,
): Promise<NodeAcquireConnection> {
  return awaitBootstrappedNodeConnection(WEB_CONNECTIONS, environmentId, signal);
}

function timeoutMessageFor(environmentId: EnvironmentId): () => string {
  return () => {
    const node = readNodeCatalogSnapshot().nodes.find(
      (entry) => entry.environmentId === environmentId,
    );
    return node?.presence === "offline" ? `${node.label} is offline` : NODE_ACQUIRE_TIMEOUT_MESSAGE;
  };
}

/** A saved machine the user switched off: it never connects until switched on again. */
function switchedOffReason(label: string): string {
  return `${label} is switched off`;
}

function directPorts(
  environmentId: EnvironmentId,
  label: string,
  purpose: AcquireNodePurpose,
): NodeAcquirePorts {
  const timeoutMessage = timeoutMessageFor(environmentId);
  if (environmentId === readPrimaryEnvironmentDescriptor()?.environmentId) {
    return {
      transport: "direct",
      retain: () => NO_HOLD,
      connect: (signal) => {
        connectPrimaryEnvironment();
        return awaitBootstrappedConnection(environmentId, signal);
      },
      timeoutMessage,
    };
  }
  if (getSavedEnvironmentRecord(environmentId)) {
    return {
      transport: "direct",
      // A saved connection persists on its own; nothing evicts it.
      retain: () => NO_HOLD,
      connect: async (signal) => {
        // Waking a saved environment that has no connection surfaces its
        // failure (a refused credential) instead of waiting it out.
        if (!readEnvironmentConnection(environmentId)) {
          await reconnectSavedEnvironment(environmentId).catch((error: unknown) => {
            // Switched off meanwhile: say so, not which id refused.
            if (error instanceof SavedEnvironmentSwitchedOffError) {
              throw new Error(switchedOffReason(label), { cause: error });
            }
            throw error;
          });
        }
        return awaitBootstrappedConnection(environmentId, signal);
      },
      timeoutMessage,
    };
  }
  if (
    isElectron &&
    readDesktopWorkspaceState().machines.some((machine) => machine.environmentId === environmentId)
  ) {
    return {
      transport: "relay",
      retain: (scope) => ({
        release:
          purpose === "follow"
            ? retainDesktopWorkspaceInteractiveScope(environmentId)
            : retainDesktopWorkspaceProjectCopyScope(environmentId, scope.copyId),
      }),
      connect: (signal) => awaitBootstrappedConnection(environmentId, signal),
      timeoutMessage,
    };
  }
  throw new Error("This device is not connected to Ryco here.");
}

/**
 * Holds `environmentId` for the copy `copyId` (a fresh id by default) and
 * resolves once calls can be made there, or fails within 30 s. The caller
 * releases the handle when the copy is done with the node; calls that change
 * it go through `withLease`, which fails with `NodeLeaseLostError` after a
 * reconnect so the copy can pause, acquire again and resume.
 */
export async function acquireNode(
  environmentId: EnvironmentId,
  options?: {
    readonly copyId?: string;
    readonly signal?: AbortSignal;
    /** `copy` by default. */
    readonly purpose?: AcquireNodePurpose;
  },
): Promise<AcquiredNode> {
  const purpose = options?.purpose ?? "copy";
  // The catalog leaves switched-off machines out; name the reason instead.
  const saved = getSavedEnvironmentRecord(environmentId);
  if (saved && isSavedEnvironmentSwitchedOff(saved))
    throw new Error(switchedOffReason(saved.label));
  const catalog = readNodeCatalogSnapshot();
  const node = catalog.nodes.find((entry) => entry.environmentId === environmentId);
  // An id this client does not know is refused, never guessed at.
  if (!node) throw new Error("This device is not one Ryco knows here.");
  const owner = catalog.ownerEnvironmentIds.has(environmentId);
  // Following only reads; the refusal guards the copy's writes.
  if (purpose === "copy") {
    const refusal = projectCopyNodeRefusal(node, { hosted: isHostedHubMode(), owner });
    if (refusal !== null) throw new Error(refusal);
  }
  let ports: NodeAcquirePorts;
  if (isHostedHubMode()) {
    const hosted = hostedNodeAcquisition(environmentId, purpose);
    ports = {
      transport: "relay",
      retain: hosted.retain,
      ...(hosted.awaitMutationLease && (purpose === "copy" || owner)
        ? { awaitMutationLease: hosted.awaitMutationLease }
        : {}),
      connect: (signal) => awaitBootstrappedConnection(environmentId, signal),
      timeoutMessage: timeoutMessageFor(environmentId),
    };
  } else {
    ports = directPorts(environmentId, node.label, purpose);
  }
  return acquireNodeConnection({
    environmentId,
    copyId: options?.copyId ?? randomUUID(),
    label: node.label,
    ports,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}
