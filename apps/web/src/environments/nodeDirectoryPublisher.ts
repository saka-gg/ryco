import {
  nodeDirectoryEntries,
  selectNodeDirectoryTargets,
  startNodeDirectoryPublisher as startPublisher,
  type NodeDirectoryNodeFacts,
} from "@ryco/client-runtime/state/nodes";
import { AGENT_CONTROL_WS_METHODS } from "@ryco/contracts/agent-control";
import type { EnvironmentId } from "@ryco/contracts";
import type { NodePathHints } from "@ryco/contracts/project-copy";
import { isChatProject } from "@ryco/shared/projectKind";

import {
  nodePathHintsQueryKey,
  prefetchNodePathHints,
} from "../components/projectNodes/nodePathQueries";
import { isHostedHubMode } from "../env";
import { readEnvironmentApiForConnection } from "../environmentApi";
import { readHostedRpcCapability, subscribeHostedRpcCapabilities } from "../hostedHub/capabilities";
import { defaultQueryClient } from "../rpc/queryClient";
import {
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectProjectsForEnvironment,
  useStore,
} from "../store";
import { readNodeCatalogSnapshot, subscribeNodeCatalog } from "./nodeCatalog";
import { readEnvironmentConnection, subscribeEnvironmentConnections } from "./runtime";

/**
 * Publishes this client's owner-held nodes to Agent Control's node directory
 * on every connected node that supports project copy, so an agent there can
 * name a copy target. Loaded on demand (`useNodeDirectoryPublisher`), never
 * by the app shell: the policy is the shared publisher's, this module only
 * says which connections exist, which hosted sessions admit the call, and
 * what this client knows of each node (its code directory from the path hints
 * the project pickers share, its projects from the store).
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

/** The node's code directory and its repository projects, as far as this client knows them. */
export function readNodeDirectoryFacts(environmentId: EnvironmentId): NodeDirectoryNodeFacts {
  const hints = defaultQueryClient.getQueryData<NodePathHints>(
    nodePathHintsQueryKey(environmentId),
  );
  const state = useStore.getState();
  // Projects are known once the node's shell snapshot arrived (live or cached).
  const projects = selectEnvironmentState(state, environmentId).bootstrapComplete
    ? selectProjectsForEnvironment(state, environmentId).flatMap((project) => {
        const key = project.repositoryIdentity?.canonicalKey;
        return isChatProject(project) || !key
          ? []
          : [{ repositoryCanonicalKey: key, path: project.cwd }];
      })
    : null;
  return { defaultProjectDirectory: hints?.defaultProjectDirectory ?? null, projects };
}

/**
 * Reads the path hints of every connected owner-held node that copies projects and has none
 * cached yet (one small read per node, shared with the pickers), and calls `listener` when a
 * node's hints change. Returns the stop.
 */
function followNodePathHints(listener: () => void): () => void {
  const followed = new Map<EnvironmentId, () => void>();
  const sync = () => {
    const snapshot = readNodeCatalogSnapshot();
    for (const node of snapshot.nodes) {
      const { environmentId } = node;
      if (
        node.transport === null ||
        node.projectCopySupport !== "yes" ||
        !snapshot.ownerEnvironmentIds.has(environmentId)
      ) {
        continue;
      }
      if (!followed.has(environmentId)) {
        followed.set(
          environmentId,
          defaultQueryClient.subscribe(nodePathHintsQueryKey(environmentId), listener),
        );
      }
      if (defaultQueryClient.getQueryData(nodePathHintsQueryKey(environmentId)) === undefined) {
        // A failed read is tried again on the next catalog change.
        void prefetchNodePathHints(environmentId).catch(() => undefined);
      }
    }
  };
  const unsubscribe = subscribeNodeCatalog(sync);
  sync();
  return () => {
    unsubscribe();
    for (const stop of followed.values()) stop();
    followed.clear();
  };
}

/** Calls `listener` only when the store's projects change, not on every store update. */
function subscribeProjects(listener: () => void): () => void {
  let projects = selectProjectsAcrossEnvironments(useStore.getState());
  return useStore.subscribe((state) => {
    const next = selectProjectsAcrossEnvironments(state);
    if (next === projects) return;
    projects = next;
    listener();
  });
}

function subscribeSources(listener: () => void): () => void {
  const unsubscribes = [
    subscribeNodeCatalog(listener),
    subscribeEnvironmentConnections(listener),
    subscribeHostedRpcCapabilities(listener),
    subscribeProjects(listener),
    followNodePathHints(listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** Starts publishing; returns the stop. */
export function startNodeDirectoryPublisher(): () => void {
  return startPublisher({
    readEntries: () => nodeDirectoryEntries(readNodeCatalogSnapshot(), readNodeDirectoryFacts),
    readTargets: () =>
      selectNodeDirectoryTargets(readNodeCatalogSnapshot(), { admits, connectionFor }),
    subscribe: subscribeSources,
    now: Date.now,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
}
