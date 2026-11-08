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
import { readMobileNodeCatalog } from "./mobileNodeCatalog";

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
 * The phone's Hub sessions carry no separate mutation lease: like every other
 * write the phone makes, a copy writes only to a node the catalog says it may
 * change (an owner session), and the node checks each call again.
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
