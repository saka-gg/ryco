import {
  createHostedMutationLeases,
  getHostedEnvironmentSessions,
  hostedCatalogAllowsMutation,
  hostedHubStore,
  hostedSessionMutationReadiness,
} from "@ryco/client-runtime/authorization";
import {
  createEnvironmentApi,
  isSavedEnvironmentSwitchedOff,
} from "@ryco/client-runtime/connection";
import type { ProjectCopyNodeAcquire } from "@ryco/client-runtime/projectCopy/nodeIo";
import {
  acquireNodeConnection,
  awaitBootstrappedNodeConnection,
  NODE_ACQUIRE_TIMEOUT_MESSAGE,
  projectCopyNodeRefusal,
  type AcquiredNode,
  type NodeAcquirePorts,
  type NodeConnectionRegistry,
} from "@ryco/client-runtime/state/nodes";
import type { EnvironmentConnection } from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";

import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { getCachedHubNodeRoster } from "../../hostedHub/nodeRoster";
import { uuidv4 } from "../../lib/uuid";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import { subscribeHubLeaseInputs } from "./hubLeaseInputs";
import {
  readMobileHostedMachines,
  readMobileNodeCatalog,
  subscribeMobileHostedMachines,
} from "./mobileNodeCatalog";

/**
 * Acquiring a node for a cross-node project copy on the phone: the shared
 * policy (`acquireNodeConnection`: the 30 s budget, renewal, generation
 * checks) over the phone's connections. A directly paired machine is woken
 * when it has no connection; a Hub machine is held with a `project-copy`
 * scope the Hub coordinator turns into a connection it never displaces
 * (`project-copy-follow` for following an import, which it may). Every call
 * then goes through the connection acquired: a replaced connection fails the
 * call before it is sent, and the copy acquires again and resumes.
 *
 * A Hub machine also waits for its session's mutation lease, by the hosted
 * web's rule: an owner session whose directory is current, whose relay is
 * online, whose node is listed, connectable and not revoked, and whose shell
 * snapshot the phone holds. Every call revalidates it; a renewed, downgraded
 * or interrupted session fails the call and the copy acquires again.
 */

const NO_HOLD = { release: () => undefined } as const;

type MobileRegistry = ReturnType<typeof createMobileConnectionRegistry>;
let cachedRegistry: MobileRegistry | null = null;
function registry(): MobileRegistry {
  return (cachedRegistry ??= createMobileConnectionRegistry());
}

const CONNECTIONS: NodeConnectionRegistry<EnvironmentConnection> = {
  read: (environmentId) => registry().driver.supervisor.read(environmentId),
  subscribe: (listener) => registry().driver.supervisor.subscribe(listener),
  apiOf: (_environmentId, connection) => createEnvironmentApi(connection.client),
};

/** Each Hub session's shell snapshot held by the phone: its connection, while it is a Hub one. */
function hubShellHeld(environmentId: EnvironmentId): boolean {
  const connection = CONNECTIONS.read(environmentId);
  return (
    connection?.knownEnvironment.source === "hub-hosted" &&
    connection.shellSnapshotReadiness.read() !== null
  );
}

/**
 * Each Hub session's mutation lease, by the hosted web's own rule
 * (`hostedSessionMutationReadiness` for a native client): granted only while
 * the published Hub machines show it connected and open to changes.
 */
const HOSTED_MUTATION_LEASES = createHostedMutationLeases({
  readAll: () => {
    const hub = hostedHubStore.getState();
    const machines = readMobileHostedMachines();
    return getHostedEnvironmentSessions()
      .list()
      .map((record) => {
        const current = hostedSessionMutationReadiness({
          hub,
          record,
          client: "native",
          shellHeld: hubShellHeld(record.environmentId),
        });
        return {
          environmentId: record.environmentId,
          snapshotGeneration: record.generation,
          effectiveRole: record.effectiveRole,
          directoryReady: current.directoryReady,
          relayReady: current.relayReady,
          shellReady:
            current.shellReady && hostedCatalogAllowsMutation(machines, record.environmentId),
        };
      });
  },
  subscribe: (listener) =>
    subscribeHubLeaseInputs(
      {
        environmentIds: () =>
          getHostedEnvironmentSessions()
            .list()
            .map((record) => record.environmentId),
        readConnection: (environmentId) => CONNECTIONS.read(environmentId),
        sources: [
          (onChange) => getHostedEnvironmentSessions().subscribe(onChange),
          (onChange) => {
            const unsubscribe = hostedHubStore.subscribe(onChange);
            return () => {
              unsubscribe();
            };
          },
          (onChange) => CONNECTIONS.subscribe(onChange),
          subscribeMobileHostedMachines,
        ],
      },
      listener,
    ),
});

