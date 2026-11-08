import { resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
import { createEnvironmentApi } from "@ryco/client-runtime/connection";
import {
  nodeDirectoryEntries,
  selectNodeDirectoryTargets,
  startNodeDirectoryPublisher,
  type NodeDirectoryNodeFacts,
} from "@ryco/client-runtime/state/nodes";
import { AGENT_CONTROL_WS_METHODS } from "@ryco/contracts/agent-control";
import type { EnvironmentId } from "@ryco/contracts";
import type { NodePathHints } from "@ryco/contracts/project-copy";
import { isChatProject } from "@ryco/shared/projectKind";

import { getMobileHostedConnectionCoordinator } from "../../connection/hostedConnectionCoordinator";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import {
  selectEnvironmentState,
  selectProjectsAcrossEnvironments,
  selectProjectsForEnvironment,
  useStore,
} from "../../state/threadsRuntime";
import { subscribeMobileNodeConnections } from "./mobileAcquireNode";
import { readMobileNodeCatalog, subscribeMobileNodeCatalog } from "./mobileNodeCatalog";

/**
 * Publishes this phone's node directory to the machines it owns, as the
 * desktop and web do: the machines an agent there may name in a copy request
 * (`ryco_list_nodes`, `copyProjectToNode`), with each one's code directory and
 * the projects it has. The shared publisher decides what to send and when; this
 * binds it to the phone's catalog, connections, projects and path hints.
 */

const pathHints = new Map<EnvironmentId, NodePathHints>();
const pathHintReads = new Set<EnvironmentId>();
const pathHintListeners = new Set<() => void>();

function notifyPathHints(): void {
  for (const listener of Array.from(pathHintListeners)) listener();
}

function admits(environmentId: EnvironmentId): boolean {
  const connection = createMobileConnectionRegistry().driver.supervisor.read(environmentId);
  if (!connection || connection.knownEnvironment.source !== "hub-hosted") return true;
  const record = getMobileHostedConnectionCoordinator().read(environmentId);
  return resolveHostedRpcCapability({
    hosted: true,
    role: record?.effectiveRole ?? null,
    fresh:
      record?.transportStatus === "online" && record.attemptPrepared && record.sessionEstablished,
    sessionReady: record?.sessionStatus === "ready",
    method: AGENT_CONTROL_WS_METHODS.publishNodeDirectory,
  }).allowed;
}

function connectionFor(environmentId: EnvironmentId) {
  const connection = createMobileConnectionRegistry().driver.supervisor.read(environmentId);
  // An older node's API has no publish method.
  const publish = connection
    ? createEnvironmentApi(connection.client).agentControl?.publishNodeDirectory
    : undefined;
  return connection && publish ? { connection, publish } : null;
}

function readFacts(environmentId: EnvironmentId): NodeDirectoryNodeFacts {
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
  return {
    defaultProjectDirectory: pathHints.get(environmentId)?.defaultProjectDirectory ?? null,
    projects,
  };
}

/** Reads the code directory of every owned machine that has none yet (once per connection). */
function readMissingPathHints(): void {
  const snapshot = readMobileNodeCatalog();
  for (const node of snapshot.nodes) {
    const { environmentId } = node;
    if (
      node.transport === null ||
      node.projectCopySupport !== "yes" ||
      !snapshot.ownerEnvironmentIds.has(environmentId) ||
      pathHints.has(environmentId) ||
      pathHintReads.has(environmentId)
    ) {
      continue;
    }
    const connection = createMobileConnectionRegistry().driver.supervisor.read(environmentId);
    const read = connection
      ? createEnvironmentApi(connection.client).projects.pathHints
      : undefined;
    if (!read) continue;
    pathHintReads.add(environmentId);
    read({}).then(
      (hints) => {
        pathHintReads.delete(environmentId);
        pathHints.set(environmentId, hints);
        notifyPathHints();
      },
      () => {
        // Tried again on the next catalog or connection change.
        pathHintReads.delete(environmentId);
      },
    );
  }
}

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
  const onNodes = () => {
    readMissingPathHints();
    listener();
  };
  pathHintListeners.add(listener);
  const unsubscribes = [
    subscribeMobileNodeCatalog(onNodes),
    subscribeMobileNodeConnections(onNodes),
    subscribeProjects(listener),
  ];
  readMissingPathHints();
  return () => {
    pathHintListeners.delete(listener);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** Starts publishing; returns the stop. Called once by the root copy host. */
export function startMobileNodeDirectoryPublisher(): () => void {
  return startNodeDirectoryPublisher({
    readEntries: () => nodeDirectoryEntries(readMobileNodeCatalog(), readFacts),
    readTargets: () =>
      selectNodeDirectoryTargets(readMobileNodeCatalog(), { admits, connectionFor }),
    subscribe: subscribeSources,
    now: Date.now,
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
}
