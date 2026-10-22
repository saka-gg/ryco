import {
  nodeDirectoryEntries,
  selectNodeDirectoryTargets,
  startNodeDirectoryPublisher as startPublisher,
} from "@ryco/client-runtime/state/nodes";
import { AGENT_CONTROL_WS_METHODS } from "@ryco/contracts/agent-control";
import type { EnvironmentId } from "@ryco/contracts";

import { isHostedHubMode } from "../env";
import { readEnvironmentApiForConnection } from "../environmentApi";
import { readHostedRpcCapability, subscribeHostedRpcCapabilities } from "../hostedHub/capabilities";
import { readNodeCatalogSnapshot, subscribeNodeCatalog } from "./nodeCatalog";
import { readEnvironmentConnection, subscribeEnvironmentConnections } from "./runtime";

/**
 * Publishes this client's owner-held nodes to Agent Control's node directory
 * on every connected node that supports project copy, so an agent there can
 * name a copy target. Loaded on demand (`useNodeDirectoryPublisher`), never
 * by the app shell: the policy is the shared publisher's, this module only
 * says which connections exist and which hosted sessions admit the call.
 */

/** A hosted session must admit the call now; a direct owner session always does. */
function admits(environmentId: EnvironmentId): boolean {
  return (
    !isHostedHubMode() ||
    readHostedRpcCapability(AGENT_CONTROL_WS_METHODS.publishNodeDirectory, environmentId).allowed
  );
}

function connectionFor(environmentId: EnvironmentId) {
  const connection = readEnvironmentConnection(environmentId);
  // An older client build's API has no publish method.
  const publish = connection
    ? readEnvironmentApiForConnection(environmentId, connection.client)?.agentControl
        ?.publishNodeDirectory
    : undefined;
  return connection && publish ? { connection, publish } : null;
}

function subscribeSources(listener: () => void): () => void {
  const unsubscribes = [
    subscribeNodeCatalog(listener),
    subscribeEnvironmentConnections(listener),
    subscribeHostedRpcCapabilities(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** Starts publishing; returns the stop. */
export function startNodeDirectoryPublisher(): () => void {
  return startPublisher({
    readEntries: () => nodeDirectoryEntries(readNodeCatalogSnapshot()),
    readTargets: () =>
      selectNodeDirectoryTargets(readNodeCatalogSnapshot(), { admits, connectionFor }),
    subscribe: subscribeSources,
    now: Date.now,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
}