/** Calls `listener` whenever a node's connection is registered, replaced or removed. */
export function subscribeMobileNodeConnections(listener: () => void): () => void {
  return CONNECTIONS.subscribe(listener);
}

function timeoutMessageFor(environmentId: EnvironmentId): () => string {
  return () => {
    const node = readMobileNodeCatalog().nodes.find(
      (entry) => entry.environmentId === environmentId,
    );
    return node?.presence === "offline" ? `${node.label} is offline` : NODE_ACQUIRE_TIMEOUT_MESSAGE;
  };
}

/**
 * A saved machine's connection once it is bootstrapped. The supervisor keeps
 * every saved machine that is switched on connected (and reconnects it), so
 * waiting is all a copy does here.
 */
function connectSaved(environmentId: EnvironmentId) {
  return (signal: AbortSignal) =>
    awaitBootstrappedNodeConnection(CONNECTIONS, environmentId, signal);
}

export type MobileAcquirePurpose = "copy" | "follow";

/**
 * Holds `environmentId` for the copy `copyId` and resolves once calls can be
 * made there, or fails within 30 s. Release the handle when the copy is done
 * with the node.
 */
export async function acquireMobileNode(
  environmentId: EnvironmentId,
  options?: {
    readonly copyId?: string;
    readonly signal?: AbortSignal;
    /** `copy` by default. */
    readonly purpose?: MobileAcquirePurpose;
  },
): Promise<AcquiredNode> {
  const purpose = options?.purpose ?? "copy";
  const record = registry().catalog.get(environmentId);
  if (record && isSavedEnvironmentSwitchedOff(record)) {
    throw new Error(`${record.label} is switched off`);
  }
  const catalog = readMobileNodeCatalog();
  const node = catalog.nodes.find((entry) => entry.environmentId === environmentId);
  // An id this phone does not know is refused, never guessed at.
  if (!node) throw new Error("This machine is not one Ryco knows here.");
  const owner = catalog.ownerEnvironmentIds.has(environmentId);
  const hostedNode = record
    ? undefined
    : getCachedHubNodeRoster().find((entry) => entry.environmentId === environmentId);
  if (purpose === "copy") {
    const refusal = projectCopyNodeRefusal(node, { hosted: hostedNode !== undefined, owner });
    if (refusal !== null) throw new Error(refusal);
  }
  let ports: NodeAcquirePorts;
  if (record) {
    ports = {
      transport: "direct",
      // A saved connection persists on its own; nothing evicts it.
      retain: () => NO_HOLD,
      connect: connectSaved(environmentId),
      timeoutMessage: timeoutMessageFor(environmentId),
    };
  } else if (hostedNode) {
    ports = {
      transport: "relay",
      retain: (scope) => ({
        release: mobileHostedConnectionScopes.retain(environmentId, {
          type: purpose === "follow" ? "project-copy-follow" : "project-copy",
          copyId: scope.copyId,
        }),
      }),
      // Following an import reads only; a copy and an owner's follow wait for the lease.
      ...(purpose === "copy" || owner
        ? {
            awaitMutationLease: (signal: AbortSignal) =>
              HOSTED_MUTATION_LEASES.await(environmentId, signal),
          }
        : {}),
      connect: (signal) => awaitBootstrappedNodeConnection(CONNECTIONS, environmentId, signal),
      timeoutMessage: timeoutMessageFor(environmentId),
    };
  } else {
    throw new Error("This machine is not connected to Ryco here.");
  }
  return acquireNodeConnection({
    environmentId,
    copyId: options?.copyId ?? uuidv4(),
    label: node.label,
    ports,
    ...(options?.signal ? { signal: options.signal } : {}),
  });
}

/** `acquireMobileNode` as the shared node IO calls it. */
export const mobileProjectCopyAcquire: ProjectCopyNodeAcquire = (environmentId, options) =>
  acquireMobileNode(environmentId, options);
