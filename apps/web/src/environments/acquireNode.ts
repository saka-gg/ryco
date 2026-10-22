import {
  acquireNodeConnection,
  NODE_ACQUIRE_TIMEOUT_MESSAGE,
  type AcquiredNode,
  type NodeAcquireConnection,
  type NodeAcquirePorts,
} from "@ryco/client-runtime/state/nodes";
import type { EnvironmentId } from "@ryco/contracts";

import { isElectron, isHostedHubMode } from "../env";
import { readEnvironmentApiForConnection } from "../environmentApi";
import { hostedNodeAcquisition } from "../hostedHub/hostedConnectionCoordinator";
import { randomUUID } from "../lib/utils";
import {
  readDesktopWorkspaceState,
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
/** How long a failed bootstrap is left before it is asked again, unless the connection changes first. */
const BOOTSTRAP_RETRY_MS = 1_000;

/**
 * Resolves on the next change to the registered connections, after `maxWaitMs`
 * when given, or when `signal` aborts.
 */
function nextConnectionChange(signal: AbortSignal, maxWaitMs?: number): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: () => void = () => undefined;
    const done = () => {
      unsubscribe();
      signal.removeEventListener("abort", done);
      if (timer !== null) globalThis.clearTimeout(timer);
      resolve();
    };
    unsubscribe = subscribeEnvironmentConnections(done);
    signal.addEventListener("abort", done, { once: true });
    if (maxWaitMs !== undefined) timer = globalThis.setTimeout(done, maxWaitMs);
  });
}

/**
 * The node's registered connection once it is bootstrapped. A connection
 * replaced while it bootstraps is never handed out, and one whose bootstrap
 * fails is asked again: its lifecycle owner reconnects it or registers a new
 * one, within the acquisition's budget.
 */
async function awaitBootstrappedConnection(
  environmentId: EnvironmentId,
  signal: AbortSignal,
): Promise<NodeAcquireConnection> {
  while (!signal.aborted) {
    const connection = readEnvironmentConnection(environmentId);
    if (!connection) {
      await nextConnectionChange(signal);
      continue;
    }
    const bootstrapped = await connection.ensureBootstrapped().then(
      () => true,
      () => false,
    );
    if (readEnvironmentConnection(environmentId) !== connection) continue;
    if (!bootstrapped) {
      await nextConnectionChange(signal, BOOTSTRAP_RETRY_MS);
      continue;
    }
    const api = readEnvironmentApiForConnection(environmentId, connection.client);
    if (!api) throw new Error("The device's connection has no API.");
    return { api, isCurrent: () => readEnvironmentConnection(environmentId) === connection };
  }
  throw new Error("Stopped waiting for the device to connect.");
}

function timeoutMessageFor(environmentId: EnvironmentId): () => string {
  return () => {
    const node = readNodeCatalogSnapshot().nodes.find(
      (entry) => entry.environmentId === environmentId,
    );
    return node?.presence === "offline" ? `${node.label} is offline` : NODE_ACQUIRE_TIMEOUT_MESSAGE;
  };
}

function directPorts(environmentId: EnvironmentId): NodeAcquirePorts {
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
        if (!readEnvironmentConnection(environmentId))
          await reconnectSavedEnvironment(environmentId);
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
        release: retainDesktopWorkspaceProjectCopyScope(environmentId, scope.copyId),
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
  options?: { readonly copyId?: string; readonly signal?: AbortSignal },
): Promise<AcquiredNode> {
  const catalog = readNodeCatalogSnapshot();
  const node = catalog.nodes.find((entry) => entry.environmentId === environmentId);
  // An id this client does not know is refused, never guessed at.
  if (!node) throw new Error("This device is not one Ryco knows here.");
  // A reachable node that refuses changes stays refused once connected; an
  // offline or connecting one is worth connecting to find out.
  if (!node.canMutate && node.presence === "online") {
    throw new Error(node.mutateBlockedReason ?? `${node.label} is not available right now`);
  }
  // Through the Hub, writes need the node's mutation lease, which only an owner gets.
  if (isHostedHubMode() && !catalog.ownerEnvironmentIds.has(environmentId)) {
    throw new Error(`Copying projects with ${node.label} needs owner access to it`);
  }
  const ports: NodeAcquirePorts = isHostedHubMode()
    ? {
        transport: "relay",
        ...hostedNodeAcquisition(environmentId),
        connect: (signal) => awaitBootstrappedConnection(environmentId, signal),
        timeoutMessage: timeoutMessageFor(environmentId),
      }
    : directPorts(environmentId);
  return acquireNodeConnection({
    environmentId,
    copyId: options?.copyId ?? randomUUID(),
    label: node.label,
    ports,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}
